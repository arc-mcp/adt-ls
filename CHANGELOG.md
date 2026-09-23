# Changelog

## [0.6.0](https://github.com/arc-mcp/adt-ls/compare/v0.5.0...v0.6.0) (2026-09-23)


### Features

* support current ADT 1.1.2 runtime contracts ([#8](https://github.com/arc-mcp/adt-ls/issues/8)) ([72f788e](https://github.com/arc-mcp/adt-ls/commit/72f788eaa98611f1c9ab8ea800a1c102d646b32e))


### Bug Fixes

* **auth:** apply the default client to ticket logon ([d522cc1](https://github.com/arc-mcp/adt-ls/commit/d522cc17832290b52fb9d4dd06e232cc8ce5f637))
* **auth:** send the destination client as sap-client on the ticket GET ([ad268d3](https://github.com/arc-mcp/adt-ls/commit/ad268d391a32ae0c7049b83d968982231dafa598))
* **auth:** send the destination client as sap-client on the ticket GET ([4c193dc](https://github.com/arc-mcp/adt-ls/commit/4c193dce32423904f253576323352c9fdae17378))
* **auth:** use the default destination client for ticket logon ([cf44216](https://github.com/arc-mcp/adt-ls/commit/cf44216c23a8234de872f9d638d291141f3a20ef))
* **lifecycle:** findTransport throws on a backend refusal ([d4be6d0](https://github.com/arc-mcp/adt-ls/commit/d4be6d0e7ce3c5b8bad5487a3335a68824e432c2))
* **lifecycle:** findTransport throws on a backend refusal ([2cfbdc2](https://github.com/arc-mcp/adt-ls/commit/2cfbdc22dba6612ed390b487deaf90fa817fdbfa))
* **lifecycle:** retry resolveAffUri with the main type for subtyped refs ([e5f00a7](https://github.com/arc-mcp/adt-ls/commit/e5f00a78e0fa02e01d3d173be9359818392ad2d0))
* **lifecycle:** retry resolveAffUri with the main type for subtyped refs ([28d219d](https://github.com/arc-mcp/adt-ls/commit/28d219d8cb7be22a9727ebb20a4d44c56e9a9567))
* **services:** align follow-up with live binding details ([cf4d2d7](https://github.com/arc-mcp/adt-ls/commit/cf4d2d72d14bc244defc49efa46ca28ab4641413))
* **services:** refuse publish when binding has no services ([ea221b7](https://github.com/arc-mcp/adt-ls/commit/ea221b75ac84fef3ce6a8da275b9ff10a02c61d1))
* **services:** send the full publish request from the binding details ([b43333e](https://github.com/arc-mcp/adt-ls/commit/b43333ee587c866053beea852de9f2899db76ac8))
* **services:** send the full publish request from the binding details ([19acee7](https://github.com/arc-mcp/adt-ls/commit/19acee766c6f154c2b58d1a10aa9c3e394d58589))
* **services:** use binding details and reject empty services ([1dc8eae](https://github.com/arc-mcp/adt-ls/commit/1dc8eaeff40d0e27d35d677a84565c9d357401cd))
* **transport:** confirm assign by reading the CTS lock back ([7c462a9](https://github.com/arc-mcp/adt-ls/commit/7c462a9e136f5536a038c63f6022bf292e20cb37))
* **transport:** confirm assign by reading the CTS lock back ([2ae12d9](https://github.com/arc-mcp/adt-ls/commit/2ae12d9ee9277f3c0dc9df27e6532bdfc5a7e29a))
* **transport:** fail assignment when CTS lock verification fails ([63ad595](https://github.com/arc-mcp/adt-ls/commit/63ad595c95afe1e9fff34cfae894ae30948464c7))
* **transport:** reject failed CTS lock readback ([d46b509](https://github.com/arc-mcp/adt-ls/commit/d46b5097ecfd6330571de72081760171b540f0ca))
* **transport:** reject inconsistent lock check results ([f233dfa](https://github.com/arc-mcp/adt-ls/commit/f233dfaaccd314e773d50998c8d3992287644294))
* **transport:** reject plain-text refusals with structured content ([9cafbb1](https://github.com/arc-mcp/adt-ls/commit/9cafbb11367e61d68dbd8bf828e1fe4afe87afb0))
* **transport:** validate structured find result against tool schema ([81f7503](https://github.com/arc-mcp/adt-ls/commit/81f75037b45f3ecfe66ed52185d384e378162062))
* **transport:** validate structured find result against tool schema ([9da158b](https://github.com/arc-mcp/adt-ls/commit/9da158bd8e27715c4b760239e39ff9642284d7b3))

## [0.5.0](https://github.com/marianfoo/adt-ls/compare/v0.4.2...v0.5.0) (2026-06-12)


### Features

* **auth:** clientCert — passwordless X.509 mutual-TLS logon ([#6](https://github.com/marianfoo/adt-ls/issues/6)) ([1f13553](https://github.com/marianfoo/adt-ls/commit/1f135535555e9c0e2831eb07a6f67f2ad71b808e))

## [0.4.2](https://github.com/marianfoo/adt-ls/compare/v0.4.1...v0.4.2) (2026-06-12)


### Bug Fixes

* require adt-ls 1.0.1 baseline ([f1853a0](https://github.com/marianfoo/adt-ls/commit/f1853a03fe9c7cadfd4cb7f5abb75726c40976a0))

## [0.4.1](https://github.com/marianfoo/adt-ls/compare/v0.4.0...v0.4.1) (2026-06-11)


### Bug Fixes

* **resilience:** revive + retry a stateful write that races a session death ([#3](https://github.com/marianfoo/adt-ls/issues/3)) ([557f1ff](https://github.com/marianfoo/adt-ls/commit/557f1ffd62dd21e500c6e1f74c7da8c7ccf1c04e))

## [0.4.0](https://github.com/marianfoo/adt-ls/compare/v0.3.0...v0.4.0) (2026-06-08)


### Features

* **lifecycle:** getCreationForm — per-field legal values (value-help types + name regex) ([96977e1](https://github.com/marianfoo/adt-ls/commit/96977e1b2aeea2ea26a6dde38f020045e7ac5512))
* live-verified capabilities — formatting, native activate, transport check, completion resolve, semanticTokens ([5049f1a](https://github.com/marianfoo/adt-ls/commit/5049f1af8b5a0234527f6d1ffbd57e671da32bf9))
* **services:** SRVB service info — listServices + getServiceInfo (OData URL + entity sets) ([048e406](https://github.com/marianfoo/adt-ls/commit/048e4068b3e1465369905ea77a3c1e7cfd737c9d))


### Bug Fixes

* **resilience:** self-heal repository.search + raw.tool/LSP on session loss; honest backendLive ([af2d272](https://github.com/marianfoo/adt-ls/commit/af2d272d83967bb7e386952ace11a04e70e78523))

## [0.3.0](https://github.com/marianfoo/adt-ls/compare/v0.2.0...v0.3.0) (2026-06-08)


### Features

* typed metadata methods (destinations, creatable objects, generators) ([0b5fa19](https://github.com/marianfoo/adt-ls/commit/0b5fa194152fd163dc3647d186aff375500ad579))
