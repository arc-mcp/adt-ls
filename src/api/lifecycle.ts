import { parseFederated } from '../channels/federated.js';
/**
 * The ABAP object authoring lifecycle, pure adt-ls (ADR-0012): resolve an object by
 * name → repotree AFF URI, then read / create / update / activate / test / delete, plus
 * generators, validation, and CTS transport. Supported object types depend on the installed
 * runtime and backend; unsupported placeholders surface a clear error.
 *
 * The library does NOT gate writes or enforce package allowlists — that is the
 * consumer's policy layer (ADR-0012). The one guard kept here is a correctness guard
 * (refusing to orphan a transport for a local `$`-package), not a permission gate.
 */
import type { LspRequester } from '../driver.js';
import { isTransientColdError, withColdRetry } from '../resilience/cold-retry.js';
import { withWriteRetry } from '../resilience/session-retry.js';
import {
  type SearchReference,
  type SourceVersion,
  abapStat,
  deleteFile,
  getLsUri,
  includeAffUri,
  isUnsupportedPlaceholder,
  metadataAffUri,
  quickSearch,
  readFile,
  toggleVersion,
  writeFile,
} from './repository.js';

export interface ObjectRef {
  name: string;
  /** ADT type code, e.g. "CLAS/OC", "INTF/OI", "DDLS/DF". */
  objectType: string;
}
export interface ActivateResult {
  success: boolean;
  diagnostics: unknown[];
  /** Whether the syntax/consistency check ran (native `activation/activate`). */
  checkExecuted?: boolean;
  /** Whether activation actually ran. */
  activationExecuted?: boolean;
  /** Whether downstream generation ran (e.g. RAP artifacts). */
  generationExecuted?: boolean;
  /** Whether the backend supports `forceActivation` for this object. */
  forceSupported?: boolean;
  /** LS URIs the backend marked for refresh after activation. */
  refreshedUris?: string[];
}

/** One LSP-ish diagnostic looks error-severity (across the shapes ADT/LSP use). */
function isErrorDiagnostic(d: Record<string, unknown>): boolean {
  if (d.severity === 1 || d.severity === 'E' || d.severity === 'error') return true;
  return typeof d.type === 'string' && /error|abend/i.test(d.type);
}

/**
 * True if any activation diagnostic is error-severity. Native `activation/activate` nests
 * them as `{ lsUri, diagnostic: [{ range, severity, source, message }] }` (severity 1 =
 * error, verified live); we also tolerate a flat `{ severity }` shape defensively.
 */
function hasErrorDiagnostics(diags: unknown[]): boolean {
  return diags.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const o = entry as Record<string, unknown>;
    if (Array.isArray(o.diagnostic)) {
      return o.diagnostic.some(
        (d) => d != null && typeof d === 'object' && isErrorDiagnostic(d as Record<string, unknown>),
      );
    }
    return isErrorDiagnostic(o);
  });
}
/** A single transport-diff page, as returned by the current SAP MCP tool. */
export interface TransportDiffPage {
  batchInfo?: {
    currentBatchSize?: number;
    totalObjects?: number;
    processedCount?: number;
    remainingCount?: number;
    batchHasChanges?: boolean;
    status?: 'processing' | 'completed';
  };
  message?: string;
  nextCursor?: string;
  diffResult?: string;
}

export interface CreateResult {
  message?: string;
  filePath?: string;
}

/** One field of an object type's creation form (from the native UI model). Unlike the MCP
 * `getObjectTypeDetails` (just field names + required), this carries the **legal values**:
 * the value-help target object types, the name regex, and labels. */
export interface CreationField {
  /** Field key (the bindingPath, e.g. `packageName`, `superclass`, `referencedObject`). */
  path: string;
  label?: string;
  required: boolean;
  maxLength?: number;
  /** Validation regex (e.g. `^[A-Z0-9_/]*$` for `name`). */
  pattern?: string;
  /** ADT object types this field accepts (e.g. `superclass` → `["CLAS/OC"]`,
   * `referencedObject` → `["TABL/DT","STOB"]`). */
  valueHelpTypes?: string[];
}

export interface LifecycleDeps {
  driver: LspRequester;
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** The connected destination id, or undefined. */
  destination: () => string | undefined;
  /**
   * Heal a dead SAP session: probe liveness, re-logon if dead, resolve `true` iff it
   * re-logged on (so the caller retries). Optional — when omitted, the empty/error
   * simply surfaces. See `makeReviveIfDead`.
   */
  reviveIfDead?: () => Promise<boolean>;
}

export function createLifecycle(deps: LifecycleDeps) {
  const { driver, callTool } = deps;
  const dest = (): string => {
    const d = deps.destination();
    if (!d) throw new Error('No ABAP destination is connected.');
    return d;
  };

  /** Resolve {name, objectType} → repotree AFF URI (search → getLsUri). */
  async function resolveAffUri(ref: ObjectRef): Promise<string> {
    const d = dest();
    const doSearch = (type: string) =>
      quickSearch(driver, { destination: d, pattern: ref.name, maxResults: 20, types: [type] }, { cold: true });
    const findHit = (references: SearchReference[]) =>
      references.find((r) => r.name?.toUpperCase() === ref.name.toUpperCase() && r.uri);
    let { references } = await doSearch(ref.objectType);
    // Empty after cold-retry can also mean the SAP session DIED (idle-expired) — adt-ls
    // returns [] rather than "logged off". Probe + re-logon, then search once more before
    // declaring "not found". A genuinely-absent object: the probe finds the session alive
    // → no re-logon → we fall through to the not-found error below.
    if (references.length === 0 && deps.reviveIfDead && (await deps.reviveIfDead())) {
      ({ references } = await doSearch(ref.objectType));
    }
    let hit = findHit(references);
    // The search's type filter misses some subtyped refs (verified live on 1.1.2: `SRVD/SRV`
    // and `BDEF/BDO` find nothing, while the bare `SRVD` / `BDEF` finds the same object).
    // Retry once with the main type, only when the typed search found nothing at all; the
    // exact-name match still applies.
    const mainType = ref.objectType.split('/')[0];
    if (references.length === 0 && mainType && mainType !== ref.objectType) {
      hit = findHit((await doSearch(mainType)).references);
    }
    if (!hit?.uri) {
      throw new Error(`Object ${ref.name} (${ref.objectType}) not found via search.`);
    }
    return getLsUri(driver, d, hit.uri);
  }

  // An active-version read toggles adt-ls's session-wide requested version of the object, so
  // two of them must not interleave on one object. Keyed by the object's main AFF URI.
  const versionReads = new Map<string, Promise<unknown>>();
  function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (versionReads.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    versionReads.set(key, tail);
    void tail.then(() => {
      if (versionReads.get(key) === tail) versionReads.delete(key);
    });
    return run;
  }

  /**
   * Read `uri` in the object's active version. adt-ls serves the logged-on user's draft when
   * there is one; only then is the object toggled to active, read, and toggled back. Toggling
   * an object that already serves the active version would pin it there unnoticed (a later
   * draft from another session would stay hidden), so that case is a plain read.
   */
  function readActive(mainUri: string, uri: string): Promise<string> {
    return oneAtATime(mainUri, async () => {
      if ((await abapStat(driver, mainUri)) === 'active') return readFile(driver, uri);
      try {
        await toggleVersion(driver, mainUri);
        if ((await abapStat(driver, mainUri)) !== 'active') {
          throw new Error(`adt-ls did not switch ${mainUri} to the active version.`);
        }
        return await readFile(driver, uri);
      } finally {
        // A write in between switches adt-ls back to the draft by itself: toggle only if it
        // still serves the active version.
        if ((await abapStat(driver, mainUri)) === 'active') await toggleVersion(driver, mainUri);
      }
    });
  }

  return {
    resolveAffUri,

    async readSource(args: ObjectRef & { include?: string; version?: SourceVersion }): Promise<string> {
      const mainUri = await resolveAffUri(args);
      const uri = args.include ? includeAffUri(mainUri, args.include) : mainUri;
      const content = args.version === 'active' ? await readActive(mainUri, uri) : await readFile(driver, uri);
      if (isUnsupportedPlaceholder(content)) {
        throw new Error(
          `Object type ${args.objectType} is not served by adt-ls headless on this runtime/backend. Use Eclipse for this type or update SAPSE.adt-vscode.`,
        );
      }
      return content;
    },

    async createObject(args: {
      objectType: string;
      name: string;
      packageName: string;
      description: string;
      /** CTS transport for non-$TMP packages; `''` (default) for local objects. */
      transportRequestNumber?: string;
      additionalFields?: Record<string, unknown>;
    }): Promise<CreateResult> {
      const res = await callTool('abap_creation-create_object', {
        destination: dest(),
        objectType: args.objectType,
        // Type-specific fields augment the explicit identity; transport is a SEPARATE
        // top-level arg (adt-ls marks it required — '' means local/$TMP).
        objectContent: JSON.stringify({
          ...args.additionalFields,
          name: args.name,
          packageName: args.packageName,
          description: args.description,
        }),
        transportRequestNumber: args.transportRequestNumber ?? '',
      });
      const { ok, data, text } = parseFederated(res);
      if (!ok) throw new Error(`create_object failed: ${text}`);
      const d = data as CreateResult;
      return { message: d.message, filePath: d.filePath };
    },

    async updateSource(args: ObjectRef & { source: string; include?: string }): Promise<void> {
      let uri = await resolveAffUri(args);
      if (args.include) uri = includeAffUri(uri, args.include);
      // A write can race a session death (lock ok, PUT 500/423) — revive + retry once.
      await withWriteRetry(() => writeFile(driver, uri, args.source), deps.reviveIfDead);
    },

    /**
     * Activate the object via the native `adtLs/activation/activate` primitive (richer than
     * the MCP wrapper: per-phase flags, refresh URIs, optional `forceActivation`, and no
     * 15-object cap). `success` = activation ran with no error-severity diagnostics.
     */
    async activate(args: ObjectRef & { forceActivation?: boolean }): Promise<ActivateResult> {
      const uri = await resolveAffUri(args);
      const res = await withWriteRetry(
        () =>
          driver.sendRequest<{
            isCheckExecuted?: boolean;
            isActivationExecuted?: boolean;
            isGenerationExecuted?: boolean;
            isForceSupported?: boolean;
            refreshFileUris?: string[];
            objectDiagnostics?: unknown[];
          }>('adtLs/activation/activate', {
            destination: dest(),
            fileUris: [uri],
            references: [],
            forceActivation: args.forceActivation ?? false,
          }),
        deps.reviveIfDead,
      );
      const diagnostics = res?.objectDiagnostics ?? [];
      return {
        success: Boolean(res?.isActivationExecuted) && !hasErrorDiagnostics(diagnostics),
        diagnostics,
        checkExecuted: res?.isCheckExecuted,
        activationExecuted: res?.isActivationExecuted,
        generationExecuted: res?.isGenerationExecuted,
        forceSupported: res?.isForceSupported,
        refreshedUris: res?.refreshFileUris,
      };
    },

    async runUnitTests(args: ObjectRef): Promise<unknown> {
      const uri = await resolveAffUri(args);
      const res = await callTool('abap_run_unit_tests', { uris: [uri] });
      const { ok, data, text } = parseFederated(res);
      if (!ok) throw new Error(`run_unit_tests failed: ${text}`);
      // adt-ls returns a bare string ("No tests found") when there are no tests. Wrap it so
      // the result is always a JSON object — consistent with the rest of the toolset.
      return typeof data === 'string' ? { message: data } : data;
    },

    async deleteObject(args: ObjectRef): Promise<void> {
      const uri = await resolveAffUri(args);
      await withWriteRetry(() => deleteFile(driver, metadataAffUri(uri)), deps.reviveIfDead);
    },

    /**
     * Run a RAP generator (e.g. OData UI service): scaffolds a full set of objects
     * (table/CDS/BDEF/SRVD/SRVB) into `packageName`. `content` is the JSON string matching
     * the generator's get_schema.
     */
    async generateObjects(args: {
      generatorId: string;
      content: string;
      packageName: string;
      transportRequestNumber?: string;
      referencedObjectType?: string;
      referencedObjectName?: string;
    }): Promise<unknown> {
      const res = await callTool('abap_generators-generate_objects', {
        destination: dest(),
        generatorId: args.generatorId,
        content: args.content,
        packageName: args.packageName,
        transportRequestNumber: args.transportRequestNumber ?? '',
        referencedObjectType: args.referencedObjectType ?? '',
        referencedObjectName: args.referencedObjectName ?? '',
      });
      const { ok, data, text } = parseFederated(res);
      if (!ok) throw new Error(`generate_objects failed: ${text}`);
      return data;
    },

    /**
     * Validate an object's creation input before create (read-only). Returns the
     * validation verdict; a "would-be-invalid" result is data, not a thrown error.
     */
    async validateObject(args: {
      objectType: string;
      name: string;
      packageName: string;
      description: string;
      additionalFields?: Record<string, unknown>;
    }): Promise<unknown> {
      const res = await callTool('abap_creation-run_validation', {
        destination: dest(),
        objectType: args.objectType,
        objectContent: JSON.stringify({
          ...args.additionalFields,
          name: args.name,
          packageName: args.packageName,
          description: args.description,
        }),
      });
      return parseFederated(res).data;
    },

    /** List the object types you can create on this system (the ABAP-Cloud / RAP catalog). */
    async listCreatableObjects(): Promise<unknown> {
      return parseFederated(await callTool('abap_creation-get_all_creatable_objects', { destination: dest() })).data;
    },

    /** Creation details (required fields) for one object type, e.g. `"CLAS/OC"`. The flat MCP
     * field list (`{tag, required, maxLength}`); see `getCreationForm` for the legal values. */
    async getObjectTypeDetails(objectType: string, opts: { name?: string } = {}): Promise<unknown> {
      const res = await callTool('abap_creation-get_object_type_details', {
        destination: dest(),
        objectType,
        name: opts.name ?? 'Z_PLACEHOLDER',
      });
      return parseFederated(res).data;
    },

    /**
     * The full creation **form contract** for an object type — richer than
     * `getObjectTypeDetails`: each field's value-help target object types, name regex, label,
     * and required flag, parsed from the native `objectCreation/getCreationUiModelAndContent`
     * UI model. Use it to fill type-specific fields legally (e.g. a `DDLS/DF`'s
     * `referencedObject` must be a `TABL/DT`/`STOB`; a class `superclass` must be `CLAS/OC`).
     */
    async getCreationForm(
      objectType: string,
      opts: { name?: string } = {},
    ): Promise<{ objectType: string; fields: CreationField[] }> {
      const res = await driver.sendRequest<{ fieldGroupSections?: Array<{ uiModel?: string }> }>(
        'adtLs/objectCreation/getCreationUiModelAndContent',
        { name: opts.name ?? 'Z_PLACEHOLDER', description: '', objectType, destination: dest() },
      );
      const fields: CreationField[] = [];
      for (const section of res?.fieldGroupSections ?? []) {
        let model: { sections?: Array<{ controls?: Array<Record<string, unknown>> }> };
        try {
          model = JSON.parse(section.uiModel ?? '{}');
        } catch {
          continue;
        }
        for (const sec of model.sections ?? []) {
          for (const c of sec.controls ?? []) {
            const bindingPath = c.bindingPath as string | undefined;
            if (!bindingPath) continue;
            const field: CreationField = { path: bindingPath.replace(/^\$\./, ''), required: Boolean(c.required) };
            const label = (c.label as { text?: string } | undefined)?.text;
            if (label) field.label = label;
            if (typeof c.maxLength === 'number') field.maxLength = c.maxLength;
            if (typeof c.pattern === 'string') field.pattern = c.pattern;
            const vh = (c.onValueHelp as { adtTypes?: Array<{ value?: string }> } | undefined)?.adtTypes
              ?.map((a) => a.value)
              .filter((v): v is string => Boolean(v));
            if (vh?.length) field.valueHelpTypes = vh;
            fields.push(field);
          }
        }
      }
      return { objectType, fields };
    },

    /** List the available RAP generators (id + title) usable with `generateObjects`. */
    async listGenerators(): Promise<unknown> {
      return parseFederated(await callTool('abap_generators-list_generators', { destination: dest() })).data;
    },

    /** The JSON input schema a generator's `content` must satisfy (feed `generateObjects`). */
    async getGeneratorSchema(
      generatorId: string,
      opts: { packageName?: string; referencedObjectType?: string; referencedObjectName?: string } = {},
    ): Promise<unknown> {
      const res = await callTool('abap_generators-get_schema', {
        destination: dest(),
        generatorId,
        packageName: opts.packageName ?? '$TMP',
        referencedObjectType: opts.referencedObjectType ?? '',
        referencedObjectName: opts.referencedObjectName ?? '',
      });
      return parseFederated(res).data;
    },

    /**
     * Find the transport request(s) relevant to creating/changing ONE object (read-only
     * validation, object-scoped — not a system transport list). Throws on a backend
     * refusal (e.g. the object is locked in another client's task).
     */
    async findTransport(args: {
      objectName: string;
      objectType: string;
      developmentPackage: string;
      isCreation: boolean;
    }): Promise<unknown> {
      const res = await callTool('abap_transport-get', {
        destination: dest(),
        objectName: args.objectName,
        objectType: args.objectType,
        developmentPackage: args.developmentPackage,
        isCreation: args.isCreation,
      });
      const { ok, data, text } = parseFederated(res);
      // A successful tool response may have explanatory plain text and the result in
      // structuredContent. Require the fields in the tool's output schema so an unflagged
      // refusal does not become a successful, incomplete object.
      const result = data as {
        isRecordingRequired?: unknown;
        transportRequests?: unknown;
        informationMessages?: unknown;
      } | null;
      if (
        !ok ||
        !result ||
        typeof result !== 'object' ||
        Array.isArray(result) ||
        typeof result.isRecordingRequired !== 'boolean' ||
        !Array.isArray(result.transportRequests) ||
        !Array.isArray(result.informationMessages)
      ) {
        throw new Error(`find_transport failed: ${text}`);
      }
      return data;
    },

    /** One page of unified diffs; return the server cursor verbatim for the next call. */
    async getTransportDiff(
      transportNumber: string,
      opts: { cursor?: string; pageSize?: number } = {},
    ): Promise<TransportDiffPage> {
      const pageSize = opts.pageSize ?? 40;
      if (!transportNumber.trim()) throw new Error('transportNumber must not be empty');
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 40)
        throw new Error('pageSize must be an integer between 1 and 40');
      const result = await callTool('abap_transport-unifiedDifference', {
        destination: dest(),
        transportNumber,
        pageSize,
        ...(opts.cursor === undefined ? {} : { cursor: opts.cursor }),
      });
      const { ok, data, text } = parseFederated(result);
      if (!ok) throw new Error(`transport unifiedDifference failed: ${text}`);
      return data as TransportDiffPage;
    },

    /** Create a CTS transport request. */
    async createTransport(args: {
      developmentPackage: string;
      transportDescription: string;
      isCreation: boolean;
      objectName: string;
      objectType: string;
    }): Promise<unknown> {
      // Local ($-prefixed) packages are non-transportable — yet the backend would still
      // create a useless workbench TR (verified live), and there's no release/delete tool to
      // undo it. Refuse early; find_transport already reports isRecordingRequired:false.
      if (args.developmentPackage.trim().startsWith('$')) {
        throw new Error(
          `Package "${args.developmentPackage}" is local (non-transportable) — no transport is needed, so create_transport is a no-op that would orphan an empty request. Use findTransport to confirm; only call createTransport for transportable packages.`,
        );
      }
      const res = await callTool('abap_transport-create', {
        destination: dest(),
        developmentPackage: args.developmentPackage,
        transportDescription: args.transportDescription,
        isCreation: args.isCreation,
        objectName: args.objectName,
        objectType: args.objectType,
      });
      const { ok, data, text } = parseFederated(res);
      if (!ok) throw new Error(`create_transport failed: ${text}`);
      return data;
    },

    // ── Native CTS transport + lock (adtLs/cts/transport + adtLs/fileSystem) ──
    // The robust, always-present LSP path (vs the dynamic, backend-provided abap_transport-*
    // IDE-action tools).

    /**
     * List MY modifiable CTS transport requests on the connected system (native rich
     * search; owner defaults to the logged-on user, status to modifiable). Read-only. The
     * raw search can return thousands of rows — normalized to an array, optionally filtered
     * (client-side substring), and capped to `limit` (default 100).
     */
    async listTransports(opts: { limit?: number; query?: string } = {}): Promise<unknown> {
      // The CTS backend throws a transient "Internal error" both during the cold window AND
      // when the SAP session has DIED (idle-expired) — the latter never recovers by retry
      // alone. So: cold-retry first; if it still throws transient, revive + retry.
      const fetchRaw = () =>
        withColdRetry(
          () => driver.sendRequest<unknown>('adtLs/cts/transport/searchTransports', { destinationId: dest() }),
          { attempts: 3, delayMs: 500, retryError: isTransientColdError },
        );
      let raw: unknown;
      try {
        raw = await fetchRaw();
      } catch (e) {
        if (!isTransientColdError(e) || !deps.reviveIfDead) throw e;
        await deps.reviveIfDead(); // re-logon if the session is dead (else a harmless probe)
        raw = await fetchRaw();
      }
      const list: unknown[] = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as { transports?: unknown[] } | null)?.transports)
          ? (raw as { transports: unknown[] }).transports
          : Array.isArray((raw as { requests?: unknown[] } | null)?.requests)
            ? (raw as { requests: unknown[] }).requests
            : [];
      // Unrecognized non-array shape → return verbatim rather than silently hide data.
      if (list.length === 0 && !Array.isArray(raw)) return raw;
      const q = opts.query?.trim().toLowerCase();
      const matched = q ? list.filter((t) => JSON.stringify(t).toLowerCase().includes(q)) : list;
      const limit = opts.limit && opts.limit > 0 ? opts.limit : 100;
      const transports = matched.slice(0, limit);
      return {
        total: list.length,
        matched: matched.length,
        returned: transports.length,
        truncated: transports.length < matched.length,
        transports,
      };
    },

    /**
     * Transport decision oracle for an object: does this create/modify/delete need a
     * transport, which requests are assignable, and is it already locked? Read-only — the
     * native `checkTransportForObjectLock` that drives the lock→assign round-trip. For
     * `$TMP`/local objects `isRecordingRequired` is `false`. `operation` defaults to MODIFY.
     */
    async checkTransport(
      args: ObjectRef & {
        operation?: 'CREATE' | 'MODIFY' | 'DELETE';
        transportLayer?: string;
        recordChanges?: boolean;
      },
    ): Promise<unknown> {
      const objectUri = await resolveAffUri(args);
      return driver.sendRequest('adtLs/cts/transport/checkTransportForObjectLock', {
        operationType: args.operation ?? 'MODIFY',
        objectInfo: { objectUri },
        transportLayer: args.transportLayer ?? '',
        isRecordChanges: args.recordChanges ?? true,
      });
    },

    /** Read an object's lock status (`{lockingSupported, lockId}`; `lockId:null` when unlocked). */
    async getLockStatus(args: ObjectRef): Promise<{ lockingSupported: boolean; lockId: string | null }> {
      const uri = await resolveAffUri(args);
      const r = (await driver.sendRequest('adtLs/fileSystem/getFileLockStatus', { uri })) as {
        lockingSupported?: boolean;
        lockId?: string | null;
      } | null;
      return { lockingSupported: r?.lockingSupported ?? false, lockId: r?.lockId ?? null };
    },

    /**
     * Assign an existing CTS transport to an object — the native lock→transport step that
     * has NO federated (abap_transport-*) equivalent. `$TMP`/local objects need no transport.
     *
     * adt-ls answers `true` even for a transport that does not exist (verified live on
     * 1.1.2: nothing changed on SAP), so `assigned` is decided by reading the object's CTS
     * lock before and after. It is `true` when the lock now names `transport`, or when the
     * object was unlocked and now has a lock (a task number: the lock names its request).
     * `lockedIn` lists the request(s) the lock names afterwards. Assigning a task of the
     * request that already locks the object cannot be told apart from a no-op and reports
     * `false` — compare `lockedIn` with the task's request.
     */
    async assignTransport(args: ObjectRef & { transport: string }): Promise<{
      assigned: boolean;
      object: string;
      objectType: string;
      transport: string;
      lockedIn: string[];
    }> {
      const objectUri = await resolveAffUri(args);
      const readLocks = async (): Promise<string[]> => {
        const r = (await driver.sendRequest('adtLs/cts/transport/checkTransportForObjectLock', {
          operationType: 'MODIFY',
          objectInfo: { objectUri },
          transportLayer: '',
          isRecordChanges: true,
        })) as {
          isTransportCheckSuccessful?: boolean;
          isLockedInRequests?: boolean;
          locks?: Array<{ number?: string }>;
        } | null;
        if (!r || r.isTransportCheckSuccessful === false || (r.isLockedInRequests && !Array.isArray(r.locks))) {
          throw new Error(`Could not verify the CTS lock for ${args.name}.`);
        }
        const lockedIn = (r.locks ?? []).map((l) => l.number?.toUpperCase()).filter((n): n is string => Boolean(n));
        if (r.isLockedInRequests === true && lockedIn.length === 0) {
          throw new Error(`Could not verify the CTS lock for ${args.name}.`);
        }
        return lockedIn;
      };
      const before = await readLocks();
      const raw = await driver.sendRequest('adtLs/cts/transport/assignTransportToObject', {
        objectUri,
        transport: args.transport,
      });
      const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
      const executed = raw === true || obj?.assigned === true || obj?.operationExecuted === true;
      const lockedIn = await readLocks();
      const assigned =
        executed && lockedIn.length > 0 && (lockedIn.includes(args.transport.toUpperCase()) || before.length === 0);
      return { assigned, object: args.name, objectType: args.objectType, transport: args.transport, lockedIn };
    },
  };
}

export type Lifecycle = ReturnType<typeof createLifecycle>;
