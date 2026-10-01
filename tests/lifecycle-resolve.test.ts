/**
 * Unit tests for lifecycle.resolveAffUri (search → getLsUri) driven by a fake driver —
 * covers the main-type search for the subtypes adt-ls can't filter (`SRVD/SRV`, …) and the
 * main-type retry for any other subtyped ref whose typed search comes back empty, without
 * needing a SAP system.
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
    const { lc, searched } = lifecycleWithIndex({ 'XSLT/VT': [hit] });
    await expect(lc.resolveAffUri({ name: 'ZUI_X', objectType: 'XSLT/VT' })).resolves.toBe(LS_URI);
    // cold-retry repeats empty searches, so assert on the distinct types only
    expect([...new Set(searched)]).toEqual(['XSLT/VT']);
  });

  it('retries with the main type when the subtyped search finds nothing', async () => {
    const { lc, searched } = lifecycleWithIndex({ XSLT: [hit] });
    await expect(lc.resolveAffUri({ name: 'ZUI_X', objectType: 'XSLT/VT' })).resolves.toBe(LS_URI);
    expect([...new Set(searched)]).toEqual(['XSLT/VT', 'XSLT']);
  });

  it('still requires an exact name match on the main-type retry', async () => {
    const { lc } = lifecycleWithIndex({ XSLT: [{ name: 'ZUI_X_OTHER', uri: '/sap/bc/adt/ddic/srvd/sources/o' }] });
    await expect(lc.resolveAffUri({ name: 'ZUI_X', objectType: 'XSLT/VT' })).rejects.toThrow(
      'Object ZUI_X (XSLT/VT) not found via search.',
    );
  });

  it('does not retry when the typed search had hits, just not this name', async () => {
    const { lc, searched } = lifecycleWithIndex({
      'XSLT/VT': [{ name: 'ZUI_X_OTHER', uri: '/sap/bc/adt/ddic/srvd/sources/o' }],
      XSLT: [hit],
    });
    await expect(lc.resolveAffUri({ name: 'ZUI_X', objectType: 'XSLT/VT' })).rejects.toThrow('not found via search');
    expect([...new Set(searched)]).toEqual(['XSLT/VT']);
  });

  it('does not retry a type without a subtype', async () => {
    const { lc, searched } = lifecycleWithIndex({});
    await expect(lc.resolveAffUri({ name: 'ZUI_X', objectType: 'XSLT' })).rejects.toThrow('not found via search');
    expect([...new Set(searched)]).toEqual(['XSLT']);
  });

  it('searches a subtype adt-ls cannot filter by its main type right away', async () => {
    for (const [objectType, mainType] of [
      ['SRVD/SRV', 'SRVD'],
      ['BDEF/BDO', 'BDEF'],
      ['DDLX/EX', 'DDLX'],
      ['NROB/NRO', 'NROB'],
    ]) {
      const { lc, searched } = lifecycleWithIndex({ [mainType]: [hit] });
      await expect(lc.resolveAffUri({ name: 'ZUI_X', objectType })).resolves.toBe(LS_URI);
      expect([...new Set(searched)]).toEqual([mainType]);
    }
  });

  it('does not search the main type twice when an affected subtype finds nothing', async () => {
    const { lc, searched } = lifecycleWithIndex({});
    await expect(lc.resolveAffUri({ name: 'ZUI_X', objectType: 'SRVD/SRV' })).rejects.toThrow('not found via search');
    expect([...new Set(searched)]).toEqual(['SRVD']);
  });
});
