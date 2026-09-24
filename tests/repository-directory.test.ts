/**
 * Unit tests for repository.readDirectory — the typed `fileSystem/readDirectory` wrapper.
 */
import { describe, expect, it, vi } from 'vitest';
import { readDirectory } from '../src/api/repository.js';
import type { LspRequester } from '../src/driver.js';

const PKG_DIR = 'abap:/repotree-v1/ADTLS/ZPKG/';

describe('repository.readDirectory', () => {
  it('sends the uri and maps FileType to kind', async () => {
    const driver = {
      sendRequest: vi.fn(async () => ({
        children: [
          { name: 'zpkg.devck.jsonc', type: 1 },
          { name: 'Source Code Library', type: 2 },
        ],
      })),
    } as unknown as LspRequester;
    expect(await readDirectory(driver, PKG_DIR)).toEqual([
      { name: 'zpkg.devck.jsonc', kind: 'file' },
      { name: 'Source Code Library', kind: 'directory' },
    ]);
    expect(driver.sendRequest).toHaveBeenCalledWith('adtLs/fileSystem/readDirectory', { uri: PKG_DIR });
  });

  it('returns [] when adt-ls sends no children', async () => {
    const driver = { sendRequest: vi.fn(async () => ({})) } as unknown as LspRequester;
    expect(await readDirectory(driver, `${PKG_DIR}zpkg.devck.jsonc`)).toEqual([]);
  });
});
