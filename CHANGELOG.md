# Changelog

## [0.6.1](https://github.com/arc-mcp/adt-ls/compare/v0.6.0...v0.6.1) (2026-09-23)


### Bug Fixes

* use Node 24 for npm trusted publishing ([#21](https://github.com/arc-mcp/adt-ls/issues/21)) ([f9cb9b4](https://github.com/arc-mcp/adt-ls/commit/f9cb9b41277b760782acb1891a1b6f2f0afae4d1))

## [0.6.0](https://github.com/arc-mcp/adt-ls/compare/v0.5.0...v0.6.0) (2026-09-23)


### Features

* support current ADT 1.1.2 runtime contracts ([#8](https://github.com/arc-mcp/adt-ls/issues/8)) ([72f788e](https://github.com/arc-mcp/adt-ls/commit/72f788eaa98611f1c9ab8ea800a1c102d646b32e))


### Bug Fixes

* **auth:** send the destination client on ticket requests and honor the default client ([#15](https://github.com/arc-mcp/adt-ls/pull/15), [#16](https://github.com/arc-mcp/adt-ls/pull/16))
* **lifecycle:** resolve subtyped references through their main type ([#11](https://github.com/arc-mcp/adt-ls/pull/11))
* **lifecycle:** reject transport backend refusals and incomplete results ([#12](https://github.com/arc-mcp/adt-ls/pull/12), [#18](https://github.com/arc-mcp/adt-ls/pull/18))
* **services:** publish from binding details and reject empty bindings ([#14](https://github.com/arc-mcp/adt-ls/pull/14), [#17](https://github.com/arc-mcp/adt-ls/pull/17))
* **transport:** verify assignments against CTS locks and reject failed checks ([#13](https://github.com/arc-mcp/adt-ls/pull/13), [#20](https://github.com/arc-mcp/adt-ls/pull/20))

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
