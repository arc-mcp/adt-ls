/**
 * Unit tests for lifecycle.resolveAffUri (search → getLsUri) driven by a fake driver —
 * covers the main-type retry for subtyped refs whose typed search comes back empty
 * (`SRVD/SRV`, `BDEF/BDO` on 1.1.2), without needing a SAP system.
 */
import { describe, expect, it } from 'vitest';
import { createLifecycle } from '../src/api/lifecycle.js';
import type { LspRequester } from '../src/driver.js';

const LS_URI = 'abap:/repotree-v1/ADTLS/x/zui_x.srvd.asrvd';

/** A fake search index: `types[0]` → hits. Records every searched type. */
function lifecycleWithIndex(index: Record<string, Array<{ name: string; uri: string }>>) {
  const searched: string[] = [];
  const driver: LspRequester = {
    sendRequest: async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === 'adtLs/repository/quickSearch') {
        const type = (params as { types: string[] }).types[0];
        searched.push(type);
        return { references: index[type] ?? [] } as T;
      }
      if (method === 'adtLs/repository/getLsUri') return { uri: LS_URI } as T;
      throw new Error(`unexpected request: ${method}`);
    },
  };
  const lc = createLifecycle({ driver, callTool: async () => ({}), destination: () => 'ADTLS' });
  return { lc, searched };
}

const hit = { name: 'ZUI_X', uri: '/sap/bc/adt/ddic/srvd/sources/zui_x' };

describe('lifecycle.resolveAffUri', () => {
  it('resolves with the full type when the typed search finds the object', async () => {
    const { lc, searched } = lifecycleWithIndex({ 'SRVD/SRV': [hit] });
    await expect(lc.resolveAffUri({ name: 'ZUI_X', objectType: 'SRVD/SRV' })).resolves.toBe(LS_URI);
    // cold-retry repeats empty searches, so assert on the distinct types only
    expect([...new Set(searched)]).toEqual(['SRVD/SRV']);
  });

  it('retries with the main type when the subtyped search finds nothing', async () => {
    const { lc, searched } = lifecycleWithIndex({ SRVD: [hit] });
    await expect(lc.resolveAffUri({ name: 'ZUI_X', objectType: 'SRVD/SRV' })).resolves.toBe(LS_URI);
    expect([...new Set(searched)]).toEqual(['SRVD/SRV', 'SRVD']);
  });

  it('still requires an exact name match on the main-type retry', async () => {
    const { lc } = lifecycleWithIndex({ SRVD: [{ name: 'ZUI_X_OTHER', uri: '/sap/bc/adt/ddic/srvd/sources/o' }] });
    await expect(lc.resolveAffUri({ name: 'ZUI_X', objectType: 'SRVD/SRV' })).rejects.toThrow(
      'Object ZUI_X (SRVD/SRV) not found via search.',
    );
  });

  it('does not retry when the typed search had hits, just not this name', async () => {
    const { lc, searched } = lifecycleWithIndex({
      'SRVD/SRV': [{ name: 'ZUI_X_OTHER', uri: '/sap/bc/adt/ddic/srvd/sources/o' }],
      SRVD: [hit],
    });
    await expect(lc.resolveAffUri({ name: 'ZUI_X', objectType: 'SRVD/SRV' })).rejects.toThrow('not found via search');
    expect([...new Set(searched)]).toEqual(['SRVD/SRV']);
  });

  it('does not retry a type without a subtype', async () => {
    const { lc, searched } = lifecycleWithIndex({});
    await expect(lc.resolveAffUri({ name: 'ZUI_X', objectType: 'SRVD' })).rejects.toThrow('not found via search');
    expect([...new Set(searched)]).toEqual(['SRVD']);
  });
});
