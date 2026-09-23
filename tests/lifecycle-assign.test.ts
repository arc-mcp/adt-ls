/**
 * Unit tests for lifecycle.assignTransport driven by a fake driver — `assigned` must come
 * from the CTS lock read back around the assign, not from adt-ls's boolean (which is `true`
 * even for a transport that does not exist), without needing a SAP system.
 */
import { describe, expect, it } from 'vitest';
import { createLifecycle } from '../src/api/lifecycle.js';
import type { LspRequester } from '../src/driver.js';

const URI = 'abap:/repotree-v1/ADTLS/x/zcl_x.clas.abap';

/** `locks[0]` is read before the assign, `locks[1]` after. */
function lifecycleWith(locks: [string[], string[]], assignResult: unknown = true) {
  const methods: string[] = [];
  let lockReads = 0;
  const driver: LspRequester = {
    sendRequest: async <T>(method: string): Promise<T> => {
      methods.push(method);
      if (method === 'adtLs/repository/quickSearch') return { references: [{ name: 'ZCL_X', uri: '/adt/x' }] } as T;
      if (method === 'adtLs/repository/getLsUri') return { uri: URI } as T;
      if (method === 'adtLs/cts/transport/checkTransportForObjectLock') {
        const numbers = locks[lockReads++] ?? [];
        return { isTransportCheckSuccessful: true, locks: numbers.map((number) => ({ number })) } as T;
      }
      if (method === 'adtLs/cts/transport/assignTransportToObject') return assignResult as T;
      throw new Error(`unexpected request: ${method}`);
    },
  };
  const lc = createLifecycle({ driver, callTool: async () => ({}), destination: () => 'ADTLS' });
  return { lc, methods };
}

const ref = { name: 'ZCL_X', objectType: 'CLAS/OC' };

describe('lifecycle.assignTransport', () => {
  it('confirms an assignment the lock now names', async () => {
    const { lc, methods } = lifecycleWith([[], ['DEVK900001']]);
    const r = await lc.assignTransport({ ...ref, transport: 'devk900001' });
    expect(r).toEqual({
      assigned: true,
      object: 'ZCL_X',
      objectType: 'CLAS/OC',
      transport: 'devk900001',
      lockedIn: ['DEVK900001'],
    });
    expect(methods.slice(-3)).toEqual([
      'adtLs/cts/transport/checkTransportForObjectLock',
      'adtLs/cts/transport/assignTransportToObject',
      'adtLs/cts/transport/checkTransportForObjectLock',
    ]);
  });

  it('confirms a task number when a previously unlocked object gains a lock', async () => {
    const { lc } = lifecycleWith([[], ['DEVK900001']]);
    const r = await lc.assignTransport({ ...ref, transport: 'DEVK900002' });
    expect(r).toMatchObject({ assigned: true, lockedIn: ['DEVK900001'] });
  });

  it('reports false when adt-ls says true but no lock appeared (nonexistent transport)', async () => {
    const { lc } = lifecycleWith([[], []]);
    const r = await lc.assignTransport({ ...ref, transport: 'DEVK999999' });
    expect(r).toMatchObject({ assigned: false, lockedIn: [] });
  });

  it('reports false when the object stays locked in another request', async () => {
    const { lc } = lifecycleWith([['DEVK900001'], ['DEVK900001']]);
    const r = await lc.assignTransport({ ...ref, transport: 'DEVK999999' });
    expect(r).toMatchObject({ assigned: false, lockedIn: ['DEVK900001'] });
  });

  it('reports false when adt-ls did not execute the assignment', async () => {
    const { lc } = lifecycleWith([[], ['DEVK900001']], false);
    const r = await lc.assignTransport({ ...ref, transport: 'DEVK900001' });
    expect(r.assigned).toBe(false);
  });
});
