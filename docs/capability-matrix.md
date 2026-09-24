# Capability matrix

What `@arc-mcp/adt-ls` exposes, which adt-ls call backs each method, and the
object-type boundary. Live-verified against a4h (S/4HANA 2023, adt-ls
`1.1.2.202608131517`). adt-ls has **two channels** — its own **MCP** server (federated)
and the **LSP** surface (`adtLs/*` + standard `textDocument/*`); the client hides which
one serves a call. Raw access: `adt.raw.tool(name,args)` (MCP) and
`adt.raw.lsp(method,params)` (LSP).

## API → adt-ls call

| Client method | Channel | adt-ls call |
|---|---|---|
| `capabilities()` | LSP + MCP | Initialization providers + fresh paginated `tools/list` (full descriptors) |
| `repository.search(pattern, {types,cold})` | LSP | `adtLs/repository/quickSearch` |
| `repository.getUsers()` | LSP | `adtLs/repository/getUsers` |
| `repository.getLsUri(adtUri)` | LSP | `adtLs/repository/getLsUri` |
| `repository.readFile / writeFile / delete` | LSP | `adtLs/fileSystem/{readFile,writeFile,delete}` |
| `repository.listInactive()` | LSP | `adtLs/activation/getInactiveObjects` |
| `source.read(ref)` | LSP | resolve → `fileSystem/readFile`; `version: 'active'` adds `fileSystem/abapStat` + `toggleVersion` around it |
| `repository.abapStat(uri)` | LSP | `adtLs/fileSystem/abapStat` |
| `lifecycle.create(ref)` | MCP | `abap_creation-create_object` |
| `lifecycle.update(ref)` | LSP | `fileSystem/writeFile` |
| `lifecycle.activate(ref, {forceActivation})` | LSP | `adtLs/activation/activate` (native — per-phase flags + diagnostics; **0.4.0**) |
| `lifecycle.runUnitTests(ref)` | MCP | `abap_run_unit_tests` |
| `lifecycle.delete(ref)` | LSP | `fileSystem/delete` (the `.json` metadata file) |
| `lifecycle.generate(...)` | MCP | `abap_generators-generate_objects` |
| `lifecycle.validate(...)` | MCP | `abap_creation-run_validation` |
| `lifecycle.listCreatableObjects / getObjectTypeDetails / listGenerators / getGeneratorSchema` | MCP | `abap_creation-*` / `abap_generators-*` |
| `lifecycle.getCreationForm(objectType)` | LSP | `adtLs/objectCreation/getCreationUiModelAndContent` (value-help types + name regex; **0.4.0**) |
| `navigation.documentSymbols / goToDefinition / goToDeclaration / findReferences / typeHierarchy / hover / documentHighlight / completion(+resolve) / checkSyntax` | LSP | `textDocument/*` (didOpen → query → didClose) |
| `navigation.format(ref)` | LSP | `textDocument/formatting` (ABAP Pretty-Printer, dyn-registered on didOpen; **0.4.0**) |
| `navigation.semanticTokens(ref)` | LSP | `textDocument/semanticTokens/full` → decoded via the legend (**0.4.0**) |
| `quality.runAtc / listAtcVariants` | LSP | `adtLs/atc/{runCheck,getCheckVariants}` |
| `quality.runUnitTestsWithCoverage` | LSP | `adtLs/abapUnit/runTests` + `adtLs/coverage/getCoverage` |
| `services.runApplication` | LSP | `adtLs/run/runApplication` |
| `services.serviceBindingDetails / publishServiceBinding` | LSP | `adtLs/businessservice/srvb/*` |
| `services.listServices / getServiceInfo` | MCP | `abap_business_services-{fetch_services,fetch_service_information}` (OData URL + entity sets; **0.4.0**) |
| `transport.find / create` | MCP | `abap_transport-{get,create}` (dynamic, backend-dependent) |
| `transport.assign / list / getLockStatus` | LSP | `adtLs/cts/transport/*`, `adtLs/fileSystem/getFileLockStatus` (always present) |
| `transport.getDiff(transportNumber, {cursor,pageSize})` | MCP | `abap_transport-unifiedDifference` (1–40 objects/page, opaque `nextCursor`) |
| `transport.check(ref, {operation})` | LSP | `adtLs/cts/transport/checkTransportForObjectLock` (decision oracle: needed? locked? assignable; **0.4.0**) |

## Object-type boundary (ADR-0012)

Object support depends on the runtime and backend. On **1.1.2/A4H**:

- Class source, SFLIGHT table-definition source (`.tabl.ddic`) and program source were
  read successfully. Full class create/update/activate/test/delete was exercised.
- The creation catalog includes CLAS, INTF, CDS/RAP types, PROG/P, PROG/I, FUGR/F,
  FUGR/FF, FUGR/I, TABL/DT, TABL/DS, ENQU/DL and TYPE/DG, among others.
- Catalog presence does not prove every operation works. Use `listCreatableObjects`,
  `getCreationForm` and actual reads. `additionalFields` supplies type-specific creation
  and validation values. Unsupported placeholders still produce a clear error.

The old assertion that all classic types are unusable is superseded. See the
[current survey](adt-ls-capabilities.md) for measured support and remaining boundaries.

## Notes & gotchas

- **Pin the adt-ls build.** The `adtLs/*` protocol is private/unpublished and can change;
  this release requires `sapse.adt-vscode 1.1.2` or newer and is verified against
  `1.1.2.202608131517`. Startup rejects older builds; `adt.health().adtLsVersion` reports
  the active build.
- **`transport.find/create` are dynamic** — they come from the connected system's MCP
  IDE-Actions and vary per backend/version; `transport.assign/list/getLockStatus` use the
  always-present native LSP path. Unknown dynamic tools are reachable via `raw.tool`.
- **Sessions die silently** on idle — the client heals transparently (probe + re-logon +
  activity-gated keep-alive); `health().backendLive` is the real readiness signal.
- **`$TMP`/local packages** are non-transportable; `transport.create` refuses them.

- **VFS startup is required:** the helper supplies `fileSystemMode: "VFS"`, restoring the
  current authoring tools. The minimum runtime is 1.1.2 because native contracts changed.
- **Native contract changes:** activation uses `fileUris` and returns `refreshFileUris`;
  coverage uses `uris`; inactive listing uses `destination`; deletion supplies options
  and confirms deletion of the enclosing object. See the [wire migration table](research/2026-09-11-current-adt-compatibility.md).
- **ATC quick fixes are now discoverable MCP tools.** Use the actual schemas via
  `capabilities()` and `raw.tool`; they are separate from unadvertised standard LSP code actions.
