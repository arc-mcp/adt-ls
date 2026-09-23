/**
 * `createAdtLs()` — the unified client. Wires the whole stack:
 *   discover binary → (optional) TLS truststore + reverse proxy → spawn driver →
 *   register the logon strategy → create destination + ensureLoggedOn → start adt-ls's
 *   own MCP + federate it → resilience (relogon / revive) → the namespaced API.
 *
 * `connection` + `auth` are OPTIONAL: omit both for **foundation mode** — adt-ls and its
 * MCP come up with no destination (e.g. for `health` / listing destinations); the
 * destination-scoped namespaces then throw "No ABAP destination is connected." until a
 * connection is established.
 *
 * One adt-lsc process per instance, isolated store + data dir (ADR-0010). The LSP/MCP
 * split is hidden behind one API; `raw.lsp` / `raw.tool` are the escape hatches (ADR-0002).
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createLifecycle } from './api/lifecycle.js';
import type { ActivateResult, CreateResult, CreationField, ObjectRef, TransportDiffPage } from './api/lifecycle.js';
import { createNavigation } from './api/navigation.js';
import type { Navigation } from './api/navigation.js';
import { createQuality } from './api/quality.js';
import type { Quality } from './api/quality.js';
import {
  deleteFile,
  getInactiveObjects,
  getLsUri,
  getUsers,
  quickSearch,
  readFile,
  searchWithRevive,
  writeFile,
} from './api/repository.js';
import type { QuickSearchResult, UserRef } from './api/repository.js';
import { createServices } from './api/services.js';
import type { Services } from './api/services.js';
import { createDestination, ensureLoggedOn, getLogonInfo, initializeDestinationsService } from './auth/reentrance.js';
import type { LogonStrategy } from './auth/strategy.js';
import { parseFederated } from './channels/federated.js';
import { AdtLsMcpClient, type McpTool } from './channels/mcp-federation.js';
import { setMcpDestination, startMcpServer, startMcpServerWithFallback } from './channels/mcp-lifecycle.js';
import { TRUSTSTORE_PASSWORD, prepareAdtLsTls, resolveJreTools } from './connection/cert.js';
import { type TlsReverseProxy, startTlsReverseProxy } from './connection/tls-proxy.js';
import { resolveAdtLsPath } from './discovery.js';
import { AdtLsDriver, type LspClient } from './driver.js';
import { logger } from './log.js';
import {
  isLoggedOffFederatedResult,
  makeRelogon,
  makeReviveIfDead,
  makeWithRelogon,
} from './resilience/session-retry.js';

const execFileP = promisify(execFile);
const VERSION = '0.6.0'; // x-release-please-version
const CLIENT_INFO = { name: '@arc-mcp/adt-ls', version: VERSION };
/** Keep-alive heartbeat cadence + activity window (ADR-0007). */
const KEEPALIVE_INTERVAL_MS = 180_000;
const KEEPALIVE_WINDOW_MS = 900_000;

export interface ConnectionOptions {
  /** HTTPS URL of the SAP backend, e.g. `https://host:50001`. */
  systemUrl: string;
  client?: string;
  language?: string;
  /** Backend presents a self-signed cert → engage the localhost TLS reverse proxy. */
  selfSigned?: boolean;
  /** Extra CA cert PEM file paths to add to the JVM truststore (corporate PKI). */
  extraCaCerts?: string[];
  /** Route the proxy's backend hop via a consumer-supplied forward proxy (e.g. a Cloud
   *  Connector bridge). Only used with `selfSigned`. ADR-0006. */
  forwardProxy?: { host: string; port: number };
  /** Liveness probe: a known-present object to search for. Default CL_ABAP_TYPEDESCR. */
  probe?: { pattern: string; types?: string[] };
}

export interface CreateAdtLsOptions {
  /** Explicit adt-ls binary path; otherwise discovered (sapse.adt-vscode / vendor / env).
   *  `extraArgs` are prepended to the adt-ls launch (e.g. SNC/JCo JVM flags, `-consoleLog`). */
  adtLs?: { path?: string; extraArgs?: string[] };
  /** Backend connection. Omit (with `auth`) for foundation mode (adt-ls up, no destination). */
  connection?: ConnectionOptions;
  /** Logon strategy. Omit (with `connection`) for foundation mode. */
  auth?: LogonStrategy;
  /** adt-ls destination id (callers don't usually need to set this). Default 'ADTLS'. */
  destinationId?: string;
  /** Port for adt-ls's own MCP server. Default 2240 (with bind-fallback). */
  mcpPort?: number;
  /** Enable the activity-gated keep-alive heartbeat. Default true. */
  keepAlive?: boolean;
}

/** Fresh runtime contracts; tool availability can change with the destination/backend. */
export interface AdtLsCapabilities {
  lsp: Record<string, unknown>;
  tools: McpTool[];
}

export interface HealthInfo {
  connected: boolean;
  backendLive: boolean;
  destination: string;
  adtLsName?: string;
  adtLsVersion?: string;
  /** Port adt-ls's own MCP server bound (after any port-fallback). */
  mcpPort: number;
}

async function importCaCert(keytool: string, store: string, certPath: string, alias: string): Promise<void> {
  await execFileP(keytool, [
    '-importcert',
    '-noprompt',
    '-keystore',
    store,
    '-storepass',
    TRUSTSTORE_PASSWORD,
    '-alias',
    alias,
    '-file',
    certPath,
  ]);
}

export async function createAdtLs(opts: CreateAdtLsOptions): Promise<AdtLsClient> {
  if (Boolean(opts.connection) !== Boolean(opts.auth)) {
    throw new Error('Provide connection and auth together, or omit both for foundation mode.');
  }
  if (opts.auth?.clientCert && !opts.connection?.selfSigned) {
    throw new Error(
      'clientCert auth requires connection.selfSigned — the reverse proxy presents the client cert to the backend.',
    );
  }
  const conn = opts.connection;
  const auth = opts.auth;
  const probe = conn?.probe ?? { pattern: 'CL_ABAP_TYPEDESCR', types: ['CLAS/OC'] };
  const insecure = Boolean(conn?.selfSigned);
  const binPath = resolveAdtLsPath({ explicitPath: opts.adtLs?.path });
  const workBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'adt-ls-client-'));

  // The destination id is set only when a connection is configured (foundation mode → undefined).
  const destId: string | undefined = conn && auth ? (opts.destinationId ?? 'ADTLS') : undefined;

  // 1. TLS material + the systemUrl the JVM will use (only when connecting).
  let extraEnv: Record<string, string> = {};
  let systemUrl = conn?.systemUrl ?? '';
  let proxy: TlsReverseProxy | undefined;
  let driver: AdtLsDriver | undefined;
  let mcp: AdtLsMcpClient | undefined;
  try {
    if (conn?.selfSigned) {
      const tls = await prepareAdtLsTls({ adtLsBin: binPath, workDir: workBase });
      const u = new URL(conn.systemUrl);
      proxy = await startTlsReverseProxy({
        key: tls.proxyKeyPem,
        cert: tls.proxyCertPem,
        target: { host: u.hostname, port: Number(u.port || 443), protocol: u.protocol === 'http:' ? 'http' : 'https' },
        insecureUpstream: true,
        forwardProxy: conn.forwardProxy,
        // X.509 client-cert auth: the proxy presents the cert on every upstream hop → mutual TLS.
        clientCert: auth?.clientCert,
      });
      systemUrl = proxy.url;
      extraEnv = { JAVA_TOOL_OPTIONS: tls.javaToolOptions };
    } else if (conn?.extraCaCerts?.length) {
      const { keytool, cacerts } = resolveJreTools(binPath);
      const store = path.join(workBase, 'truststore.p12');
      await fsp.copyFile(cacerts, store);
      for (let i = 0; i < conn.extraCaCerts.length; i++)
        await importCaCert(keytool, store, conn.extraCaCerts[i], `ca-${i}`);
      extraEnv = {
        JAVA_TOOL_OPTIONS: [
          `-Djavax.net.ssl.trustStore=${store}`,
          `-Djavax.net.ssl.trustStorePassword=${TRUSTSTORE_PASSWORD}`,
          '-Djavax.net.ssl.trustStoreType=PKCS12',
        ].join(' '),
      };
    }

    // 2. Spawn the driver.
    const activeDriver = new AdtLsDriver(binPath, {
      dataDir: path.join(workBase, 'data'),
      extraEnv,
      extraArgs: opts.adtLs?.extraArgs,
      clientInfo: CLIENT_INFO,
    });
    driver = activeDriver;
    await activeDriver.start();
    await initializeDestinationsService(activeDriver, path.join(workBase, 'destinations.json'));

    // 3. Destination + logon (only when connecting).
    let connected = false;
    if (conn && auth && destId) {
      auth.register(activeDriver, { insecure, client: conn.client });
      await createDestination(activeDriver, {
        id: destId,
        systemUrl,
        user: auth.user,
        client: conn.client,
        language: conn.language,
      });
      const logon = await ensureLoggedOn(activeDriver, destId);
      connected = logon?.logonState === 'connected';
      if (!connected) {
        const info = await getLogonInfo(activeDriver, destId).catch(() => undefined);
        connected = info?.logonState === 'connected';
      }
      if (!connected) {
        throw new Error(
          `Logon to ${destId} did not reach 'connected' (${logon?.logonState ?? 'no logon result'}${logon?.message ? `: ${logon.message}` : ''}).`,
        );
      }
    }

    // 4. Start adt-ls's own MCP server (with port-fallback) + federate it (always).
    const token = crypto.randomBytes(24).toString('hex');
    const started = await startMcpServerWithFallback(
      (port) => startMcpServer(activeDriver, { port, token }),
      opts.mcpPort ?? 2240,
      20,
      (busy) => logger.warn(`adt-ls MCP port ${busy} busy — trying ${busy + 1}`),
    );
    const activeMcp = new AdtLsMcpClient(`http://localhost:${started.port}/mcp`, started.token, CLIENT_INFO);
    mcp = activeMcp;
    await activeMcp.connect();
    if (destId && connected) await setMcpDestination(activeDriver, destId);
    logger.info(`adt-ls MCP federated on http://localhost:${started.port}/mcp`);

    // 5. Resilience: relogon (deduped) + revive-if-dead (probe a known object). Guarded on destId.
    //    `backendLive` is tracked HONESTLY — set true on a successful probe/relogon, AND false
    //    on a failed one — so `health().backendLive` never reports a stale "alive" after a
    //    failed recovery (it is the real readiness signal).
    let backendLive = false;
    const relogon = makeRelogon(async () => {
      if (!destId) return false;
      try {
        const r = await ensureLoggedOn(activeDriver, destId);
        await setMcpDestination(activeDriver, destId);
        backendLive = r?.logonState === 'connected';
        return backendLive;
      } catch {
        backendLive = false;
        return false;
      }
    });
    const withRelogon = makeWithRelogon(relogon);
    const probeLive = async (): Promise<boolean> => {
      if (!destId) return false;
      try {
        const r = await quickSearch(
          activeDriver,
          { destination: destId, pattern: probe.pattern, maxResults: 1, types: probe.types ?? [] },
          {},
        );
        backendLive = (r.references?.length ?? 0) > 0;
      } catch {
        backendLive = false;
      }
      return backendLive;
    };
    const reviveIfDead = makeReviveIfDead(probeLive, relogon, (m) => logger.warn(m));

    // 6. Activity tracking — user calls go through `active*`; the keep-alive probe uses the raw
    //    activeDriver so it does NOT count as activity (else an idle session never lapses).
    let lastActivity = Date.now();
    const touch = (): void => {
      if (disposed) throw new Error('AdtLsClient is disposed.');
      lastActivity = Date.now();
    };
    // Both channels self-heal a lost session: `withRelogon` detects a "logged off" throw
    // (LSP) or an `isError` federated result (MCP) → re-logs-on once → retries. Combined with
    // the empty-search `reviveIfDead` below, this covers BOTH faces of session death (ADR-0008).
    const active: LspClient = {
      sendRequest<T = unknown>(m: string, p?: unknown): Promise<T> {
        touch();
        return withRelogon<T>(() => activeDriver.sendRequest<T>(m, p));
      },
      sendNotification(m: string, p?: unknown): Promise<void> {
        touch();
        return activeDriver.sendNotification(m, p);
      },
    };
    const activeCallTool = (name: string, args: Record<string, unknown>): Promise<unknown> => {
      touch();
      return withRelogon(() => activeMcp.callTool(name, args), isLoggedOffFederatedResult);
    };
    const requireDest = (): string => {
      if (!destId) throw new Error('No ABAP destination is connected.');
      return destId;
    };

    // 7. Assemble the API over the activity-tracking channels.
    const lifecycle = createLifecycle({
      driver: active,
      callTool: activeCallTool,
      destination: () => destId,
      reviveIfDead,
    });
    const semanticTokensLegend = (
      activeDriver.initializeResult?.capabilities?.semanticTokensProvider as
        | { legend?: { tokenTypes: string[]; tokenModifiers: string[] } }
        | undefined
    )?.legend;
    if (!semanticTokensLegend)
      logger.warn('adt-ls advertised no semanticTokens legend — navigation.semanticTokens will not resolve type names');
    const navigation = createNavigation({ lsp: active, lifecycle, semanticTokensLegend });
    const quality = createQuality({ lsp: active, lifecycle });
    const services = createServices({ lsp: active, lifecycle, callTool: activeCallTool, destination: () => destId });

    // 8. Warm up the cold backend caches + start the keep-alive (only when connected).
    let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
    if (connected) {
      await probeLive();
      if (opts.keepAlive !== false) {
        keepAliveTimer = setInterval(() => {
          if (Date.now() - lastActivity > KEEPALIVE_WINDOW_MS) return; // idle → stay quiet
          void reviveIfDead().catch(() => {});
        }, KEEPALIVE_INTERVAL_MS);
        keepAliveTimer.unref?.();
      }
    }

    let disposed = false;
    const dispose = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      connected = false;
      backendLive = false;
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      await activeMcp.close().catch(() => {});
      await activeDriver.dispose().catch(() => {});
      await proxy?.close().catch(() => {});
      await fsp.rm(workBase, { recursive: true, force: true }).catch(() => {});
    };

    return {
      capabilities: async (): Promise<AdtLsCapabilities> => {
        touch();
        return {
          lsp: structuredClone(activeDriver.initializeResult?.capabilities ?? {}),
          tools: await activeMcp.listTools(),
        };
      },
      repository: {
        search: async (pattern: string, o: { maxResults?: number; types?: string[]; cold?: boolean } = {}) => {
          // Self-heal: an idle-expired session returns [] (not "logged off"), so retry once if
          // reviveIfDead resurrects it. A hit confirms liveness.
          const run = () =>
            quickSearch(
              active,
              { destination: requireDest(), pattern, maxResults: o.maxResults, types: o.types },
              { cold: o.cold },
            );
          const r = await searchWithRevive(run, reviveIfDead);
          if ((r.references?.length ?? 0) > 0) backendLive = true;
          return r;
        },
        getUsers: () => getUsers(active, requireDest()),
        getLsUri: (adtUri: string) => getLsUri(active, requireDest(), adtUri),
        readFile: (uri: string) => readFile(active, uri),
        writeFile: (uri: string, content: string) => writeFile(active, uri, content),
        delete: (uri: string) => deleteFile(active, uri),
        listInactive: () => getInactiveObjects(active, requireDest()),
      },
      source: { read: lifecycle.readSource },
      lifecycle: {
        resolveAffUri: lifecycle.resolveAffUri,
        create: lifecycle.createObject,
        update: lifecycle.updateSource,
        activate: lifecycle.activate,
        runUnitTests: lifecycle.runUnitTests,
        delete: lifecycle.deleteObject,
        generate: lifecycle.generateObjects,
        validate: lifecycle.validateObject,
        listCreatableObjects: lifecycle.listCreatableObjects,
        getObjectTypeDetails: lifecycle.getObjectTypeDetails,
        getCreationForm: lifecycle.getCreationForm,
        listGenerators: lifecycle.listGenerators,
        getGeneratorSchema: lifecycle.getGeneratorSchema,
      },
      navigation,
      quality,
      services,
      transport: {
        find: lifecycle.findTransport,
        create: lifecycle.createTransport,
        assign: lifecycle.assignTransport,
        list: lifecycle.listTransports,
        check: lifecycle.checkTransport,
        getDiff: lifecycle.getTransportDiff,
        getLockStatus: lifecycle.getLockStatus,
      },
      raw: {
        lsp: <T = unknown>(method: string, params?: unknown): Promise<T> => active.sendRequest<T>(method, params),
        tool: (name: string, args: Record<string, unknown> = {}): Promise<unknown> => activeCallTool(name, args),
      },
      listDestinations: (): Promise<unknown> =>
        activeCallTool('abap_list_destinations', {}).then((r) => parseFederated(r).data),
      /** Re-logon manually (also auto-heals on dead-session detection). */
      reconnect: async (): Promise<boolean> => {
        touch();
        return relogon();
      },
      health: (): HealthInfo => ({
        connected,
        backendLive: connected && backendLive,
        destination: destId ?? '',
        adtLsName: activeDriver.initializeResult?.serverInfo?.name,
        adtLsVersion: activeDriver.initializeResult?.serverInfo?.version,
        mcpPort: started.port,
      }),
      dispose,
    };
  } catch (error) {
    await mcp?.close().catch(() => {});
    await driver?.dispose().catch(() => {});
    await proxy?.close().catch(() => {});
    await fsp.rm(workBase, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * The unified adt-ls client returned by {@link createAdtLs}. One coherent surface over
 * both adt-ls channels (LSP + adt-ls's own MCP) — the channel split is hidden. Always
 * call {@link AdtLsClient.dispose | dispose()} when finished.
 */
export interface AdtLsClient {
  /** Inspect current LSP providers and all MCP tool schemas (fresh, paginated tools/list). */
  capabilities(): Promise<AdtLsCapabilities>;
  /** Repository queries + file operations + the name→URI resolver. */
  repository: {
    /** Search ABAP repository objects by name pattern (e.g. `"CL_ABAP*"`), optionally filtered by ADT type. `cold` retries the cold-index window. */
    search(
      pattern: string,
      opts?: { maxResults?: number; types?: string[]; cold?: boolean },
    ): Promise<QuickSearchResult>;
    /** List user master records visible to the logged-on user. */
    getUsers(): Promise<UserRef[]>;
    /** Resolve an ADT object path to the canonical repotree AFF URI used by file ops. */
    getLsUri(adtUri: string): Promise<string>;
    /** Read an AFF file's content by repotree URI. */
    readFile(uri: string): Promise<string>;
    /** Write an AFF file (plain multi-line source) by repotree URI. */
    writeFile(uri: string, content: string): Promise<unknown>;
    /** Delete by AFF URI (use the `.json` metadata URI for objects). */
    delete(uri: string): Promise<unknown>;
    /** List inactive (draft) objects on the connected destination. */
    listInactive(): Promise<unknown[]>;
  };
  /** Read object source by name. */
  source: {
    /** Read an object's source (per include for classes, e.g. `include: 'testclasses'`). */
    read(args: ObjectRef & { include?: string }): Promise<string>;
  };
  /** The authoring lifecycle for object types served by the installed runtime/backend. */
  lifecycle: {
    /** Resolve `{name, objectType}` → repotree AFF URI (search → getLsUri). */
    resolveAffUri(ref: ObjectRef): Promise<string>;
    /** Create an object. `transportRequestNumber` is `''` for `$TMP`/local packages. */
    create(args: {
      objectType: string;
      name: string;
      packageName: string;
      description: string;
      transportRequestNumber?: string;
      /** Type-specific creation fields from getCreationForm; explicit name/package/description win. */
      additionalFields?: Record<string, unknown>;
    }): Promise<CreateResult>;
    /** Update an object's source (optionally a specific include). */
    update(args: ObjectRef & { source: string; include?: string }): Promise<void>;
    /** Activate via native `activation/activate` (per-phase flags + refresh URIs; optional
     * `forceActivation`). `success:false` with structured `diagnostics` on failure. */
    activate(args: ObjectRef & { forceActivation?: boolean }): Promise<ActivateResult>;
    /** Run the object's ABAP Unit tests. */
    runUnitTests(args: ObjectRef): Promise<unknown>;
    /** Delete the object (targets its `.json` metadata). */
    delete(args: ObjectRef): Promise<void>;
    /** Run a RAP generator → a full object set (table/CDS/BDEF/SRVD/SRVB). */
    generate(args: {
      generatorId: string;
      content: string;
      packageName: string;
      transportRequestNumber?: string;
      referencedObjectType?: string;
      referencedObjectName?: string;
    }): Promise<unknown>;
    /** Validate creation input before create (read-only verdict). */
    validate(args: {
      objectType: string;
      name: string;
      packageName: string;
      description: string;
      additionalFields?: Record<string, unknown>;
    }): Promise<unknown>;
    /** List the object types creatable on this system (ABAP-Cloud / RAP catalog). */
    listCreatableObjects(): Promise<unknown>;
    /** Creation details (flat MCP field list) for one object type, e.g. `"CLAS/OC"`. */
    getObjectTypeDetails(objectType: string, opts?: { name?: string }): Promise<unknown>;
    /** Full creation form contract — each field's value-help target types, name regex, label,
     * required — parsed from the native UI model (richer than `getObjectTypeDetails`). */
    getCreationForm(
      objectType: string,
      opts?: { name?: string },
    ): Promise<{ objectType: string; fields: CreationField[] }>;
    /** List the available RAP generators (feed an id to `generate` / `getGeneratorSchema`). */
    listGenerators(): Promise<unknown>;
    /** The JSON input schema a generator's `content` must satisfy. */
    getGeneratorSchema(
      generatorId: string,
      opts?: { packageName?: string; referencedObjectType?: string; referencedObjectName?: string },
    ): Promise<unknown>;
  };
  /** LSP code-intelligence (symbols, definition, references, type-hierarchy, hover, completion, syntax check). */
  navigation: Navigation;
  /** Quality: ATC static analysis + ABAP Unit code coverage. */
  quality: Quality;
  /** Runtime + business services: run a console app, service-binding details/publish. */
  services: Services;
  /** CTS transport + lock operations. */
  transport: {
    /** One page of unified object differences in a transport (1.1.2+, backend-dependent). */
    getDiff(transportNumber: string, opts?: { cursor?: string; pageSize?: number }): Promise<TransportDiffPage>;
    /** Object-scoped transport lookup (read-only). */
    find(args: {
      objectName: string;
      objectType: string;
      developmentPackage: string;
      isCreation: boolean;
    }): Promise<unknown>;
    /** Create a CTS transport request (refuses local `$`-packages). */
    create(args: {
      developmentPackage: string;
      transportDescription: string;
      isCreation: boolean;
      objectName: string;
      objectType: string;
    }): Promise<unknown>;
    /** Assign an existing transport to an object. `assigned` is confirmed by reading the
     * object's CTS lock back (`lockedIn` = the request(s) it names afterwards). */
    assign(args: ObjectRef & { transport: string }): Promise<{
      assigned: boolean;
      object: string;
      objectType: string;
      transport: string;
      lockedIn: string[];
    }>;
    /** List your modifiable transports (capped + filterable). */
    list(opts?: { limit?: number; query?: string }): Promise<unknown>;
    /** Transport decision oracle: does this op need a transport, which are assignable, is it
     * locked? (`isRecordingRequired:false` for `$TMP`/local.) `operation` defaults to MODIFY. */
    check(
      args: ObjectRef & {
        operation?: 'CREATE' | 'MODIFY' | 'DELETE';
        transportLayer?: string;
        recordChanges?: boolean;
      },
    ): Promise<unknown>;
    /** Read an object's lock status. */
    getLockStatus(args: ObjectRef): Promise<{ lockingSupported: boolean; lockId: string | null }>;
  };
  /** Escape hatches for the long tail (ADR-0002). */
  raw: {
    /** Raw LSP / `adtLs/*` request. */
    lsp<T = unknown>(method: string, params?: unknown): Promise<T>;
    /** Raw call to a tool on adt-ls's own MCP server (e.g. a backend-dynamic tool). */
    tool(name: string, args?: Record<string, unknown>): Promise<unknown>;
  };
  /** List the ABAP destinations adt-ls knows (works without a connected destination). */
  listDestinations(): Promise<unknown>;
  /** Force a SAP re-logon; `true` when the session is live afterwards (also auto-heals on dead-session detection). */
  reconnect(): Promise<boolean>;
  /** Connection + liveness snapshot. */
  health(): HealthInfo;
  /** Shut down: stop the keep-alive, kill adt-ls, close the proxy, and clean temp dirs. */
  dispose(): Promise<void>;
}
