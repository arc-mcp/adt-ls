/**
 * Unit tests for version-aware `source.read` (`lifecycle.readSource` with `version`) against a
 * fake adt-ls: the logged-on user's draft is served by default, `toggleVersion` flips the whole
 * object (only when there is a draft), and a write switches it back to the draft.
 */
import { describe, expect, it } from 'vitest';
import { createLifecycle } from '../src/api/lifecycle.js';
import { createObjectAccess } from '../src/api/object-access.js';
import { readFile, writeFile } from '../src/api/repository.js';
import type { LspRequester } from '../src/driver.js';

const MAIN = 'abap:/repotree-v1/ADTLS/x/zcl_x.clas.abap';
const TESTS = 'abap:/repotree-v1/ADTLS/x/zcl_x.clas.testclasses.abap';
const REF = { name: 'ZCL_X', objectType: 'CLAS/OC' };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fakeAdtLs(opts: {
  draft: boolean;
  includeDraft?: boolean;
  beforeRead?: (uri: string | undefined) => Promise<void>;
  toggleDoesNothing?: boolean;
  onRead?: (s: { pinnedActive: boolean }) => void;
  /** The first toggle switches, then throws. */
  toggleThrowsOnce?: boolean;
}) {
  const state = { pinnedActive: false };
  const calls: string[] = [];
  const served = (uri?: string) =>
    (uri === TESTS ? (opts.includeDraft ?? opts.draft) : opts.draft) && !state.pinnedActive ? 'draft' : 'active';
  const driver: LspRequester = {
    sendRequest: async <T>(method: string, params?: unknown): Promise<T> => {
      const uri = (params as { uri?: string })?.uri;
      if (method === 'adtLs/repository/quickSearch') return { references: [{ name: 'ZCL_X', uri: '/adt/x' }] } as T;
      if (method === 'adtLs/repository/getLsUri') return { uri: MAIN } as T;
      calls.push(`${method.split('/').pop()} ${uri === TESTS ? 'tests' : 'main'}`);
      if (method === 'adtLs/fileSystem/abapStat') return { version: served(uri) === 'draft' ? 1 : 0 } as T;
      if (method === 'adtLs/fileSystem/toggleVersion') {
        if (!opts.toggleDoesNothing) state.pinnedActive = !state.pinnedActive;
        if (opts.toggleThrowsOnce) {
          opts.toggleThrowsOnce = false;
          throw new Error('toggle failed');
        }
        return null as T;
      }
      if (method === 'adtLs/fileSystem/writeFile') {
        state.pinnedActive = false;
        return null as T;
      }
      if (method === 'adtLs/fileSystem/readFile') {
        await opts.beforeRead?.(uri);
        const content = `${served(uri)} ${uri === TESTS ? 'tests' : 'main'}`;
        opts.onRead?.(state);
        return { content } as T;
      }
      throw new Error(`unexpected request: ${method}`);
    },
  };
  const objectAccess = createObjectAccess();
  const lc = createLifecycle({ driver, callTool: async () => ({}), destination: () => 'ADTLS', objectAccess });
  return { lc, state, calls, driver, objectAccess };
}

describe('lifecycle.readSource version', () => {
  it('reads and restores an include-only draft when the main file is active', async () => {
    const { lc, state, calls } = fakeAdtLs({ draft: false, includeDraft: true });
    await expect(lc.readSource({ ...REF, include: 'testclasses', version: 'active' })).resolves.toBe('active tests');
    expect(state.pinnedActive).toBe(false);
    await expect(lc.readSource({ ...REF, include: 'testclasses' })).resolves.toBe('draft tests');
    expect(calls.filter((call) => call.startsWith('toggleVersion'))).toEqual([
      'toggleVersion tests',
      'toggleVersion tests',
    ]);
  });

  it('does not toggle an active include just because the main file has a draft', async () => {
    const { lc, calls } = fakeAdtLs({ draft: true, includeDraft: false });
    await expect(lc.readSource({ ...REF, include: 'testclasses', version: 'active' })).resolves.toBe('active tests');
    expect(calls.some((call) => call.startsWith('toggleVersion'))).toBe(false);
    await expect(lc.readSource(REF)).resolves.toBe('draft main');
  });

  it('rejects a toggle that failed to select the active include', async () => {
    const { lc } = fakeAdtLs({ draft: false, includeDraft: true, toggleDoesNothing: true });
    await expect(lc.readSource({ ...REF, include: 'testclasses', version: 'active' })).rejects.toThrow(
      'did not switch',
    );
  });

  it.each(['default', 'inactive', 'update', 'repository read', 'repository write'])(
    'keeps a concurrent %s operation outside the active include read',
    async (operation) => {
      const entered = deferred();
      const release = deferred();
      let pause = true;
      const { lc, state, driver, objectAccess } = fakeAdtLs({
        draft: true,
        beforeRead: async () => {
          if (pause) {
            pause = false;
            entered.resolve();
            await release.promise;
          }
        },
      });
      const activeRead = lc.readSource({ ...REF, include: 'testclasses', version: 'active' });
      await entered.promise;
      let complete = false;
      const concurrent = (
        operation === 'update'
          ? lc.updateSource({ ...REF, source: 'new draft' })
          : operation === 'repository write'
            ? objectAccess(MAIN, () => writeFile(driver, MAIN, 'new draft'))
            : operation === 'repository read'
              ? objectAccess(TESTS, () => readFile(driver, TESTS))
              : lc.readSource({
                  ...REF,
                  include: 'testclasses',
                  version: operation === 'inactive' ? 'inactive' : undefined,
                })
      ).then((result) => {
        complete = true;
        return result;
      });
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(complete).toBe(false);
      } finally {
        release.resolve();
      }
      await expect(activeRead).resolves.toBe('active tests');
      const result = await concurrent;
      if (!['update', 'repository write'].includes(operation)) expect(result).toBe('draft tests');
      expect(state.pinnedActive).toBe(false);
    },
  );

  it('releases the object queue after a failed active read', async () => {
    let fail = true;
    const { lc, state } = fakeAdtLs({
      draft: true,
      onRead: () => {
        if (fail) {
          fail = false;
          throw new Error('first read failed');
        }
      },
    });
    const activeRead = lc.readSource({ ...REF, version: 'active' });
    const defaultRead = lc.readSource(REF);
    await expect(activeRead).rejects.toThrow('first read failed');
    await expect(defaultRead).resolves.toBe('draft main');
    expect(state.pinnedActive).toBe(false);
  });

  it('allows a different object to proceed while this object is busy', async () => {
    const objectAccess = createObjectAccess();
    const entered = deferred();
    const release = deferred();
    const held = objectAccess(MAIN, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    try {
      await expect(objectAccess(MAIN.replace('/x/', '/y/'), async () => 'other object')).resolves.toBe('other object');
    } finally {
      release.resolve();
      await held;
    }
  });

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
      'abapStat main',
      'toggleVersion main',
    ]);
    await expect(lc.readSource(REF)).resolves.toBe('draft main');
  });

  it('checks and toggles the requested include', async () => {
    const { lc } = fakeAdtLs({ draft: true });
    await expect(lc.readSource({ ...REF, include: 'testclasses', version: 'active' })).resolves.toBe('active tests');
  });

  it('does not toggle an object that already serves the active version', async () => {
    const { lc, calls } = fakeAdtLs({ draft: false });
    await expect(lc.readSource({ ...REF, version: 'active' })).resolves.toBe('active main');
    expect(calls).toEqual(['abapStat main', 'readFile main', 'abapStat main']);
  });

  it("reads the served version for 'inactive' and by default, without toggling", async () => {
    const { lc, calls } = fakeAdtLs({ draft: true });
    await expect(lc.readSource({ ...REF, version: 'inactive' })).resolves.toBe('draft main');
    await expect(lc.readSource(REF)).resolves.toBe('draft main');
    expect(calls).toEqual(['readFile main', 'readFile main']);
  });

  it('rejects an invalidated active read without toggling a raw write back to active', async () => {
    const { lc, state, calls } = fakeAdtLs({
      draft: true,
      onRead: (s) => {
        s.pinnedActive = false; // what a concurrent write does
      },
    });
    await expect(lc.readSource({ ...REF, version: 'active' })).rejects.toThrow('changed during the active read');
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
      `abapStat ${file}`,
      `toggleVersion ${file}`,
      `abapStat ${file}`,
      `readFile ${file}`,
      `abapStat ${file}`,
      `abapStat ${file}`,
      `toggleVersion ${file}`,
    ];
    expect(calls).toEqual([...window('main'), ...window('tests')]);
  });

  it('restores the draft when the toggle itself fails after switching', async () => {
    const { lc, state } = fakeAdtLs({ draft: true, toggleThrowsOnce: true });
    await expect(lc.readSource({ ...REF, version: 'active' })).rejects.toThrow('toggle failed');
    expect(state.pinnedActive).toBe(false);
  });
});
