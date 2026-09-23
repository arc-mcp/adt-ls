/**
 * adt-ls destination + headless reentrance-ticket logon (ADR-0003).
 *
 * Proven end-to-end against a4h → `logonState:"connected"`. The recipe:
 *   1. initializeService with an ISOLATED store path (never the global
 *      ~/.adtls/destinations.json, which is shared with the user's IDEs).
 *   2. create with protocol:"http" (URL scheme lives in systemUrl) and
 *      authenticationKind:"reentranceTicket" (NOT basicAuth — that fails session
 *      dispatch: "password must not be null"). systemUrl points at the local TLS
 *      reverse proxy (https://localhost:<port>) or a valid-cert backend.
 *   3. ensureLoggedOn triggers the server→client request
 *      `adtLs/destinations/requestBrowserBasedLogon`; the registered strategy handles
 *      it. The headless handler emulates the browser: GET logonUrl with the credential
 *      → 307 + reentrance-ticket → deliver to adt-ls's 127.0.0.1 listener → return TRUE
 *      IMMEDIATELY (fire-and-forget; awaiting the delivery deadlocks).
 */
import http from 'node:http';
import https from 'node:https';
import type { LspRequester, ServerRequestHandler } from '../driver.js';
import { logger } from '../log.js';

export const LSP_REQUEST_BROWSER_LOGON = 'adtLs/destinations/requestBrowserBasedLogon';
export const LSP_REQUEST_LOGON_INPUT = 'adtLs/destinations/requestLogonInput';
export const LSP_LOGON_STATE_CHANGED = 'adtLs/destinations/logonStateChanged';
export const LSP_STOP_LOGON = 'adtLs/destinations/stopLogon';

/** Credentials used to obtain the reentrance ticket (applied by the handler). */
export type LogonCredentials = { kind: 'basic'; user: string; password: string } | { kind: 'bearer'; token: string };

export interface DestinationConfig {
  id: string;
  /** HTTPS URL adt-ls connects to (the local reverse proxy, or a valid-cert backend). */
  systemUrl: string;
  user?: string;
  client?: string;
  language?: string;
}

export interface LogonInfo {
  destinationId: string;
  user?: string;
  logonState: 'connected' | 'disconnected' | 'pending' | string;
  message?: string;
}

/** Must run before any destination op. Empty path = global store — DO NOT use. */
export function initializeDestinationsService(driver: LspRequester, storePath: string): Promise<unknown> {
  return driver.sendRequest('adtLs/destinations/initializeService', {
    destinationsStorePath: storePath,
    workspaceFolderUris: [],
    fileUris: [],
  });
}

/** Create a reentrance-ticket destination. Returns the destination id on success. */
export function createDestination(driver: LspRequester, cfg: DestinationConfig): Promise<unknown> {
  return driver.sendRequest('adtLs/destinations/create', {
    id: cfg.id,
    protocol: 'http', // ADT-over-HTTP (vs RFC); the URL scheme lives in systemUrl
    properties: {
      systemUrl: cfg.systemUrl,
      authenticationKind: 'reentranceTicket',
      ...(cfg.user ? { user: cfg.user } : {}),
      client: cfg.client ?? '001',
      language: cfg.language ?? 'EN',
    },
  });
}

export function ensureLoggedOn(driver: LspRequester, destinationId: string): Promise<LogonInfo> {
  return driver.sendRequest<LogonInfo>('adtLs/destinations/ensureLoggedOn', destinationId);
}

export function getLogonInfo(driver: LspRequester, destinationId: string): Promise<LogonInfo> {
  return driver.sendRequest<LogonInfo>('adtLs/destinations/getLogonInfo', destinationId);
}

/** Pull the reentrance `logonUrl` out of a requestBrowserBasedLogon params payload. */
export function extractLogonUrl(params: unknown): string | undefined {
  const p = params as { params?: Array<{ field?: { key?: string; value?: unknown } }> } | undefined;
  for (const item of p?.params ?? []) {
    if (item?.field?.key === 'logonUrl' && typeof item.field.value === 'string') return item.field.value;
  }
  // Fallback: find any reentranceticket URL in the payload.
  const m = JSON.stringify(params ?? null).match(/https?:[^"\\]*reentranceticket[^"\\]*/);
  return m ? m[0] : undefined;
}

function authHeader(creds?: LogonCredentials): Record<string, string> {
  if (!creds) return {}; // client-cert auth: the TLS layer authenticates, no header
  if (creds.kind === 'bearer') return { Authorization: `Bearer ${creds.token}` };
  return { Authorization: `Basic ${Buffer.from(`${creds.user}:${creds.password}`).toString('base64')}` };
}

/** GET without following redirects; resolves with status + Location. */
function httpGet(
  urlStr: string,
  opts: { headers?: Record<string, string>; insecure?: boolean } = {},
): Promise<{ status: number; location?: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: opts.headers,
        ...(u.protocol === 'https:' ? { rejectUnauthorized: !opts.insecure } : {}),
      },
      (res) => {
        res.resume(); // drain so the socket frees
        resolve({ status: res.statusCode ?? 0, location: res.headers.location });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Add `sap-client` to a reentrance logon URL that lacks it. adt-ls's `logonUrl` carries no
 * client, so the ticket GET authenticates against the backend's default client and fails
 * (401) for a user that only exists in the destination's client (verified live on 1.1.2).
 */
export function withSapClient(logonUrl: string, client?: string): string {
  if (!client) return logonUrl;
  const u = new URL(logonUrl);
  if (u.searchParams.has('sap-client')) return logonUrl;
  u.searchParams.set('sap-client', client);
  return u.toString();
}

/**
 * Emulate the browser reentrance flow: GET logonUrl with the credential → 307 +
 * reentrance-ticket in Location → deliver it to adt-ls's local 127.0.0.1 listener.
 * `insecure` skips TLS verification when WE call the proxy/backend (self-signed).
 * `client` is appended as `sap-client` when the logon URL has none (see `withSapClient`).
 * `creds` is OPTIONAL — omit it for X.509 client-certificate auth, where the TLS layer
 * (a cert-presenting reverse proxy) authenticates the GET and the backend issues the
 * ticket for the cert-mapped user, so no Authorization header is sent.
 */
export async function performReentranceLogon(
  logonUrl: string,
  creds?: LogonCredentials,
  opts: { insecure?: boolean; client?: string } = {},
): Promise<void> {
  const r1 = await httpGet(withSapClient(logonUrl, opts.client), {
    headers: authHeader(creds),
    insecure: opts.insecure,
  });
  if (!r1.location) {
    throw new Error(`reentrance: no redirect Location (status ${r1.status}) from ${logonUrl}`);
  }
  // adt-ls's listener is bound on 127.0.0.1; the redirect uses `localhost`.
  const deliver = r1.location.replace('localhost', '127.0.0.1');
  await httpGet(deliver, { insecure: opts.insecure });
}

/**
 * Build the `requestBrowserBasedLogon` handler. Fires the reentrance delivery
 * fire-and-forget and returns `true` immediately — adt-ls's listener won't respond
 * until this resolves (browser-flow semantics), so awaiting it deadlocks.
 */
export function makeReentranceLogonHandler(
  creds?: LogonCredentials,
  opts: { insecure?: boolean; client?: string } = {},
): ServerRequestHandler {
  return (params: unknown) => {
    const logonUrl = extractLogonUrl(params);
    if (!logonUrl) {
      logger.warn('requestBrowserBasedLogon: could not find logonUrl in params');
      return false;
    }
    performReentranceLogon(logonUrl, creds, opts).catch((e) =>
      logger.warn(`reentrance logon failed: ${e instanceof Error ? e.message : String(e)}`),
    );
    return true;
  };
}
