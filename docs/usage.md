# Usage guide

`@arc-mcp/adt-ls` drives SAP's headless **adt-ls** (the `adt-lsc` language server from
the `sapse.adt-vscode` extension) and exposes it as one TypeScript client. This guide
covers connecting, authentication, the full API surface, resilience, logging, and
cleanup. For the auto-generated type reference see **[docs/api/](api/README.md)**; for
what adt-ls can/can't do headless see the **[capability matrix](capability-matrix.md)**.

- [Install & bring adt-ls](#install--bring-adt-ls)
- [Connecting](#connecting)
- [Authentication](#authentication)
- [The API](#the-api)
- [Health & resilience](#health--resilience)
- [Logging](#logging)
- [Errors & the object-type boundary](#errors--the-object-type-boundary)
- [Cleanup & multiple connections](#cleanup--multiple-connections)

## Install & bring adt-ls

```bash
npm install @arc-mcp/adt-ls
```

adt-ls is **not redistributable** (SAP Developer License), so you bring it. Either:

- install the **SAP ADT VS Code extension** (`sapse.adt-vscode`) in VS Code or Cursor — the
  library auto-discovers it; or
- extract it from a downloaded VSIX into `vendor/` with the bundled helper:
  `node node_modules/@arc-mcp/adt-ls/scripts/setup-adt-ls.mjs <path-to.vsix>`; or
- point at a binary explicitly via the `ADT_LS_PATH` env var or `createAdtLs({ adtLs: { path } })`.

Discovery order: `adtLs.path` / `ADT_LS_PATH` → `vendor/adt-ls/` → newest installed
`sapse.adt-vscode` (VS Code / Cursor / Insiders). adt-ls bundles its own SAP Machine JRE —
no separate Java needed. Supported targets: `darwin-arm64`, `darwin-x64`, `linux-x64`,
`win32-x64`.

## Connecting

`createAdtLs()` spawns one adt-ls process, logs on, starts adt-ls's MCP server, and
returns the client. adt-ls requires an **HTTPS** `systemUrl`.

```ts
import { createAdtLs, basic } from '@arc-mcp/adt-ls';

// Valid CA cert (e.g. SAP BTP ABAP) — no proxy, no truststore needed:
const adt = await createAdtLs({
  connection: { systemUrl: 'https://my-steampunk.abap.region.hana.ondemand.com', client: '100' },
  auth: bearer(myOauthToken),
});
```

### Self-signed on-prem (e.g. a4h)

On-prem systems often present a self-signed cert with a non-matching hostname. Set
`selfSigned: true` — the library augments the JVM truststore and runs a local
`CN=localhost` TLS reverse proxy so adt-ls trusts and hostname-matches it:

```ts
const adt = await createAdtLs({
  connection: { systemUrl: 'https://a4h.example.com:50001', selfSigned: true, client: '001' },
  auth: basic('MARIAN', process.env.SAP_PW!),
});
```

### Corporate CA

For a valid-but-private CA, add the root cert(s) to the truststore (no proxy):

```ts
connection: { systemUrl: 'https://s4.corp:44300', extraCaCerts: ['/etc/ssl/corp-root.pem'] }
```

### On-prem via SAP Cloud Connector

The library has no BTP/Cloud-Connector code itself — run your own forward proxy (the CC
bridge) and point the connection at it via `forwardProxy` (used together with
`selfSigned`):

```ts
connection: {
  systemUrl: 'https://backend.internal:44300',
  selfSigned: true,
  forwardProxy: { host: '127.0.0.1', port: bridge.port }, // your CC bridge
}
```

### Foundation mode (no SAP)

Omit `connection` + `auth` to start adt-ls + its MCP **without** a destination — useful
for `health()` or listing destinations. The destination-scoped namespaces then throw
`No ABAP destination is connected.` until you connect:

```ts
const adt = await createAdtLs({}); // adt-ls up, no destination
adt.health().connected; // false
```

## Authentication

The on-the-wire method is always a reentrance ticket; a **`LogonStrategy`** supplies the
credential used to obtain it. The library does **not** acquire OAuth tokens — you pass a
token (or a provider).

```ts
import { basic, bearer, interactive, custom } from '@arc-mcp/adt-ls';

basic('MARIAN', password);                 // on-prem fixed user (headless)
bearer(myToken);                           // BTP ABAP — a token value …
bearer(async () => fetchFreshToken());     // … or an async provider, resolved at logon
interactive({                              // human completes SSO (you own the UX)
  openUrl: (url) => open(url),             // open the browser
  promptField: async (f) => askUser(f),    // optional: answer adt-ls input prompts
});
custom((driver, ctx) => {                  // full escape hatch
  driver.setRequestHandler('adtLs/destinations/requestBrowserBasedLogon', myHandler);
});
```

For passwordless X.509 logon, use the exported `clientCert` strategy and its TLS proxy
(see the README). Native SNC/Kerberos integration remains the consumer's responsibility.

## The API

One client; the LSP-vs-MCP channel split is hidden. Escape hatches: `adt.raw.lsp()` /
`adt.raw.tool()`. Call `await adt.capabilities()` to inspect the current LSP providers and
MCP tool schemas. Object support depends on the installed runtime and backend; see the
[capability matrix](capability-matrix.md).

### repository — search, files, name→URI

```ts
const { references } = await adt.repository.search('ZCL_*', { types: ['CLAS/OC'], maxResults: 50 });
// SRVD/SRV, BDEF/BDO, DDLX/EX, NROB/NRO are searched by their main type (adt-ls can't filter them)
const users = await adt.repository.getUsers();
const inactive = await adt.repository.listInactive();
```

### source & lifecycle — the authoring loop

```ts
// read
const src = await adt.source.read({ name: 'ZCL_FOO', objectType: 'CLAS/OC' });
const tests = await adt.source.read({ name: 'ZCL_FOO', objectType: 'CLAS/OC', include: 'testclasses' });

// create → edit → activate → test → delete (supported object types)
await adt.lifecycle.create({ objectType: 'CLAS/OC', name: 'ZCL_BAR', packageName: '$TMP', description: 'demo' });
await adt.lifecycle.update({ name: 'ZCL_BAR', objectType: 'CLAS/OC', source: abapSource });
const act = await adt.lifecycle.activate({ name: 'ZCL_BAR', objectType: 'CLAS/OC' });
if (!act.success) console.error(act.diagnostics); // structured errors with ranges
await adt.lifecycle.runUnitTests({ name: 'ZCL_BAR', objectType: 'CLAS/OC' });
await adt.lifecycle.delete({ name: 'ZCL_BAR', objectType: 'CLAS/OC' });

// generators + validation
await adt.lifecycle.validate({ objectType: 'CLAS/OC', name: 'ZCL_X', packageName: '$TMP', description: 'x' });
await adt.lifecycle.generate({ generatorId: 'x-ui-service', content: jsonSchemaInput, packageName: 'ZPKG' });
```

For a transportable package, pass `transportRequestNumber` to `create` and use `adt.transport.*`.

### navigation — LSP code intelligence

```ts
const ref = { name: 'CL_ABAP_TYPEDESCR', objectType: 'CLAS/OC' };
await adt.navigation.documentSymbols(ref);
await adt.navigation.goToDefinition(ref, { symbol: 'describe_by_data' });
await adt.navigation.hover(ref, { line: 12, character: 8 }); // 1-based; or { symbol }
await adt.navigation.typeHierarchy(ref, { symbol: 'CL_ABAP_TYPEDESCR' }, { direction: 'both' });
await adt.navigation.checkSyntax(ref); // syntax check WITHOUT activating
await adt.navigation.completion(ref, { symbol: 'describe_by_data' });
await adt.navigation.completion(ref, { line: 20, character: 9 }, { resolve: true }); // enrich items: ABAP signatures + ABAP-Doc
const { formatted } = await adt.navigation.format(ref);     // ABAP Pretty-Printer (whole document)
const { tokens } = await adt.navigation.semanticTokens(ref); // decoded [{ line, character, length, tokenType, tokenModifiers[] }]
```

Position locators are a declared `symbol` name, or explicit 1-based `line` + `character`.

### quality — ATC + coverage

```ts
await adt.quality.runAtc(ref);                       // empty variant = system default
await adt.quality.listAtcVariants(ref);
await adt.quality.runUnitTestsWithCoverage(ref);     // { status, result, coverage }
```

### services — run + service bindings

```ts
const { output } = await adt.services.runApplication({ name: 'ZCL_RUN', objectType: 'CLAS/OC' });
await adt.services.serviceBindingDetails({ name: 'ZSB_FOO', objectType: 'SRVB/SVB' });
await adt.services.publishServiceBinding({ name: 'ZSB_FOO', objectType: 'SRVB/SVB' }); // mutating
await adt.services.listServices({ name: 'ZSB_FOO', objectType: 'SRVB/SVB' }); // OData version + service defs + publish state
const { serviceUrl, entitySets } = await adt.services.getServiceInfo({ name: 'ZSB_FOO', objectType: 'SRVB/SVB' });
// → live OData URL + entity sets (publish a V4 binding first). Uses the abap_business_services MCP tools.
```

### transport — CTS

```ts
await adt.transport.find({ objectName: 'ZCL_FOO', objectType: 'CLAS/OC', developmentPackage: 'ZPKG', isCreation: false });
await adt.transport.list({ limit: 50, query: 'me' });
await adt.transport.getLockStatus(ref);
// decision oracle: needs a transport? which are assignable? already locked? ($TMP → isRecordingRequired:false)
await adt.transport.check({ name: 'ZCL_FOO', objectType: 'CLAS/OC' }); // { operation: 'CREATE' | 'MODIFY' | 'DELETE' }
const tr = await adt.transport.create({ developmentPackage: 'ZPKG', transportDescription: 'feat', isCreation: true, objectName: 'ZCL_FOO', objectType: 'CLAS/OC' });
await adt.transport.assign({ name: 'ZCL_FOO', objectType: 'CLAS/OC', transport: 'DEVK900123' });
```

`lifecycle.activate` returns per-phase detail (`checkExecuted` / `activationExecuted` / `generationExecuted` /
`forceSupported` / `refreshedUris`) and accepts `{ forceActivation: true }`.

### raw — escape hatches

```ts
await adt.raw.lsp('textDocument/hover', { textDocument: { uri }, position });   // any LSP / adtLs/* request
await adt.raw.tool('abap_list_destinations', {});                              // any adt-ls MCP tool (use parseFederated to unwrap)
```

## Health & resilience

SAP sessions die silently on idle. The client heals transparently — cold-window retry,
dead-session revive (probe + re-logon), and an activity-gated keep-alive — so most code
needs no error handling for it. `health().backendLive` is the real readiness signal
(`connected` only reflects destination metadata).

```ts
const h = adt.health(); // { connected, backendLive, destination, adtLsName, adtLsVersion, mcpPort }
await adt.reconnect();  // force a re-logon (returns true when live)
```

## Logging

The library is **silent by default**. Opt in (stdout stays clean):

```ts
import { setLogger, stderrLogger } from '@arc-mcp/adt-ls';
setLogger(stderrLogger('[adt-ls]'));   // or pass your own { debug, info, warn, error }
```

## Errors & the object-type boundary

- Calling a destination-scoped method with no connection throws `No ABAP destination is connected.`
- Reading a type that the runtime/backend returns as an unsupported placeholder throws.
  Current runtimes also serve some classic types; consult the [capability matrix](capability-matrix.md).
- `create`/`generate`/`activate` reject with the backend message on failure; `activate`
  returns `success:false` + `diagnostics` for syntax errors (it does not throw).

## Cleanup & multiple connections

Always `dispose()` — it stops the keep-alive, kills adt-ls, closes the proxy, and removes
temp dirs:

```ts
try {
  /* … */
} finally {
  await adt.dispose();
}
```

Each `createAdtLs()` is **one** adt-ls process bound to **one** destination
([ADR-0010](adr/0010-process-isolation-model.md)). For several systems or per-user
identity, create several clients (and pick distinct `mcpPort`s, or rely on the automatic
port-fallback) — pooling is the consumer's concern.

## Runtime contracts and current ADT features

```ts
const { lsp, tools } = await adt.capabilities();
const diffTool = tools.find(t => t.name === 'abap_transport-unifiedDifference');
console.log(diffTool?.inputSchema, diffTool?.outputSchema, diffTool?.annotations);

// One page; pass the returned cursor according to the runtime's result schema.
const page = await adt.transport.getDiff('DEVK900001', { pageSize: 40 });
```

`capabilities()` queries all pages each time, so a changed destination/tool set is not
hidden by a stale cache. It returns a copy of the LSP initialization providers and the
complete MCP descriptors; dynamic LSP registrations (e.g. per-document formatting) are
not part of that initialization snapshot. New ATC fix/result tools are discoverable and
callable through `raw.tool`; availability alone does not establish backend support or
license entitlement.

Creation and validation now accept `additionalFields`, using the field names and legal
values returned by `getCreationForm` for the chosen type:

```ts
const form = await adt.lifecycle.getCreationForm('CLAS/OC');
const input = {
  objectType: 'CLAS/OC', name: 'ZCL_CHILD', packageName: '$TMP', description: 'Child class',
  additionalFields: { superclass: 'ZCL_PARENT' }, // must exist and permit inheritance
};
await adt.lifecycle.validate(input);
await adt.lifecycle.create(input);
```

The explicit name, package and description take precedence over matching keys in
`additionalFields`; transport stays a separate `transportRequestNumber` argument.
`lifecycle.delete` and `repository.delete` delete the enclosing object, including its
includes; the SDK supplies the confirmation required by the current file-system protocol.

MCP HTTP/RPC errors throw instead of becoming empty successful results. Raw tool-level
`isError` remains available to consumers. MCP requests time out after 120 seconds. An
expired MCP session is re-established, but the failed tool is **not automatically
replayed**; assess the operation before retrying. SAP logon recovery is a separate layer.

Dispose the client after use. Failed initialization now cleans up owned resources too.
A caller-supplied low-level `AdtLsDriver.dataDir` is preserved on disposal; temporary
SDK-created directories are removed.
