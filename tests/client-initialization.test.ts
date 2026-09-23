import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogonContext } from '../src/auth/strategy.js';

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  dispose: vi.fn(),
  request: vi.fn(),
  mcpConnect: vi.fn(),
  mcpClose: vi.fn(),
  dataDirs: [] as string[],
}));
vi.mock('../src/driver.js', () => ({
  AdtLsDriver: class {
    constructor(_binary: string, opts: { dataDir: string }) {
      mocks.dataDirs.push(opts.dataDir);
    }
    start = mocks.start;
    dispose = mocks.dispose;
    sendRequest = mocks.request;
  },
}));
vi.mock('../src/channels/mcp-federation.js', () => ({
  AdtLsMcpClient: class {
    connect = mocks.mcpConnect;
    close = mocks.mcpClose;
  },
}));
import { createAdtLs } from '../src/client.js';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.dataDirs.length = 0;
  mocks.start.mockResolvedValue({});
  mocks.dispose.mockResolvedValue(undefined);
  mocks.mcpClose.mockResolvedValue(undefined);
  mocks.request.mockResolvedValue({ port: 2240, token: 'fake' });
});

describe('client startup cleanup', () => {
  it.each(['driver', 'destination', 'mcp'])('removes owned resources after %s initialization fails', async (stage) => {
    if (stage === 'driver') mocks.start.mockRejectedValue(new Error('driver failure'));
    if (stage === 'destination') mocks.request.mockRejectedValue(new Error('destination failure'));
    if (stage === 'mcp') mocks.mcpConnect.mockRejectedValue(new Error('mcp failure'));
    await expect(createAdtLs({ adtLs: { path: process.execPath } })).rejects.toThrow(`${stage} failure`);
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(existsSync(path.dirname(mocks.dataDirs[0]))).toBe(false);
    if (stage === 'mcp') {
      expect(mocks.mcpClose).toHaveBeenCalledOnce();
      expect(mocks.request).toHaveBeenCalledWith('adtLs/destinations/initializeService', {
        destinationsStorePath: path.join(path.dirname(mocks.dataDirs[0]), 'destinations.json'),
        workspaceFolderUris: [],
        fileUris: [],
      });
    }
  });
  it('rejects incomplete connection options before allocating resources', async () => {
    await expect(createAdtLs({ connection: { systemUrl: 'https://example.test' } })).rejects.toThrow(
      /connection and auth together/,
    );
    expect(mocks.dataDirs).toEqual([]);
  });

  it('uses the destination default client for the logon handler too', async () => {
    let logonContext: LogonContext | undefined;
    mocks.request.mockImplementation(async (method: string) => {
      if (method === 'adtLs/destinations/create') throw new Error('stop after destination creation');
      return {};
    });
    await expect(
      createAdtLs({
        adtLs: { path: process.execPath },
        connection: { systemUrl: 'https://example.test' },
        auth: {
          kind: 'custom',
          register: (_driver, ctx) => {
            logonContext = ctx;
          },
        },
      }),
    ).rejects.toThrow('stop after destination creation');
    expect(mocks.request).toHaveBeenCalledWith(
      'adtLs/destinations/create',
      expect.objectContaining({ properties: expect.objectContaining({ client: '001' }) }),
    );
    expect(logonContext?.client).toBe('001');
  });
});
