/**
 * Unit tests for repository.searchTypes — the type filter `repository.search` and
 * `lifecycle.resolveAffUri` send to quickSearch, with the subtypes adt-ls can't filter
 * (`SRVD/SRV`, …) replaced by their main type.
 */
import { describe, expect, it } from 'vitest';
import { searchTypes } from '../src/api/repository.js';

describe('repository.searchTypes', () => {
  it('replaces an affected subtype by its main type', () => {
    expect(searchTypes(['SRVD/SRV'])).toEqual(['SRVD']);
    expect(searchTypes(['BDEF/BDO', 'DDLX/EX', 'NROB/NRO'])).toEqual(['BDEF', 'DDLX', 'NROB']);
  });

  it('keeps the other entries as they are and dedupes', () => {
    expect(searchTypes(['SRVD/SRV', 'SRVD', 'CLAS/OC'])).toEqual(['SRVD', 'CLAS/OC']);
  });

  it('keeps subtypes whose filter works (a TABL search would find tables for TABL/DS)', () => {
    expect(searchTypes(['TABL/DS'])).toEqual(['TABL/DS']);
    expect(searchTypes(['PROG/I', 'SRVB/SVB'])).toEqual(['PROG/I', 'SRVB/SVB']);
  });

  it('passes no filter through unchanged', () => {
    expect(searchTypes(undefined)).toBeUndefined();
    expect(searchTypes([])).toEqual([]);
  });
});
