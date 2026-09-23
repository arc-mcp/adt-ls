import net from 'node:net';
import type { ServerRequestHandler } from '../driver.js';
/**
 * Pluggable authentication (ADR-0003). The on-the-wire method is always
 * `reentranceTicket`; a `LogonStrategy` supplies the *credential* used to fetch the
 * ticket and registers the server→client logon handler(s) on the driver.
 *
 * Built-ins:
 *   - `basic(user, password)`  — headless, on-prem fixed user (fire-and-forget).
 *   - `bearer(token|getToken)` — headless, BTP ABAP / Steampunk (caller's OAuth token).
 *   - `clientCert({cert,key})` — headless, passwordless X.509 mutual TLS (proxy presents
 *     the cert; backend maps it via CERTRULE). Requires `connection.selfSigned`.
 *   - `interactive(callbacks)` — human completes SSO; the lib ships NO browser/TTY,
 *     only consumer callbacks (a batteries-included helper is a separate sub-export).
 *   - `custom(register)`       — full escape hatch.
 *
 * The strategy does NOT call `ensureLoggedOn` — the client orchestrates
 * init → create → ensureLoggedOn. A strategy only registers handlers (+ an optional
 * `user` to record on the destination).
 */
import { logger } from '../log.js';
import {
  LSP_REQUEST_BROWSER_LOGON,
  LSP_REQUEST_LOGON_INPUT,
  extractLogonUrl,
  makeReentranceLogonHandler,
  performReentranceLogon,
} from './reentrance.js';

/** Anything that can register a server→client request handler (e.g. AdtLsDriver). */
export interface LogonHandlerRegistrar {
  setRequestHandler(method: string, handler: ServerRequestHandler): void;
}

export interface LogonContext {
  /** Skip TLS verification when our handler calls the proxy/backend (self-signed). */
  insecure?: boolean;
  /** The destination's SAP client; the headless strategies (basic, bearer, clientCert) append
   *  it as `sap-client` to a logon URL that lacks it. */
  client?: string;
}

export interface LogonStrategy {
  readonly kind: 'basic' | 'bearer' | 'interactive' | 'custom' | 'clientCert';
  /** Optional user to record on the adt-ls destination (createDestination). */
  readonly user?: string;
  /** PEM client cert + key for the upstream TLS hop. Set only by `clientCert()`; the
   *  library's reverse proxy presents it to the backend on every request, so the TLS
   *  connection itself (mutual TLS → e.g. AS ABAP `verify_client` + CERTRULE) authenticates
   *  the user. Requires `connection.selfSigned` (the proxy does the mutual-TLS hop). */
  readonly clientCert?: { cert: string | Buffer; key: string | Buffer };
  /** Register the server→client logon handler(s) before `ensureLoggedOn`. */
  register(driver: LogonHandlerRegistrar, ctx: LogonContext): void;
}

/** Basic (user/password) — headless reentrance. The common on-prem case. */
export function basic(user: string, password: string): LogonStrategy {
  return {
    kind: 'basic',
    user,
    register(driver, ctx) {
      driver.setRequestHandler(
        LSP_REQUEST_BROWSER_LOGON,
        makeReentranceLogonHandler({ kind: 'basic', user, password }, { insecure: ctx.insecure, client: ctx.client }),
      );
    },
  };
}

/** Bearer token — headless reentrance for BTP ABAP. `token` may be a value or an
 *  async provider resolved at logon time. The lib does NOT acquire OAuth tokens. */
export function bearer(token: string | (() => string | Promise<string>), opts: { user?: string } = {}): LogonStrategy {
  return {
    kind: 'bearer',
    user: opts.user,
    register(driver, ctx) {
      driver.setRequestHandler(LSP_REQUEST_BROWSER_LOGON, (params) => {
        const logonUrl = extractLogonUrl(params);
        if (!logonUrl) {
          logger.warn('requestBrowserBasedLogon: no logonUrl in params');
          return false;
        }
        void (async () => {
          const t = typeof token === 'function' ? await token() : token;
          await performReentranceLogon(
            logonUrl,
            { kind: 'bearer', token: t },
            { insecure: ctx.insecure, client: ctx.client },
          );
        })().catch((e) => logger.warn(`bearer reentrance logon failed: ${e instanceof Error ? e.message : String(e)}`));
        return true; // fire-and-forget
      });
    },
  };
}

/**
 * Client certificate (mutual TLS) — passwordless, headless, NO browser. The library's
 * reverse proxy presents `cert`/`key` to the backend on every upstream hop, so the TLS
 * connection authenticates the user (e.g. AS ABAP `icm/HTTPS/verify_client=1` + CERTRULE
 * maps the cert subject → user). The reentrance handler runs with NO credential — the cert
 * authenticates the GET, so the backend issues the ticket for the cert-mapped user.
 *
 * Requires `connection.selfSigned` (the proxy does the mutual-TLS hop). License-free on the
 * server; nothing to install on the client. Re-auth on a lapsed session is silent (the proxy
 * just re-presents the cert) — no browser pop, unlike `interactive`.
 */
export function clientCert(opts: { cert: string | Buffer; key: string | Buffer; user?: string }): LogonStrategy {
  return {
    kind: 'clientCert',
    user: opts.user,
    clientCert: { cert: opts.cert, key: opts.key },
    register(driver, ctx) {
      driver.setRequestHandler(
        LSP_REQUEST_BROWSER_LOGON,
        makeReentranceLogonHandler(undefined, { insecure: ctx.insecure, client: ctx.client }),
      );
    },
  };
}

export interface InteractiveCallbacks {
  /** Open the SSO URL (browser). The user completes sign-in there. */
  openUrl(url: string): void | Promise<void>;
  /** Prompt for a logon field (e.g. password) when adt-ls asks. Optional. */
  promptField?(field: { key: string; label: string; sensitive: boolean }): Promise<string | undefined>;
  /** Record the destination user. */
  user?: string;
}

type RequestLogonInputParams = {
  id: string;
  title?: string;
  /** 1.0.1 sends sensitive answers to this localhost socket instead of the JSON-RPC response. */
  sensitiveFieldsSocketPort?: number;
  params?: Array<{
    /** 1.0.1 field id. */
    name?: string;
    description?: string;
    label?: string;
    sensitive?: boolean;
    /** 1.0.0 field id. */
    field?: { key?: string };
  }>;
};

function sendSensitiveFields(port: number, fields: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(port, 'localhost', () => {
      socket.write(JSON.stringify(fields), (err) => {
        socket.end();
        err ? reject(err) : resolve();
      });
    });
    socket.on('error', reject);
  });
}

/** Interactive — the consumer supplies the UX (no hardcoded browser/TTY). */
export function interactive(cb: InteractiveCallbacks): LogonStrategy {
  return {
    kind: 'interactive',
    user: cb.user,
    register(driver) {
      driver.setRequestHandler(LSP_REQUEST_BROWSER_LOGON, (params) => {
        const url = extractLogonUrl(params);
        if (url) void cb.openUrl(url);
        return true; // user completes SSO in the opened browser
      });
      if (cb.promptField) {
        driver.setRequestHandler(LSP_REQUEST_LOGON_INPUT, async (params) => {
          const p = params as RequestLogonInputParams;
          const fields = p.params ?? [];
          if (fields.length === 0) return undefined;

          const legacyFields: Array<{ key: string; value: string }> = [];
          const sensitiveFields: Record<string, string> = {};
          const nonSensitiveFields: Record<string, string> = {};

          for (const field of fields) {
            const key = field.name ?? field.field?.key;
            if (!key) continue;
            const value = await cb.promptField?.({
              key,
              label: field.description ?? field.label ?? 'Enter value',
              sensitive: Boolean(field.sensitive),
            });
            const trimmed = value?.trim();
            if (!trimmed) return undefined;

            if (!p.sensitiveFieldsSocketPort) {
              legacyFields.push({ key, value: trimmed });
            } else if (field.sensitive) {
              sensitiveFields[key] = trimmed;
            } else {
              nonSensitiveFields[key] = trimmed;
            }
          }

          if (p.sensitiveFieldsSocketPort && Object.keys(sensitiveFields).length > 0) {
            await sendSensitiveFields(p.sensitiveFieldsSocketPort, sensitiveFields);
          }

          return p.sensitiveFieldsSocketPort ? { nonSensitiveFields } : { id: p.id, fields: legacyFields };
        });
      }
    },
  };
}

/** Full escape hatch: register your own server→client handlers. */
export function custom(
  register: (driver: LogonHandlerRegistrar, ctx: LogonContext) => void,
  opts: { user?: string } = {},
): LogonStrategy {
  return { kind: 'custom', user: opts.user, register };
}
