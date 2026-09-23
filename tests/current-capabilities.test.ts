import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createLifecycle } from '../src/api/lifecycle.js';
import { createQuality } from '../src/api/quality.js';
import { deleteFile, getInactiveObjects } from '../src/api/repository.js';
import type { LspRequester } from '../src/driver.js';

const payload = (data: unknown) => ({ content: [{ text: JSON.stringify(data) }] });
const transportResult = { isRecordingRequired: false, transportRequests: [], informationMessages: [] };
function setup() {
  const sendRequest = vi.fn(async <T>(method: string): Promise<T> => {
    if (method.endsWith('quickSearch')) return { references: [{ name: 'ZCL_TEST', uri: '/test' }] } as T;
    return { uri: 'abap:/zcl_test.clas.abap' } as T;
  });
  const callTool = vi.fn().mockResolvedValue(payload({ message: 'ok', filePath: 'abap:/x' }));
  const lc = createLifecycle({ driver: { sendRequest } as LspRequester, callTool, destination: () => 'DEV' });
  return { sendRequest, callTool, lc };
}

describe('current ADT capabilities', () => {
  it('forwards type-specific creation and validation fields while preserving explicit identity', async () => {
    const { lc, callTool } = setup();
    const args = {
      objectType: 'CLAS/OC',
      name: 'ZCL_TEST',
      packageName: '$TMP',
      description: 'test',
      additionalFields: { superclass: 'CL_PARENT', name: 'WRONG', packageName: 'WRONG' },
    };
    await lc.createObject(args);
    await lc.validateObject(args);
    for (const call of callTool.mock.calls) {
      expect(JSON.parse(call[1].objectContent)).toEqual({
        name: 'ZCL_TEST',
        packageName: '$TMP',
        description: 'test',
        superclass: 'CL_PARENT',
      });
    }
  });
  it('keeps transport diff pagination opaque and throws tool failures', async () => {
    const { lc, callTool } = setup();
    const page = { differences: ['diff'], nextCursor: 'next/+=' };
    callTool.mockResolvedValueOnce(payload(page));
    expect(await lc.getTransportDiff('DEVK900001', { cursor: 'opaque/+=', pageSize: 2 })).toEqual(page);
    expect(callTool).toHaveBeenCalledWith('abap_transport-unifiedDifference', {
      destination: 'DEV',
      transportNumber: 'DEVK900001',
      cursor: 'opaque/+=',
      pageSize: 2,
    });
    callTool.mockResolvedValueOnce({ isError: true, content: [{ text: 'Unsupported backend' }] });
    await expect(lc.getTransportDiff('DEVK900001')).rejects.toThrow(/Unsupported backend/);
    await expect(lc.getTransportDiff('')).rejects.toThrow(/empty/);
    await expect(lc.getTransportDiff('DEVK900001', { pageSize: 0 })).rejects.toThrow(/between 1 and 40/);
    await expect(lc.getTransportDiff('DEVK900001', { pageSize: 41 })).rejects.toThrow(/between 1 and 40/);
  });
  it('never substitutes a different search hit for the requested object', async () => {
    const { lc, sendRequest } = setup();
    sendRequest.mockResolvedValueOnce({ references: [{ name: 'ZCL_TEST_EXTRA', uri: '/other' }] });
    await expect(lc.deleteObject({ name: 'ZCL_TEST', objectType: 'CLAS/OC' })).rejects.toThrow(/not found/);
    expect(sendRequest).not.toHaveBeenCalledWith('adtLs/fileSystem/delete', expect.anything());
  });
  it('does not report failed unit-test tools as test results', async () => {
    const { lc, callTool } = setup();
    callTool.mockResolvedValueOnce({ isError: true, content: [{ text: 'Tests unavailable' }] });
    await expect(lc.runUnitTests({ name: 'ZCL_TEST', objectType: 'CLAS/OC' })).rejects.toThrow(/Tests unavailable/);
    expect(callTool).toHaveBeenCalledWith('abap_run_unit_tests', { uris: ['abap:/zcl_test.clas.abap'] });
  });
  it('uses the current native coverage and inactive-object parameter names', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({ result: { items: [] }, coverageParams: { coverageMeasurementUri: '/coverage' } })
      .mockResolvedValueOnce({ coverage: { statements: 1 } });
    const quality = createQuality({
      lsp: { sendRequest, sendNotification: vi.fn() },
      lifecycle: { resolveAffUri: async () => 'abap:/x' },
    });
    expect(await quality.runUnitTestsWithCoverage({ name: 'X', objectType: 'CLAS/OC' })).toMatchObject({
      coverage: { statements: 1 },
    });
    expect(sendRequest).toHaveBeenCalledWith('adtLs/abapUnit/runTests', { uris: ['abap:/x'], measurement: 'COVERAGE' });
    expect(sendRequest).toHaveBeenCalledWith('adtLs/coverage/getCoverage', { coverageMeasurementUri: '/coverage' });
    await deleteFile({ sendRequest }, 'abap:/x.clas.json');
    expect(sendRequest).toHaveBeenLastCalledWith('adtLs/fileSystem/delete', {
      uri: 'abap:/x.clas.json',
      options: { recursive: false, force: true },
    });
    await getInactiveObjects({ sendRequest }, 'DEV');
    expect(sendRequest).toHaveBeenLastCalledWith('adtLs/activation/getInactiveObjects', { destination: 'DEV' });
  });
});

describe('MCP requests against the captured SAP 1.1.2 schemas', () => {
  it('sends every required field and respects closed top-level schemas', async () => {
    const snapshot = JSON.parse(
      readFileSync(new URL('../docs/research/2026-09-11-adt-1.1.2-capabilities.json', import.meta.url), 'utf8'),
    );
    const { lc, callTool } = setup();
    const ref = { name: 'ZCL_TEST', objectType: 'CLAS/OC' };
    const creation = { ...ref, packageName: '$TMP', description: 'test' };
    await lc.createObject(creation);
    await lc.validateObject(creation);
    await lc.listCreatableObjects();
    await lc.getObjectTypeDetails(ref.objectType);
    await lc.listGenerators();
    await lc.getGeneratorSchema('example');
    await lc.generateObjects({ generatorId: 'example', content: '{}', packageName: '$TMP' });
    await lc.runUnitTests(ref);
    callTool.mockResolvedValueOnce(payload(transportResult));
    await lc.findTransport({
      objectName: ref.name,
      objectType: ref.objectType,
      developmentPackage: 'ZTEST',
      isCreation: false,
    });
    await lc.createTransport({
      objectName: ref.name,
      objectType: ref.objectType,
      developmentPackage: 'ZTEST',
      transportDescription: 'test',
      isCreation: true,
    });
    await lc.getTransportDiff('DEVK900001');
    for (const [name, args] of callTool.mock.calls) {
      const tool = snapshot.tools.find((t: { name: string }) => t.name === name);
      expect(tool, `missing captured contract for ${name}`).toBeTruthy();
      for (const key of tool.inputSchema.required ?? []) expect(args, `${name}: ${key}`).toHaveProperty(key);
      for (const [key, value] of Object.entries(args)) {
        const property = tool.inputSchema.properties[key];
        if (tool.inputSchema.additionalProperties === false)
          expect(property, `${name}: unexpected ${key}`).toBeTruthy();
        if (property?.type === 'integer') {
          expect(Number.isInteger(value)).toBe(true);
          if (property.minimum !== undefined) expect(value).toBeGreaterThanOrEqual(property.minimum);
          if (property.maximum !== undefined) expect(value).toBeLessThanOrEqual(property.maximum);
        } else if (['string', 'boolean'].includes(property?.type)) expect(typeof value).toBe(property.type);
      }
    }
  });
});

describe('lifecycle.findTransport', () => {
  const args = { objectName: 'ZR_X', objectType: 'BDEF/BDO', developmentPackage: 'ZTEST', isCreation: false };
  const refusal = 'Object ZR_X is locked in task DEVK900002, which is not specified for this client';

  it('returns the parsed answer', async () => {
    const { lc, callTool } = setup();
    callTool.mockResolvedValueOnce(payload(transportResult));
    await expect(lc.findTransport(args)).resolves.toEqual(transportResult);
  });

  it('throws on a tool error', async () => {
    const { lc, callTool } = setup();
    callTool.mockResolvedValueOnce({ content: [{ text: refusal }], isError: true });
    await expect(lc.findTransport(args)).rejects.toThrow(`find_transport failed: ${refusal}`);
  });

  it('throws on a plain-text refusal the tool did not flag as an error', async () => {
    const { lc, callTool } = setup();
    callTool.mockResolvedValueOnce({ content: [{ text: refusal }] });
    await expect(lc.findTransport(args)).rejects.toThrow(`find_transport failed: ${refusal}`);
  });

  it('rejects an incomplete structuredContent result alongside a refusal', async () => {
    const { lc, callTool } = setup();
    callTool.mockResolvedValueOnce({
      content: [{ text: refusal }],
      structuredContent: { isRecordingRequired: false },
    });
    await expect(lc.findTransport(args)).rejects.toThrow(`find_transport failed: ${refusal}`);
  });

  it('accepts explanatory plain text alongside a valid structuredContent result', async () => {
    const { lc, callTool } = setup();
    callTool.mockResolvedValueOnce({
      content: [{ text: 'A new transport request can also be created.' }],
      structuredContent: transportResult,
      isError: false,
    });
    await expect(lc.findTransport(args)).resolves.toEqual(transportResult);
  });
});
