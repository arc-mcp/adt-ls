/**
 * AdtLsDriver — spawn `adt-ls` headless and speak LSP over a pipe, exactly as the
 * `sapse.adt-vscode` extension does: args `-Djco.trace_path <dir> -data <dir>
 * --pipe=<pipe>`; the client (this process) listens on the pipe and adt-ls connects.
 *
 * Cross-platform via a `net.Server` on a SHORT pipe name (Windows named pipe / unix
 * socket) + vscode-jsonrpc stream framing. We own the server + socket so teardown is
 * clean (no dangling stream errors). See ADR-0005 for why we avoid
 * `generateRandomPipeName` (its long path overflows the macOS unix-socket limit).
 *
 * This is the engine: the library performs NO ADT HTTP/CSRF/locking/XML itself —
 * everything goes through adt-ls via this driver (LSP) or its MCP endpoint.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { promises as fsp } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node.js';
import { logger } from './log.js';
import { VERIFIED_ADT_LS_VERSION, assertSupportedAdtLsVersion } from './version.js';

/**
 * A SHORT, cross-platform pipe name. We deliberately do NOT use vscode-jsonrpc's
 * `generateRandomPipeName` — its 42-char random combined with the long macOS system
 * tmpdir yields a ~103-char path that hits the unix-socket `sun_path` limit (104),
 * so adt-lsc fails to connect. A short id keeps us well under it. (ADR-0005.)
 */
function makePipeName(): string {
  const id = crypto.randomBytes(6).toString('hex');
  return process.platform === 'win32' ? `\\\\.\\pipe\\adt-ls-${id}` : path.join(os.tmpdir(), `adt-ls-${id}.sock`);
}

export interface AdtLsInitializeResult {
  serverInfo?: { name: string; version: string };
  capabilities: Record<string, unknown>;
}

/** Handler for a server→client LSP request (e.g. requestBrowserBasedLogon). */
export type ServerRequestHandler = (params: unknown) => unknown | Promise<unknown>;

/**
 * The LSP request channel alone. Consumers that only send requests (repository
 * queries, the authoring lifecycle) depend on this minimal surface, so a
 * session-retry wrapper — or a test fake — can stand in for the full driver.
 */
export interface LspRequester {
  sendRequest<T = unknown>(method: string, params?: unknown): Promise<T>;
}

/**
 * Request + notification channel. LSP document features (didOpen → query →
 * didClose) need fire-and-forget notifications, so the navigation layer depends
 * on this fuller surface.
 */
export interface LspClient extends LspRequester {
  sendNotification(method: string, params?: unknown): Promise<void>;
}

/**
 * Route a server→client request to a registered handler, with safe defaults. Pure
 * (no I/O) so it can be unit-tested directly.
 * - a registered handler wins (e.g. `adtLs/destinations/requestBrowserBasedLogon`)
 * - `workspace/configuration` MUST return an array of nulls, one per item ("use
 *   defaults") — a bare null errors adt-ls's destination init.
 * - everything else (client/registerCapability, window/workDoneProgress/create…) → null.
 */
export function routeServerRequest(
  method: string,
  params: unknown,
  handlers: Record<string, ServerRequestHandler>,
): unknown | Promise<unknown> {
  const handler = handlers[method];
  if (handler) return handler(params);
  if (method === 'workspace/configuration') {
    const items = (params as { items?: unknown[] } | undefined)?.items ?? [];
    return items.map(() => null);
  }
  return null;
}

/**
 * Build adt-ls's spawn argv. `extraArgs` (e.g. SNC/JCo JVM flags like
 * `-Djco.middleware.snc_lib=…`, or `-consoleLog`) are prepended ahead of adt-ls's own
 * `-data`/`--pipe`, where JVM launchers expect leading flags. Pure (no I/O).
 */
export function composeSpawnArgs(opts: { dataDir: string; pipeName: string; extraArgs?: string[] }): string[] {
  return [
    ...(opts.extraArgs ?? []),
    '-Djco.trace_path',
    opts.dataDir,
    '-data',
    opts.dataDir,
    `--pipe=${opts.pipeName}`,
  ];
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export interface AdtLsDriverOptions {
  /** Working/data dir for adt-ls (`-data`). Caller-provided directories are preserved;
   * the default isolated temp directory is removed on disposal. */
  dataDir?: string;
  /** Extra env for the spawned JVM (e.g. JAVA_TOOL_OPTIONS truststore). */
  extraEnv?: Record<string, string>;
  /**
   * Extra CLI/JVM args prepended ahead of adt-ls's own `-data`/`--pipe` — e.g. SNC/JCo
   * flags (`-Djco.middleware.snc_lib=…`, `-Djava.library.path=…`) or `-consoleLog`.
   */
  extraArgs?: string[];
  /** server→client request handlers, keyed by LSP method. */
  requestHandlers?: Record<string, ServerRequestHandler>;
  /** Client identity advertised in initialize (name is reused as the userAgentInfo). */
  clientInfo?: { name: string; version: string };
}

const DEFAULT_CLIENT = { name: '@arc-mcp/adt-ls', version: '0.6.0' }; // x-release-please-version

export class AdtLsDriver implements LspClient {
  private child?: ChildProcess;
  private conn?: MessageConnection;
  private server?: net.Server;
  private pipeName?: string;
  private socket?: net.Socket;
  private starting = false;
  private readonly ownsDataDir: boolean;
  private readonly dataDir: string;
  private readonly extraEnv: Record<string, string>;
  private readonly extraArgs: string[];
  private readonly requestHandlers: Record<string, ServerRequestHandler>;
  private readonly clientInfo: { name: string; version: string };
  initializeResult?: AdtLsInitializeResult;

  constructor(
    private readonly binPath: string,
    opts: AdtLsDriverOptions = {},
  ) {
    const id = crypto.randomBytes(6).toString('hex');
    this.ownsDataDir = opts.dataDir === undefined;
    this.dataDir = opts.dataDir ?? path.join(os.tmpdir(), `adt-ls-${id}`);
    this.extraEnv = opts.extraEnv ?? {};
    this.extraArgs = opts.extraArgs ?? [];
    this.requestHandlers = { ...opts.requestHandlers };
    this.clientInfo = opts.clientInfo ?? DEFAULT_CLIENT;
  }

  /** Register/replace a server→client request handler (before or after start). */
  setRequestHandler(method: string, handler: ServerRequestHandler): void {
    this.requestHandlers[method] = handler;
  }

  async start(timeoutMs = 60_000): Promise<AdtLsInitializeResult> {
    if (this.starting || this.conn) throw new Error('AdtLsDriver already started');
    this.starting = true;
    try {
      return await this.startOnce(timeoutMs);
    } catch (error) {
      await this.dispose().catch(() => {});
      throw error;
    } finally {
      this.starting = false;
    }
  }

  private async startOnce(timeoutMs: number): Promise<AdtLsInitializeResult> {
    await fsp.mkdir(this.dataDir, { recursive: true });
    const pipeName = makePipeName();
    this.pipeName = pipeName;
    if (process.platform !== 'win32') await fsp.rm(pipeName, { force: true }).catch(() => {});

    // We listen; adt-ls connects to the pipe.
    const connected = new Promise<net.Socket>((resolve, reject) => {
      const server = net.createServer((socket) => resolve(socket));
      this.server = server;
      server.on('error', reject);
      server.listen(pipeName);
    });

    const tail: string[] = [];
    const capture = (d: Buffer): void => {
      tail.push(d.toString());
      if (tail.length > 60) tail.shift();
    };

    const child = spawn(
      this.binPath,
      composeSpawnArgs({ dataDir: this.dataDir, pipeName, extraArgs: this.extraArgs }),
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...this.extraEnv },
      },
    );
    this.child = child;
    child.stdout?.on('data', capture);
    child.stderr?.on('data', (d: Buffer) => {
      capture(d);
      logger.debug(`[adt-ls] ${d.toString().trimEnd()}`);
    });

    const exitP = new Promise<never>((_, reject) => {
      child.once('error', reject);
      child.once('exit', (code) =>
        reject(new Error(`adt-ls exited (code ${code}) before LSP connect.\n${tail.slice(-12).join('')}`)),
      );
    });

    const socket = await withTimeout(Promise.race([connected, exitP]), timeoutMs, 'adt-ls LSP connect');
    exitP.catch(() => {}); // a later exit must not become an unhandled rejection
    this.socket = socket;
    socket.on('error', () => {}); // swallow ECONNRESET / ERR_STREAM_DESTROYED on teardown

    // REQUIRED for any backend HTTP: adt-ls's UserAgentUtil builds the User-Agent
    // from initializationOptions.userAgentInfos; if absent, its static initializer
    // NPEs and every HTTP destination operation fails. (ADR-0005 / verified.)
    const reader = new StreamMessageReader(socket);
    const writer = new StreamMessageWriter(socket);
    reader.onError(() => {}); // swallow stream errors (e.g. ERR_STREAM_DESTROYED) on teardown
    writer.onError(() => {});
    const conn = createMessageConnection(reader, writer);
    this.conn = conn;
    conn.onError(() => {});
    conn.onClose(() => {});
    conn.onRequest((method: string, params: unknown) => routeServerRequest(method, params, this.requestHandlers));
    conn.listen();

    const result = (await withTimeout(
      conn.sendRequest('initialize', {
        processId: process.pid,
        clientInfo: this.clientInfo,
        rootUri: null,
        workspaceFolders: null,
        capabilities: {},
        initializationOptions: { userAgentInfos: [{ name: this.clientInfo.name, version: this.clientInfo.version }] },
      }),
      timeoutMs,
      'adt-ls initialize',
    )) as AdtLsInitializeResult;
    await conn.sendNotification('initialized', {});
    this.initializeResult = result;
    assertSupportedAdtLsVersion(result.serverInfo?.version);
    if (result.serverInfo?.version !== VERIFIED_ADT_LS_VERSION) {
      logger.warn(
        `adt-ls ${result.serverInfo?.version} is supported but not the verified build ${VERIFIED_ADT_LS_VERSION}.`,
      );
    }
    logger.info(`adt-ls ready: ${result.serverInfo?.name} ${result.serverInfo?.version}`);
    return result;
  }

  async sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.conn) throw new Error('AdtLsDriver not started');
    return this.conn.sendRequest(method, params) as Promise<T>;
  }

  async sendNotification(method: string, params?: unknown): Promise<void> {
    if (!this.conn) throw new Error('AdtLsDriver not started');
    await this.conn.sendNotification(method, params);
  }

  async dispose(): Promise<void> {
    try {
      this.conn?.dispose();
    } catch {
      // best-effort
    }
    this.conn = undefined;
    this.initializeResult = undefined;
    this.socket?.destroy();
    this.socket = undefined;
    try {
      this.server?.close();
    } catch {
      // best-effort
    }
    this.server = undefined;
    try {
      const child = this.child;
      if (child && child.exitCode === null && child.signalCode === null && child.pid) {
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        child.kill('SIGKILL');
        await withTimeout(exited, 5_000, 'adt-ls exit');
      }
    } catch {
      // best-effort
    }
    this.child = undefined;
    if (this.ownsDataDir) await fsp.rm(this.dataDir, { recursive: true, force: true }).catch(() => {});
    if (this.pipeName && process.platform !== 'win32') {
      await fsp.rm(this.pipeName, { force: true }).catch(() => {});
    }
  }
}
