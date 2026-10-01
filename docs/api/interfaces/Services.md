# Interface: Services

Defined in: [api/services.ts:47](https://github.com/arc-mcp/adt-ls/blob/main/src/api/services.ts#L47)

Runtime + business-service surface (the `services` namespace).

## Methods

### runApplication()

> **runApplication**(`ref`): `Promise`\<\{ `output`: `string`; \}\>

Defined in: [api/services.ts:49](https://github.com/arc-mcp/adt-ls/blob/main/src/api/services.ts#L49)

Run an executable object (classrun / program) and return its console output.

#### Parameters

##### ref

[`ObjectRef`](ObjectRef.md)

#### Returns

`Promise`\<\{ `output`: `string`; \}\>

***

### serviceBindingDetails()

> **serviceBindingDetails**(`ref`): `Promise`\<`unknown`\>

Defined in: [api/services.ts:51](https://github.com/arc-mcp/adt-ls/blob/main/src/api/services.ts#L51)

Read a service binding's details (binding type, OData version, service list).

#### Parameters

##### ref

[`ObjectRef`](ObjectRef.md)

#### Returns

`Promise`\<`unknown`\>

***

### publishServiceBinding()

> **publishServiceBinding**(`ref`): `Promise`\<`unknown`\>

Defined in: [api/services.ts:53](https://github.com/arc-mcp/adt-ls/blob/main/src/api/services.ts#L53)

Publish (or unpublish) a service binding — mutating.

#### Parameters

##### ref

[`ObjectRef`](ObjectRef.md)

#### Returns

`Promise`\<`unknown`\>

***

### listServices()

> **listServices**(`ref`): `Promise`\<[`ServiceBindingServices`](ServiceBindingServices.md)\>

Defined in: [api/services.ts:55](https://github.com/arc-mcp/adt-ls/blob/main/src/api/services.ts#L55)

List the OData services a binding exposes (type, version, definitions, and the publish
state, which the backend reports for OData V4 only).

#### Parameters

##### ref

[`ObjectRef`](ObjectRef.md)

#### Returns

`Promise`\<[`ServiceBindingServices`](ServiceBindingServices.md)\>

***

### getServiceInfo()

> **getServiceInfo**(`ref`, `opts?`): `Promise`\<[`ServiceInfo`](ServiceInfo.md)\>

Defined in: [api/services.ts:59](https://github.com/arc-mcp/adt-ls/blob/main/src/api/services.ts#L59)

Live OData service info — the **service URL + entity sets** — for a binding's service
(chains fetch_services → fetch_service_information). For an unpublished binding this
throws asking you to publish first. `service` picks a specific service (default: first).

#### Parameters

##### ref

[`ObjectRef`](ObjectRef.md)

##### opts?

###### service?

`string`

#### Returns

`Promise`\<[`ServiceInfo`](ServiceInfo.md)\>
