/**
 * Unit tests for version-aware `source.read` (`lifecycle.readSource` with `version`) against a
 * fake adt-ls: the logged-on user's draft is served by default, `toggleVersion` flips the whole
 * object (only when there is a draft), and a write switches it back to the draft.
 */
import { describe, expect, it } from 'vitest';
import { createLifecycle } from '../src/api/lifecycle.js';
import type { LspRequester } from '../src/driver.js';

const MAIN = 'abap:/repotree-v1/ADTLS/x/zcl_x.clas.abap';
const TESTS = 'abap:/repotree-v1/ADTLS/x/zcl_x.clas.testclasses.abap';
const REF = { name: 'ZCL_X', objectType: 'CLAS/OC' };

function fakeAdtLs(opts: {
  draft: boolean;
  onRead?: (s: { pinnedActive: boolean }) => void;
  /** The first toggle switches, then throws. */
  toggleThrowsOnce?: boolean;
}) {
  const state = { pinnedActive: false };
  const calls: string[] = [];
  const served = () => (opts.draft && !state.pinnedActive ? 'draft' : 'active');
  const driver: LspRequester = {
    sendRequest: async <T>(method: string, params?: unknown): Promise<T> => {
      const uri = (params as { uri?: string })?.uri;
      if (method === 'adtLs/repository/quickSearch') return { references: [{ name: 'ZCL_X', uri: '/adt/x' }] } as T;
      if (method === 'adtLs/repository/getLsUri') return { uri: MAIN } as T;
      calls.push(`${method.split('/').pop()} ${uri === TESTS ? 'tests' : 'main'}`);
      if (method === 'adtLs/fileSystem/abapStat') return { version: served() === 'draft' ? 1 : 0 } as T;
      if (method === 'adtLs/fileSystem/toggleVersion') {
        if (opts.draft) state.pinnedActive = !state.pinnedActive;
        if (opts.toggleThrowsOnce) {
          opts.toggleThrowsOnce = false;
          throw new Error('toggle failed');
        }
        return null as T;
      }
      if (method === 'adtLs/fileSystem/readFile') {
        const content = `${served()} ${uri === TESTS ? 'tests' : 'main'}`;
        opts.onRead?.(state);
        return { content } as T;
      }
      throw new Error(`unexpected request: ${method}`);
    },
  };
  const lc = createLifecycle({ driver, callTool: async () => ({}), destination: () => 'ADTLS' });
  return { lc, state, calls };
}

describe('lifecycle.readSource version', () => {
  it('reads the active version of an object with a draft, then restores the draft', async () => {
    const { lc, state, calls } = fakeAdtLs({ draft: true });
    await expect(lc.readSource({ ...REF, version: 'active' })).resolves.toBe('active main');
    expect(state.pinnedActive).toBe(false);
    expect(calls).toEqual([
      'abapStat main',
      'toggleVersion main',
      'abapStat main',
      'readFile main',
      'abapStat main',
      'toggleVersion main',
    ]);
    await expect(lc.readSource(REF)).resolves.toBe('draft main');
  });

  it('toggles the main URI and reads the include', async () => {
    const { lc } = fakeAdtLs({ draft: true });
    await expect(lc.readSource({ ...REF, include: 'testclasses', version: 'active' })).resolves.toBe('active tests');
  });

  it('does not toggle an object that already serves the active version', async () => {
    const { lc, calls } = fakeAdtLs({ draft: false });
    await expect(lc.readSource({ ...REF, version: 'active' })).resolves.toBe('active main');
    expect(calls).toEqual(['abapStat main', 'readFile main']);
  });

  it("reads the served version for 'inactive' and by default, without toggling", async () => {
    const { lc, calls } = fakeAdtLs({ draft: true });
    await expect(lc.readSource({ ...REF, version: 'inactive' })).resolves.toBe('draft main');
    await expect(lc.readSource(REF)).resolves.toBe('draft main');
    expect(calls).toEqual(['readFile main', 'readFile main']);
  });

  it('does not toggle back when a write already switched adt-ls to the draft', async () => {
    const { lc, state, calls } = fakeAdtLs({
      draft: true,
      onRead: (s) => {
        s.pinnedActive = false; // what a concurrent write does
      },
    });
    await expect(lc.readSource({ ...REF, version: 'active' })).resolves.toBe('active main');
    expect(state.pinnedActive).toBe(false);
    expect(calls.filter((c) => c.startsWith('toggleVersion'))).toHaveLength(1);
  });

  it('restores the draft when the read fails', async () => {
    const { lc, state } = fakeAdtLs({
      draft: true,
      onRead: () => {
        throw new Error('read failed');
      },
    });
    await expect(lc.readSource({ ...REF, version: 'active' })).rejects.toThrow('read failed');
    expect(state.pinnedActive).toBe(false);
  });

  it('serializes concurrent active reads of one object', async () => {
    const { lc, state, calls } = fakeAdtLs({ draft: true });
    const reads = await Promise.all([
      lc.readSource({ ...REF, version: 'active' }),
      lc.readSource({ ...REF, include: 'testclasses', version: 'active' }),
    ]);
    expect(reads).toEqual(['active main', 'active tests']);
    expect(state.pinnedActive).toBe(false);
    // two complete toggle → read → toggle-back windows, one after the other
    const window = (file: string) => [
      'abapStat main',
      'toggleVersion main',
      'abapStat main',
      `readFile ${file}`,
      'abapStat main',
      'toggleVersion main',
    ];
    expect(calls).toEqual([...window('main'), ...window('tests')]);
  });

  it('restores the draft when the toggle itself fails after switching', async () => {
    const { lc, state } = fakeAdtLs({ draft: true, toggleThrowsOnce: true });
    await expect(lc.readSource({ ...REF, version: 'active' })).rejects.toThrow('toggle failed');
    expect(state.pinnedActive).toBe(false);
  });
});
