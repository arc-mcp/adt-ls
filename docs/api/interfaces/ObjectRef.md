# Interface: ObjectRef

Defined in: [api/lifecycle.ts:26](https://github.com/arc-mcp/adt-ls/blob/main/src/api/lifecycle.ts#L26)

## Properties

### name

> **name**: `string`

Defined in: [api/lifecycle.ts:27](https://github.com/arc-mcp/adt-ls/blob/main/src/api/lifecycle.ts#L27)

***

### objectType

> **objectType**: `string`

Defined in: [api/lifecycle.ts:29](https://github.com/arc-mcp/adt-ls/blob/main/src/api/lifecycle.ts#L29)

ADT type code, e.g. "CLAS/OC", "INTF/OI", "DDLS/DF".

***

### uri?

> `optional` **uri?**: `string`

Defined in: [api/lifecycle.ts:38](https://github.com/arc-mcp/adt-ls/blob/main/src/api/lifecycle.ts#L38)

The object's repotree AFF URI (its main file), e.g. `filePath` from `lifecycle.create` or a
previous `resolveAffUri`. When set, calls use it instead of searching by name, which saves
the search round trips and doesn't depend on the search index. It must belong to the
connected destination. `name` and `objectType` are still required: service-binding calls
look the binding up by name, and results and errors name the object.
