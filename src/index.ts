/**
 * `@arc-mcp/adt-ls` — a generic TypeScript SDK over SAP's headless adt-ls (`adt-lsc`,
 * shipped in the `sapse.adt-vscode` extension). One unified, namespaced client over both
 * adt-ls channels (LSP + its own MCP); BYO binary; pluggable auth; cross-platform.
 *
 * Quickstart:
 * ```ts
 * import { createAdtLs, basic } from '@arc-mcp/adt-ls';
 * const adt = await createAdtLs({
 *   connection: { systemUrl: 'https://host:50001', selfSigned: true },
 *   auth: basic('MARIAN', process.env.SAP_PW!),
 * });
 * const hits = await adt.repository.search('CL_ABAP*');
 * await adt.dispose();
 * ```
 *
 * Full guide: {@link https://github.com/arc-mcp/adt-ls/blob/main/docs/usage.md | docs/usage.md}.
 */
export { createAdtLs } from './client.js';
export type { AdtLsCapabilities, AdtLsClient, ConnectionOptions, CreateAdtLsOptions, HealthInfo } from './client.js';

// Auth strategies (ADR-0003)
export { basic, bearer, clientCert, custom, interactive } from './auth/strategy.js';
export type { InteractiveCallbacks, LogonContext, LogonHandlerRegistrar, LogonStrategy } from './auth/strategy.js';

// Discovery (ADR-0004) — BYO adt-ls
export { defaultExtensionDirs, platformSubPath, resolveAdtLsPath } from './discovery.js';
export type { DiscoverOptions } from './discovery.js';

// Logging (silent by default)
export { setLogger, silentLogger, stderrLogger } from './log.js';
export type { Logger } from './log.js';

// Supported SAP ADT VS Code / adt-ls compatibility baseline.
export {
  MINIMUM_ADT_LS_VERSION,
  REQUIRED_SAPSE_ADT_VSCODE_VERSION,
  VERIFIED_ADT_LS_VERSION,
  assertSupportedAdtLsVersion,
  isSupportedAdtLsVersion,
  parseAdtLsVersion,
} from './version.js';

export type { ParsedAdtLsVersion } from './version.js';

// Federated MCP result unwrap (for consumers calling raw.tool directly)
export { parseFederated } from './channels/federated.js';
export type { McpTool } from './channels/mcp-federation.js';
export type { FederatedResult } from './channels/federated.js';

// Result / argument types + the per-namespace surfaces
export type { ActivateResult, CreateResult, CreationField, ObjectRef, TransportDiffPage } from './api/lifecycle.js';
export {
  applyTextEdits,
  decodeSemanticTokens,
} from './api/navigation.js';
export type {
  DecodedToken,
  Locator,
  Navigation,
  Position,
  SemanticTokensLegend,
  TextEdit,
} from './api/navigation.js';
export type { Quality } from './api/quality.js';
export type { ServiceBindingServices, ServiceInfo, Services } from './api/services.js';
export type { QuickSearchResult, SearchReference, SourceVersion, UserRef } from './api/repository.js';

// adt-ls's own MCP server lifecycle (start / stop / bind a destination). For consumers
// that PROXY adt-ls's MCP endpoint to external agents (the SDK also uses these internally).
export {
  setMcpDestination,
  startMcpServer,
  startMcpServerWithFallback,
  stopMcpServer,
} from './channels/mcp-lifecycle.js';
export type { StartMcpServerResult } from './channels/mcp-lifecycle.js';

// Advanced / escape hatches
export { AdtLsDriver, composeSpawnArgs } from './driver.js';
export type {
  AdtLsDriverOptions,
  AdtLsInitializeResult,
  LspClient,
  LspRequester,
  ServerRequestHandler,
} from './driver.js';
