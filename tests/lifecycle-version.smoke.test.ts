/** Live regressions for version reads. Only creates a uniquely named $TMP class. */
import { afterAll, describe, expect, it } from 'vitest';
import { type AdtLsClient, basic, createAdtLs, resolveAdtLsPath } from '../src/index.js';

let binary: string | undefined;
try {
  binary = resolveAdtLsPath();
} catch {
  /* The real SAP runtime is optional in CI. */
}
const password = process.env.ADTLS_TEST_PASSWORD;
const name = `ZCL_ADTLS_VER_${Math.random().toString(36).slice(2, 9).toUpperCase()}`;
const ref = { name, objectType: 'CLAS/OC' };
// A write is cached with its input line endings; toggling reloads SAP's CRLF source.
const normalize = (source: string) => source.replace(/\r\n/g, '\n');
const main = (method: string) => `CLASS ${name} DEFINITION PUBLIC FINAL CREATE PUBLIC.
PUBLIC SECTION.
  METHODS ${method}.
ENDCLASS.
CLASS ${name} IMPLEMENTATION.
  METHOD ${method}.
  ENDMETHOD.
ENDCLASS.`;
const tests = (value: number) => `CLASS ltc_version DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.
PRIVATE SECTION.
  METHODS works FOR TESTING.
ENDCLASS.
CLASS ltc_version IMPLEMENTATION.
  METHOD works.
    cl_abap_unit_assert=>assert_equals( exp = ${value} act = ${value} ).
  ENDMETHOD.
ENDCLASS.`;

describe('version reads (live SAP)', () => {
  let adt: AdtLsClient | undefined;
  let created = false;
  afterAll(async () => {
    try {
      if (created) await adt?.lifecycle.delete(ref);
    } finally {
      await adt?.dispose();
    }
  });

  it.skipIf(!binary || !password)(
    'reads include-only drafts correctly and isolates concurrent client operations',
    async () => {
      const client = await createAdtLs({
        adtLs: { path: binary },
        connection: {
          systemUrl: process.env.ADTLS_TEST_URL ?? 'https://a4h.marianzeis.de',
          client: '001',
          selfSigned: process.env.ADTLS_TEST_SELF_SIGNED === '1',
        },
        auth: basic(process.env.ADTLS_TEST_USER ?? 'MARIAN', password as string),
        keepAlive: false,
      });
      adt = client;
      const result = await client.lifecycle.create({
        ...ref,
        packageName: '$TMP',
        description: 'Version read regression',
      });
      created = true;
      const uri = result.filePath ?? (await client.lifecycle.resolveAffUri(ref));
      const target = { ...ref, uri };
      const testUri = uri.replace(/\.clas\.abap$/, '.clas.testclasses.abap');
      await client.lifecycle.update({ ...target, source: main('active_method') });
      await client.lifecycle.update({ ...target, include: 'testclasses', source: tests(1) });
      expect((await client.lifecycle.activate(target)).success).toBe(true);
      const activeMain = normalize(await client.source.read({ ...target, version: 'active' }));
      const activeTests = normalize(await client.source.read({ ...target, include: 'testclasses' }));

      await client.lifecycle.update({ ...target, include: 'testclasses', source: tests(2) });
      expect(await client.repository.abapStat(uri)).toBe('active');
      expect(await client.repository.abapStat(testUri)).toBe('inactive');
      const activeInclude = await client.source.read({ ...target, include: 'testclasses', version: 'active' });
      expect(normalize(activeInclude)).toBe(activeTests);
      expect(normalize(await client.source.read({ ...target, include: 'testclasses' }))).toBe(tests(2));
      expect(await client.repository.abapStat(testUri)).toBe('inactive');

      const [activeRead, defaultRead, inactiveRead, fileRead, version] = await Promise.all([
        client.source.read({ ...target, include: 'testclasses', version: 'active' }),
        client.source.read({ ...target, include: 'testclasses' }),
        client.source.read({ ...target, include: 'testclasses', version: 'inactive' }),
        client.repository.readFile(testUri),
        client.repository.abapStat(testUri),
      ]);
      expect(normalize(activeRead)).toBe(activeTests);
      for (const draft of [defaultRead, inactiveRead, fileRead]) expect(normalize(draft)).toBe(tests(2));
      expect(version).toBe('inactive');

      const [activeBeforeUpdate] = await Promise.all([
        client.source.read({ ...target, include: 'testclasses', version: 'active' }),
        client.lifecycle.update({ ...target, include: 'testclasses', source: tests(3) }),
      ]);
      expect(normalize(activeBeforeUpdate)).toBe(activeTests);
      expect(normalize(await client.source.read({ ...target, include: 'testclasses' }))).toBe(tests(3));

      const [activeBeforeFileWrite] = await Promise.all([
        client.source.read({ ...target, include: 'testclasses', version: 'active' }),
        client.repository.writeFile(testUri, tests(4)),
      ]);
      expect(normalize(activeBeforeFileWrite)).toBe(activeTests);
      expect(normalize(await client.repository.readFile(testUri))).toBe(tests(4));

      await client.lifecycle.update({ ...target, source: main('draft_method') });
      const [mainRead, includeRead, symbols] = await Promise.all([
        client.source.read({ ...target, version: 'active' }),
        client.source.read({ ...target, include: 'testclasses', version: 'active' }),
        client.navigation.documentSymbols(target),
      ]);
      expect(normalize(mainRead)).toBe(activeMain);
      expect(normalize(includeRead)).toBe(activeTests);
      expect(JSON.stringify(symbols)).toMatch(/draft_method/i);
      expect(normalize(await client.source.read(target))).toBe(main('draft_method'));

      const [beforeActivation, activated] = await Promise.all([
        client.source.read({ ...target, version: 'active' }),
        client.lifecycle.activate(target),
      ]);
      expect(normalize(beforeActivation)).toBe(activeMain);
      expect(activated.success).toBe(true);
      expect(normalize(await client.source.read({ ...target, version: 'active' }))).toBe(main('draft_method'));
      await client.lifecycle.delete(target);
      created = false;
    },
    200_000,
  );
});
