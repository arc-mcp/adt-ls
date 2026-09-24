/**
 * Read-only repository queries over LSP, plus AFF-URI helpers + file ops. Verified
 * headless against a4h. The name→URI resolver chain (search → getLsUri) is the key
 * enabler for by-name operations. See docs (capability map).
 */
import type { LspRequester } from '../driver.js';
import { isTransientColdError, withColdRetry } from '../resilience/cold-retry.js';

/** A repository object hit from quickSearch. `uri` is the ADT object path. */
export interface SearchReference {
  name: string;
  description?: string;
  type?: string;
  uri?: string;
}

export interface QuickSearchResult {
  references: SearchReference[];
  message?: { label?: string; detail?: string; severity?: number };
}

/**
 * Repository object search (SAPSearch). NOTE the exact param names adt-ls wants: the
 * search string is `pattern` (NOT `query`) and `destination` (NOT `destinationId`);
 * `types` filters by object type (empty = all).
 *
 * `cold` (default false) applies the cold-backend retry: the first query after a fresh
 * connection (or post-idle) can return [] OR throw a transient "Internal error" while
 * adt-ls warms its repository index.
 */
export function quickSearch(
  driver: LspRequester,
  params: { destination: string; pattern: string; maxResults?: number; types?: string[] },
  opts: { cold?: boolean } = {},
): Promise<QuickSearchResult> {
  const run = () =>
    driver.sendRequest<QuickSearchResult>('adtLs/repository/quickSearch', {
      destination: params.destination,
      pattern: params.pattern,
      maxResults: params.maxResults ?? 50,
      types: params.types ?? [],
    });
  if (!opts.cold) return run();
  return withColdRetry(run, {
    attempts: 3,
    delayMs: 500,
    retryResult: (r) => (r.references?.length ?? 0) === 0,
    retryError: isTransientColdError,
  });
}

/**
 * Run a search; if it comes back empty AND `reviveIfDead` resurrects a dead SAP session,
 * retry once. An idle-expired session returns `[]` (not "logged off"), so a first search
 * after idle can be a false negative; `reviveIfDead` probes a known object and only
 * re-logs-on if the session is actually dead (a genuine no-match leaves it alone). Pure
 * orchestration — the same self-heal `lifecycle.resolveAffUri` applies to name lookups.
 */
export async function searchWithRevive(
  run: () => Promise<QuickSearchResult>,
  reviveIfDead?: () => Promise<boolean>,
): Promise<QuickSearchResult> {
  let r = await run();
  if ((r.references?.length ?? 0) === 0 && reviveIfDead && (await reviveIfDead())) {
    r = await run();
  }
  return r;
}

/** List inactive (draft) objects on a destination. */
export function getInactiveObjects(driver: LspRequester, destinationId: string): Promise<unknown[]> {
  return driver.sendRequest<unknown[]>('adtLs/activation/getInactiveObjects', { destination: destinationId });
}

/**
 * Resolve an ADT path (from a search result) to the canonical repotree AFF URI that
 * readFile/writeFile/activate need. Param key MUST be `adtUri` (verified).
 */
export async function getLsUri(driver: LspRequester, destination: string, adtUri: string): Promise<string> {
  const r = await driver.sendRequest<{ uri?: string }>('adtLs/repository/getLsUri', { destination, adtUri });
  if (!r.uri) throw new Error(`getLsUri returned no uri for ${adtUri}`);
  return r.uri;
}

/** Read an AFF file's content (the object source) by its repotree URI. */
export async function readFile(driver: LspRequester, uri: string): Promise<string> {
  const r = await driver.sendRequest<{ content?: string }>('adtLs/fileSystem/readFile', { uri });
  return r.content ?? '';
}

/** Write an AFF file (update source). `content` must be plain multi-line text. */
export function writeFile(driver: LspRequester, uri: string, content: string): Promise<unknown> {
  return driver.sendRequest('adtLs/fileSystem/writeFile', { uri, content });
}

/** An object version: the active one, or the logged-on user's inactive draft. */
export type SourceVersion = 'active' | 'inactive';

/**
 * Which version adt-ls serves for the object at `uri` in this session (`fileSystem/abapStat`):
 * `inactive` when the logged-on user has a draft of it, else `active`. Another user's draft is
 * never served. `toggleVersion` changes it for this session only.
 */
export async function abapStat(driver: LspRequester, uri: string): Promise<SourceVersion> {
  const r = await driver.sendRequest<{ version?: number }>('adtLs/fileSystem/abapStat', { uri });
  if (r?.version === 0) return 'active';
  if (r?.version === 1) return 'inactive';
  throw new Error(`abapStat returned no version for ${uri}`);
}

/**
 * Flip the version adt-ls serves for the object at `uri` and all its related files (a class's
 * includes), for this adt-ls session only; nothing changes on SAP. With no draft of the
 * logged-on user there is nothing to flip to. A write to the object switches it back to the
 * draft, so decide any way back with `abapStat`, never by counting toggles.
 */
export function toggleVersion(driver: LspRequester, uri: string): Promise<unknown> {
  return driver.sendRequest('adtLs/fileSystem/toggleVersion', { uri });
}

/** Delete the enclosing object via its AFF metadata (`.json`) URI.
 * `force` confirms whole-object deletion (required by 1.1.2, error 1003 otherwise). */
export function deleteFile(driver: LspRequester, uri: string): Promise<unknown> {
  return driver.sendRequest('adtLs/fileSystem/delete', { uri, options: { recursive: false, force: true } });
}

/** adt-ls returns this placeholder (not source) for object types it can't serve headless. */
export function isUnsupportedPlaceholder(content: string): boolean {
  return /not supported in ADT in VS Code/i.test(content);
}

/** Swap a class main-source AFF URI to one of its include files (CCDEF/CCIMP/…). */
export function includeAffUri(mainAffUri: string, include: string): string {
  // …/zcl_x.clas.abap → …/zcl_x.clas.<include>.abap
  return mainAffUri.replace(/\.clas\.abap$/, `.clas.${include}.abap`);
}

/** Derive the AFF metadata (`.json`) URI from a main-source AFF URI (final ext → json). */
export function metadataAffUri(mainAffUri: string): string {
  return mainAffUri.replace(/\.[^./]+$/, '.json');
}

/** A repository/system user. */
export interface UserRef {
  id: string;
  text?: string;
}

/** List system users (e.g. for ownership/transport context). Uses `destination`. */
export async function getUsers(driver: LspRequester, destination: string): Promise<UserRef[]> {
  const r = await driver.sendRequest<{ users?: UserRef[] }>('adtLs/repository/getUsers', { destination });
  return r.users ?? [];
}
