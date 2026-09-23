import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { LSP_REQUEST_BROWSER_LOGON, LSP_REQUEST_LOGON_INPUT } from '../src/auth/reentrance.js';
import { basic, bearer, clientCert, custom, interactive } from '../src/auth/strategy.js';
import type { ServerRequestHandler } from '../src/driver.js';

function fakeRegistrar() {
  const handlers: Record<string, ServerRequestHandler> = {};
  return {
    handlers,
    setRequestHandler(m: string, h: ServerRequestHandler) {
      handlers[m] = h;
    },
  };
}

describe('LogonStrategy', () => {
  it('basic registers a reentrance handler + exposes the user', () => {
    const s = basic('MARIAN', 'pw');
    expect(s.kind).toBe('basic');
    expect(s.user).toBe('MARIAN');
    const reg = fakeRegistrar();
    s.register(reg, {});
    const h = reg.handlers[LSP_REQUEST_BROWSER_LOGON];
    expect(h).toBeTypeOf('function');
    expect(h({ params: [] })).toBe(false); // no logonUrl
    expect(h({ params: [{ field: { key: 'logonUrl', value: 'http://127.0.0.1:1/reentranceticket' } }] })).toBe(true);
  });

  it('bearer resolves a token provider lazily + returns true fire-and-forget', () => {
    const getToken = vi.fn(async () => 'TOK');
    const s = bearer(getToken, { user: 'CB9980000001' });
    expect(s.kind).toBe('bearer');
    expect(s.user).toBe('CB9980000001');
    const reg = fakeRegistrar();
    s.register(reg, {});
    const h = reg.handlers[LSP_REQUEST_BROWSER_LOGON];
    expect(h({ params: [{ field: { key: 'logonUrl', value: 'http://127.0.0.1:1/reentranceticket' } }] })).toBe(true);
    expect(h({ params: [] })).toBe(false);
  });

  it('interactive opens the SSO url + can prompt legacy 1.0.0 fields', async () => {
    const opened: string[] = [];
    const s = interactive({ openUrl: (u) => void opened.push(u), promptField: async () => 'secret' });
    const reg = fakeRegistrar();
    s.register(reg, {});
    expect(
      reg.handlers[LSP_REQUEST_BROWSER_LOGON]({ params: [{ field: { key: 'logonUrl', value: 'https://idp/login' } }] }),
    ).toBe(true);
    expect(opened).toEqual(['https://idp/login']);
    const out = await reg.handlers[LSP_REQUEST_LOGON_INPUT]({
      id: 'A4H',
      params: [{ field: { key: 'password' }, sensitive: true, label: 'PW' }],
    });
    expect(out).toEqual({ id: 'A4H', fields: [{ key: 'password', value: 'secret' }] });
  });

  it('interactive handles 1.0.1 sensitive-field socket logon input', async () => {
    const received = new Promise<Record<string, string>>((resolve, reject) => {
      const server = net.createServer((socket) => {
        let data = '';
        socket.on('data', (chunk) => {
          data += chunk.toString();
        });
        socket.on('end', () => {
          server.close();
          try {
            resolve(JSON.parse(data) as Record<string, string>);
          } catch (error) {
            reject(error);
          }
        });
      });
      server.on('error', reject);
      server.listen(0, 'localhost', async () => {
        try {
          const port = (server.address() as AddressInfo).port;
          const s = interactive({
            openUrl: () => {},
            promptField: async (field) => (field.key === 'password' ? ' secret ' : ' 001 '),
          });
          const reg = fakeRegistrar();
          s.register(reg, {});
          const out = await reg.handlers[LSP_REQUEST_LOGON_INPUT]({
            id: 'A4H',
            title: 'Logon to A4H',
            sensitiveFieldsSocketPort: port,
            params: [
              { name: 'password', sensitive: true, label: 'Password' },
              { name: 'client', sensitive: false, label: 'Client' },
            ],
          });
          expect(out).toEqual({ nonSensitiveFields: { client: '001' } });
        } catch (error) {
          server.close();
          reject(error);
        }
      });
    });

    await expect(received).resolves.toEqual({ password: 'secret' });
  });

  it('clientCert carries the cert + registers a no-credential reentrance handler', () => {
    const s = clientCert({ cert: 'CERT_PEM', key: 'KEY_PEM', user: 'MARIAN' });
    expect(s.kind).toBe('clientCert');
    expect(s.user).toBe('MARIAN');
    expect(s.clientCert).toEqual({ cert: 'CERT_PEM', key: 'KEY_PEM' });
    const reg = fakeRegistrar();
    s.register(reg, { insecure: true });
    const h = reg.handlers[LSP_REQUEST_BROWSER_LOGON];
    expect(h).toBeTypeOf('function');
    expect(h({ params: [] })).toBe(false); // no logonUrl
    // a logonUrl is accepted fire-and-forget; the TLS cert (presented by the proxy) authenticates it
    expect(h({ params: [{ field: { key: 'logonUrl', value: 'http://127.0.0.1:1/reentranceticket' } }] })).toBe(true);
  });

  it('custom passes through a register function', () => {
    const reg = fakeRegistrar();
    const s = custom((d) => d.setRequestHandler('x', () => 1), { user: 'U' });
    expect(s.kind).toBe('custom');
    expect(s.user).toBe('U');
    s.register(reg, {});
    expect(reg.handlers.x({})).toBe(1);
  });
});

describe('LogonStrategy client', () => {
  it('basic sends the destination client as sap-client on the ticket GET', async () => {
    const seen = new Promise<string | null>((resolve) => {
      const server = http.createServer((req, res) => {
        resolve(new URL(req.url ?? '', 'http://x').searchParams.get('sap-client'));
        res.writeHead(401);
        res.end();
        server.close();
      });
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        const reg = fakeRegistrar();
        basic('U', 'pw').register(reg, { client: '100' });
        reg.handlers[LSP_REQUEST_BROWSER_LOGON]({
          params: [{ field: { key: 'logonUrl', value: `http://127.0.0.1:${port}/reentranceticket` } }],
        });
      });
    });
    await expect(seen).resolves.toBe('100');
  });
});
