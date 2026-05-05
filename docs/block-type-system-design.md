# Block Type System Design

## Why

The app already has typed properties, renderer/layout/action facets, and a
dynamic extension model. What is missing is a first-class way to say that a
block has one or more semantic roles.

Today, a block can carry a single `type` property such as `page`,
`daily-note`, or `extension`. Other behavior is inferred from content or
ad-hoc property checks. That works for isolated cases, but it does not model
blocks that naturally have multiple roles. A video can also be a task. A note
can also be a person, project, quote, source, or imported Roam TODO.

The type-system core should make those roles explicit and composable while
leaving existing extension facets responsible for behavior.

## Goals

- Store block types as additive semantic tags, not as an exclusive renderer
  choice.
- Let core and plugins define block types through a facet.
- Let types declare their fields through existing `PropertySchema`s.
- Let renderers, decorators, actions, layouts, importers, and queries key off
  type membership.
- Keep field values in the existing flat `properties` map.
- Keep the `Block` facade ergonomic without making it the registry or
  validation brain.
- Make Roam TODO import a proof case for type initialization and reimport
  semantics.

## Non-Goals

- Do not build a complete Tana clone in the first pass.
- Do not couple type definition to rendering. Rendering remains a facet-level
  behavior.
- Do not require migration compatibility for the current `type` string if the
  workspace can be dropped and recreated.
- Do not make dynamic extension blocks special outside the type system.

## Storage Model

Add a block-level property that stores all semantic types:

```ts
export const blockTypesProp = defineProperty<string[]>('block:types', {
  codec: codecs.list(codecs.string),
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
  kind: 'list',
})
```

All type fields remain regular properties:

```ts
block:types = ['task', 'video']
task:status = 'open'
task:due = '2026-05-10'
video:url = 'https://www.youtube.com/watch?v=...'
```

The old single `type` property can be removed in a drop-and-recreate world, or
kept only as a temporary compatibility alias until all call sites use
`block:types`.

## Type Definitions

Block types are contributed through a facet:

```ts
export interface BlockTypeDefinition {
  readonly id: string
  readonly label?: string
  readonly description?: string
  readonly fields?: readonly AnyPropertySchema[]
  readonly defaultValues?: ReadonlyMap<string, unknown> | Record<string, unknown>
  readonly setup?: BlockTypeSetup
  readonly importers?: readonly BlockTypeImporter[]
}

export interface BlockTypeSetupContext {
  readonly tx: Tx
  readonly id: string
  readonly definition: BlockTypeDefinition
}

export type BlockTypeSetup =
  (context: BlockTypeSetupContext) => void | Promise<void>

export interface BlockTypeImporter {
  readonly source: string
  readonly detect: (input: unknown) => boolean
}

export const defineBlockType = (
  definition: BlockTypeDefinition,
): BlockTypeDefinition => definition

export const blockTypesFacet = defineFacet<
  BlockTypeDefinition,
  ReadonlyMap<string, BlockTypeDefinition>
>({
  id: 'data.blockTypes',
  combine: values => {
    const out = new Map<string, BlockTypeDefinition>()
    for (const value of values) {
      if (out.has(value.id)) {
        console.warn(`[blockTypesFacet] duplicate registration for "${value.id}"; last-wins`)
      }
      out.set(value.id, value)
    }
    return out
  },
  empty: () => new Map(),
})
```

`fields` are property schemas owned by the type. They should also be registered
with `propertySchemasFacet` so the property panel, typed reads, and plugin code
see a single property-schema registry.

`defaultValues` and `setup` describe what should happen when the type is first
added to a block. Defaults should initialize missing values only; they should
not overwrite a user's existing property values.

## Pure Helpers

Type checks must be available without a live `Block` facade, because import
planning, tests, query code, and processors often work with raw `BlockData`.

```ts
export const getBlockTypes = (data: BlockData): readonly string[] => {
  const value = data.properties[blockTypesProp.name]
  return blockTypesProp.codec.decode(value ?? blockTypesProp.defaultValue)
}

export const hasBlockType = (
  data: BlockData,
  typeId: string,
): boolean => getBlockTypes(data).includes(typeId)

export const addBlockTypeToProperties = (
  properties: Record<string, unknown>,
  typeId: string,
): Record<string, unknown> => {
  const current = blockTypesProp.codec.decode(
    properties[blockTypesProp.name] ?? blockTypesProp.defaultValue,
  )
  if (current.includes(typeId)) return properties
  return {
    ...properties,
    [blockTypesProp.name]: blockTypesProp.codec.encode([...current, typeId]),
  }
}
```

These helpers are deliberately small. Registry resolution, setup, and mutation
belong in mutators.

## Mutators

Adding or removing a type should go through registered mutators. That keeps
undo behavior, read-only gating, default initialization, and future validation
consistent.

Suggested kernel mutators:

- `core.addBlockType({id, typeId})`
- `core.removeBlockType({id, typeId})`
- `core.toggleBlockType({id, typeId})`
- `core.setBlockTypes({id, typeIds})`

`core.addBlockType` should:

1. Resolve the type definition from `blockTypesFacet`.
2. Add `typeId` to `block:types` if absent.
3. Initialize declared defaults only where the property is absent.
4. Run optional setup logic.
5. Write the result in a single `ChangeScope.BlockDefault` transaction.

`core.removeBlockType` should only remove membership by default. It should not
delete type fields unless the caller explicitly asks for cleanup. Field data may
still be meaningful if the type is re-added or if another type shares a field.

## Block Facade API

The `Block` facade should expose ergonomic sugar over the pure helpers and
mutators:

```ts
block.types(): readonly string[]
block.hasType('task')
await block.addType('task')
await block.removeType('task')
await block.toggleType('task')
```

The facade should not own registry resolution, inheritance, validation,
importers, or query semantics. It should delegate writes to mutators:

```ts
async addType(typeId: string): Promise<void> {
  await this.repo.mutate['core.addBlockType']({id: this.id, typeId})
}
```

There probably does not need to be `block.setTypeField(...)`. Type fields are
normal typed properties:

```ts
await block.set(taskStatusProp, 'done')
```

The special operation is adding a type, because adding a type may initialize
defaults and run setup.

## Behavior Composition

Types declare semantic membership. Existing facets still declare behavior.

Examples:

- A task plugin contributes `task` through `blockTypesFacet`.
- It registers `task:status`, `task:due`, and `task:priority` through
  `propertySchemasFacet`.
- It contributes a checkbox row through `blockContentDecoratorsFacet`.
- It contributes task actions through `actionsFacet`.
- It contributes task queries through `queriesFacet`.

Renderers and decorators should check type membership:

```ts
blockContentDecoratorsFacet.of(ctx => {
  if (!ctx.block.hasType('task')) return null
  return TaskCheckboxDecorator
})
```

This preserves composition. A block can be both `task` and `video`; the video
layout and task checkbox can both apply if their facets are written to compose.

## Roam TODO Import

Roam TODO import should become the first concrete test of the model.

Source examples:

```md
{{[[TODO]]}} Call Alice
{{[[DONE]]}} Send invoice
```

Planned normalized shape:

```ts
content = 'Call Alice'
block:types = ['task']
task:status = 'open'
roam:todo-state = 'TODO'
```

```ts
content = 'Send invoice'
block:types = ['task']
task:status = 'done'
roam:todo-state = 'DONE'
```

The Roam marker should not remain as ordinary content unless we intentionally
want it visible. It should also not become the primary task model. The primary
model is `task:status`; `roam:todo-state` is imported-source metadata.

### Reimport Semantics

The current Roam importer upserts deterministic IDs. On an existing row it
replaces `content`, `properties`, and `references` with the planned import
shape. That is fine for a source-authoritative snapshot, but it is unsafe for
task state:

1. Roam export says `TODO`.
2. Import initializes `task:status = open`.
3. The user completes the task locally, setting `task:status = done`.
4. Reimporting the same old Roam export would plan `task:status = open` again.
5. A whole-property overwrite loses the user's completion.

First-pass rule:

- Roam import may always refresh `roam:*` source mirror fields.
- Type membership may be added if missing.
- App-owned fields like `task:status` should be initialized only if missing.
- Reimport should not overwrite app-owned fields that already exist.

Later rule:

- Track source fingerprints or last-imported values per imported field.
- Apply a source update only if the local value still equals the previous
  imported value.
- If local and source both changed, surface a conflict or keep local by policy.

## Query Model

The type system needs a query path for "blocks with type X" and eventually
"blocks with type X where field Y matches predicate Z".

First pass can add a kernel query:

```ts
repo.query.blocksByType({workspaceId, typeId})
```

For small graphs, this can scan `json_each(properties_json, '$."block:types"')`
or a JSON path equivalent. For large graphs, add a local side index similar to
the alias index:

```sql
block_type_memberships (
  workspace_id text not null,
  block_id text not null,
  type_id text not null,
  primary key (workspace_id, type_id, block_id)
)
```

Triggers keep it in sync from `properties_json`. Queries and invalidation then
use the side index instead of repeatedly scanning JSON.

Field predicates can stay plugin-specific until a real view/query layer exists.

## Type UI

The property panel should group fields by type:

- Core properties
- Task
- Video
- Extension
- Other registered types
- Unknown/unregistered properties

The block chrome can later expose an add/remove type control. That should use
the `blockTypesFacet` registry for autocomplete and labels, but it should call
the same mutators as programmatic code.

## Examples

### Task

```ts
export const taskStatusProp = defineProperty<'open' | 'done'>('task:status', {
  codec: taskStatusCodec,
  defaultValue: 'open',
  changeScope: ChangeScope.BlockDefault,
  kind: 'string',
})

export const taskBlockType = defineBlockType({
  id: 'task',
  label: 'Task',
  fields: [taskStatusProp, taskDueProp, taskPriorityProp],
  defaultValues: {
    [taskStatusProp.name]: 'open',
  },
})
```

### Video

Video can start as a type without forcing URLs out of content:

```ts
export const videoBlockType = defineBlockType({
  id: 'video',
  label: 'Video',
  fields: [videoPlayerViewProp],
})
```

The video renderer can initially keep `ReactPlayer.canPlay(block.content)` as
its recognizer and add `video` membership during import or explicit user action.
Later, `video:url` can become the canonical field if we want content to be
ordinary notes rather than the media URL.

### Extension

Dynamic extension blocks become regular typed blocks:

```ts
export const extensionBlockType = defineBlockType({
  id: 'extension',
  label: 'Extension',
  fields: [extensionDisabledProp],
})
```

`findExtensionBlocks` should query `block:types` membership instead of
`type = extension`.

## Tana-Like Features Left For Later

After additive types, type definitions, typed fields, type-aware mutators, and
query support land, the system will still be missing several deeper Tana-like
capabilities:

- Type inheritance, for example `book extends source`.
- Field cardinality, for example one value vs many values.
- Required fields and validation warnings.
- Typed references, for example `assignee` must reference a `person`.
- Default child templates.
- Computed fields.
- Type-specific views and saved queries.
- Schema evolution, including field rename, type rename, and field migration.
- Field-level permissions or source ownership.
- Import aliases, such as mapping Roam TODO/DONE to `task`.
- Conflict handling UI for reimport and sync.
- Cross-type constraints, such as every `task` under a `project` inheriting the
  project reference.

The first-pass core should leave room for these without implementing them.

## Implementation Slice

1. Add `blockTypesProp` and pure helpers.
2. Add `BlockTypeDefinition`, `defineBlockType`, and `blockTypesFacet`.
3. Add `core.addBlockType`, `core.removeBlockType`, and `core.setBlockTypes`.
4. Add small `Block` facade methods that delegate to mutators.
5. Convert `extension` discovery to type membership.
6. Add a `task` plugin/type with `task:status` and checkbox behavior.
7. Teach Roam import to normalize TODO/DONE into the task type.
8. Add `blocksByType` query and, if needed, a local membership index.

This gives the app a real type-system core while keeping behavior composable
through the facet model it already uses.
