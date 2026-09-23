import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDestination,
  ensureLoggedOn,
  extractLogonUrl,
  getLogonInfo,
  initializeDestinationsService,
  makeReentranceLogonHandler,
  performReentranceLogon,
  withSapClient,
} from '../src/auth/reentrance.js';
import type { LspRequester } from '../src/driver.js';

/** Fake requester capturing sendRequest calls. */
function fakeDriver(reply: unknown = {}) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const driver = {
    sendRequest: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params });
      return reply;
    }),
  } as unknown as LspRequester;
  return { driver, calls };
}

describe('extractLogonUrl', () => {
  const url =
    'https://localhost:5000/sap/bc/adt/core/http/reentranceticket?redirect-url=http%3A%2F%2Flocalhost%3A6000%2Fadt%2Fredirect&_=1';

  it('reads params[].field.value where key === logonUrl', () => {
    const params = { id: 'A4H', title: 'Logon', params: [{ field: { key: 'logonUrl', value: url } }] };
    expect(extractLogonUrl(params)).toBe(url);
  });

  it('falls back to a reentranceticket URL anywhere in the payload', () => {
    expect(extractLogonUrl({ nested: { whatever: url } })).toBe(url);
  });

  it('returns undefined when no logon URL is present', () => {
    expect(extractLogonUrl({ params: [{ field: { key: 'other', value: 'x' } }] })).toBeUndefined();
    expect(extractLogonUrl(null)).toBeUndefined();
  });
});

describe('destination LSP wrappers', () => {
  it('initializeDestinationsService sends the isolated store path', async () => {
    const { driver, calls } = fakeDriver();
    await initializeDestinationsService(driver, '/tmp/store');
    expect(calls[0]).toEqual({
      method: 'adtLs/destinations/initializeService',
      params: { destinationsStorePath: '/tmp/store', workspaceFolderUris: [], fileUris: [] },
    });
  });

  it('createDestination uses protocol:http + authenticationKind:reentranceTicket', async () => {
    const { driver, calls } = fakeDriver();
    await createDestination(driver, { id: 'A4H', systemUrl: 'https://localhost:5000', user: 'MARIAN' });
    expect(calls[0].method).toBe('adtLs/destinations/create');
    expect(calls[0].params).toMatchObject({
      id: 'A4H',
      protocol: 'http',
      properties: {
        systemUrl: 'https://localhost:5000',
        authenticationKind: 'reentranceTicket',
        user: 'MARIAN',
        client: '001',
        language: 'EN',
      },
    });
    // password must NOT be sent (reentrance, not basic).
    expect(JSON.stringify(calls[0].params)).not.toContain('password');
  });

  it('ensureLoggedOn / getLogonInfo pass the bare destination id string', async () => {
    const { driver, calls } = fakeDriver({ destinationId: 'A4H', logonState: 'connected' });
    await ensureLoggedOn(driver, 'A4H');
    await getLogonInfo(driver, 'A4H');
    expect(calls[0]).toEqual({ method: 'adtLs/destinations/ensureLoggedOn', params: 'A4H' });
    expect(calls[1]).toEqual({ method: 'adtLs/destinations/getLogonInfo', params: 'A4H' });
  });
});

describe('performReentranceLogon (browser emulation)', () => {
  const servers: http.Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  function listen(handler: http.RequestListener): Promise<number> {
    return new Promise((resolve) => {
      const s = http.createServer(handler);
      servers.push(s);
      s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port));
    });
  }

  it('GETs logonUrl with Basic auth, follows the 307 ticket to the delivery listener', async () => {
    let deliveredTicket: string | undefined;
    let sawAuth: string | undefined;
    const deliverPort = await listen((req, res) => {
      deliveredTicket = new URL(req.url ?? '', 'http://x').searchParams.get('reentrance-ticket') ?? undefined;
      res.writeHead(302, { location: '/done' });
      res.end();
    });
    const logonPort = await listen((req, res) => {
      sawAuth = req.headers.authorization;
      res.writeHead(307, { location: `http://localhost:${deliverPort}/adt/redirect?reentrance-ticket=TICKET123` });
      res.end();
    });

    await performReentranceLogon(`http://127.0.0.1:${logonPort}/reentranceticket`, {
      kind: 'basic',
      user: 'MARIAN',
      password: 'secret',
    });

    expect(sawAuth).toBe(`Basic ${Buffer.from('MARIAN:secret').toString('base64')}`);
    expect(deliveredTicket).toBe('TICKET123');
  });

  it('sends NO Authorization header when called without credentials (client-cert path)', async () => {
    let sawAuth: string | undefined = 'INIT';
    let delivered = false;
    const deliverPort = await listen((_req, res) => {
      delivered = true;
      res.writeHead(302, { location: '/done' });
      res.end();
    });
    const logonPort = await listen((req, res) => {
      sawAuth = req.headers.authorization;
      res.writeHead(307, { location: `http://localhost:${deliverPort}/adt/redirect?reentrance-ticket=T` });
      res.end();
    });

    await performReentranceLogon(`http://127.0.0.1:${logonPort}/reentranceticket`); // no creds → TLS cert authenticates

    expect(sawAuth).toBeUndefined();
    expect(delivered).toBe(true);
  });

  it('adds the destination client as sap-client to the ticket GET', async () => {
    let sawQuery: URLSearchParams | undefined;
    const deliverPort = await listen((_req, res) => {
      res.writeHead(302, { location: '/done' });
      res.end();
    });
    const logonPort = await listen((req, res) => {
      sawQuery = new URL(req.url ?? '', 'http://x').searchParams;
      res.writeHead(307, { location: `http://localhost:${deliverPort}/adt/redirect?reentrance-ticket=T` });
      res.end();
    });

    await performReentranceLogon(
      `http://127.0.0.1:${logonPort}/reentranceticket?redirect-url=x`,
      { kind: 'basic', user: 'u', password: 'p' },
      { client: '100' },
    );

    expect(sawQuery?.get('sap-client')).toBe('100');
    expect(sawQuery?.get('redirect-url')).toBe('x');
  });

  it('throws when the logon URL returns no redirect Location', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(401);
      res.end();
    });
    await expect(
      performReentranceLogon(`http://127.0.0.1:${port}/x`, { kind: 'basic', user: 'u', password: 'p' }),
    ).rejects.toThrow(/no redirect Location/);
  });
});

describe('makeReentranceLogonHandler', () => {
  it('returns true immediately (fire-and-forget) when a logonUrl is present', () => {
    const handler = makeReentranceLogonHandler({ kind: 'basic', user: 'u', password: 'p' });
    const out = handler({ params: [{ field: { key: 'logonUrl', value: 'http://127.0.0.1:1/reentranceticket' } }] });
    expect(out).toBe(true);
  });

  it('returns false when no logonUrl is found', () => {
    const handler = makeReentranceLogonHandler({ kind: 'basic', user: 'u', password: 'p' });
    expect(handler({ params: [] })).toBe(false);
  });
});

describe('withSapClient', () => {
  const url = 'https://localhost:5000/sap/bc/adt/core/http/reentranceticket?redirect-url=http%3A%2F%2Flocalhost%3A6000';

  it('appends sap-client and keeps the other parameters', () => {
    const u = new URL(withSapClient(url, '100'));
    expect(u.searchParams.get('sap-client')).toBe('100');
    expect(u.searchParams.get('redirect-url')).toBe('http://localhost:6000');
  });

  it('leaves a URL that already names a client alone', () => {
    const withClient = `${url}&sap-client=100`;
    expect(withSapClient(withClient, '100')).toBe(withClient);
  });

  it('leaves the URL unchanged without a client', () => {
    expect(withSapClient(url, undefined)).toBe(url);
  });
});
