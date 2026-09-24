# Interface: CreationField

Defined in: [api/lifecycle.ts:92](https://github.com/arc-mcp/adt-ls/blob/main/src/api/lifecycle.ts#L92)

One field of an object type's creation form (from the native UI model). Unlike the MCP
`getObjectTypeDetails` (just field names + required), this carries the **legal values**:
the value-help target object types, the name regex, and labels.

## Properties

### path

> **path**: `string`

Defined in: [api/lifecycle.ts:94](https://github.com/arc-mcp/adt-ls/blob/main/src/api/lifecycle.ts#L94)

Field key (the bindingPath, e.g. `packageName`, `superclass`, `referencedObject`).

***

### label?

> `optional` **label?**: `string`

Defined in: [api/lifecycle.ts:95](https://github.com/arc-mcp/adt-ls/blob/main/src/api/lifecycle.ts#L95)

***

### required

> **required**: `boolean`

Defined in: [api/lifecycle.ts:96](https://github.com/arc-mcp/adt-ls/blob/main/src/api/lifecycle.ts#L96)

***

### maxLength?

> `optional` **maxLength?**: `number`

Defined in: [api/lifecycle.ts:97](https://github.com/arc-mcp/adt-ls/blob/main/src/api/lifecycle.ts#L97)

***

### pattern?

> `optional` **pattern?**: `string`

Defined in: [api/lifecycle.ts:99](https://github.com/arc-mcp/adt-ls/blob/main/src/api/lifecycle.ts#L99)

Validation regex (e.g. `^[A-Z0-9_/]*$` for `name`).

***

### valueHelpTypes?

> `optional` **valueHelpTypes?**: `string`[]

Defined in: [api/lifecycle.ts:102](https://github.com/arc-mcp/adt-ls/blob/main/src/api/lifecycle.ts#L102)

ADT object types this field accepts (e.g. `superclass` → `["CLAS/OC"]`,
`referencedObject` → `["TABL/DT","STOB"]`).

***

### values?

> `optional` **values?**: `object`[]

Defined in: [api/lifecycle.ts:106](https://github.com/arc-mcp/adt-ls/blob/main/src/api/lifecycle.ts#L106)

The legal values of a choice field, e.g. an SRVB's `bindingType` → `OData V4 - UI`, …, or an
SRVD's `sourceType` → `S` (Definition) / `X` (Extension). Pass `value`, not `title`.

#### value

> **value**: `string`

#### title?

> `optional` **title?**: `string`
