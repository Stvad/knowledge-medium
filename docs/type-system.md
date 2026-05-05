# Tana-style type system

## Goal

Unify the ad-hoc `type` strings already in use (`extension`, `page`, `panel`, `journal`, `daily-note`) with the future need for user-modelable types (todo, task, project, person, note-with-fields...) under one principled abstraction. Types are facet contributions; a block can carry multiple types; named relationships ride on the existing references pipeline.

The first downstream consumer is **importing Roam todos**: `#TODO`/`#DONE` tags map to `types += 'todo'` + `status = 'open'/'done'` via the importer's tag-mapping table.

## Background — what already exists

These pieces are load-bearing and the design composes them, not replaces them:

- **`typeProp`** ([src/data/properties.ts:106](src/data/properties.ts:106)) — a `string | undefined` prop named `type`. Set today to `'extension'` (extension blocks, [exampleExtensions.ts:309](src/extensions/exampleExtensions.ts:309), [agent-runtime/commands.ts:189](src/plugins/agent-runtime/commands.ts:189)), `'page'` (Roam import + plan, [roamImport/import.ts:836](src/utils/roamImport/import.ts:836), [roamImport/plan.ts:562](src/utils/roamImport/plan.ts:562)), `'panel'` ([LayoutRenderer.tsx:74](src/components/renderer/LayoutRenderer.tsx:74), [:120](src/components/renderer/LayoutRenderer.tsx:120)), `'journal'` and `'daily-note'` ([dailyNotes.ts:86](src/data/dailyNotes.ts:86), [:159](src/data/dailyNotes.ts:159)).
- **`rendererProp`** ([src/data/properties.ts:113](src/data/properties.ts:113)) — explicit per-block renderer-id override. Read by [useRendererRegistry.tsx:22](src/hooks/useRendererRegistry.tsx:22).
- **`PropertySchema<T>`** ([src/data/api/propertySchema.ts:16](src/data/api/propertySchema.ts:16)) — typed property with codec, default, change-scope, and a `kind` for unknown-schema fallback.
- **`PropertyUiContribution<T>`** ([src/data/api/propertySchema.ts:33](src/data/api/propertySchema.ts:33)) — React `Editor` / `Renderer` joined to a schema by `name`. Already used by `grouped-backlinks` ([plugins/grouped-backlinks/index.ts:21](src/plugins/grouped-backlinks/index.ts:21)).
- **`propertySchemasFacet` / `propertyUiFacet`** ([src/data/facets.ts:114](src/data/facets.ts:114), [:131](src/data/facets.ts:131)) — registries keyed by `name`, last-wins on duplicates.
- **`blockRenderersFacet`** ([src/extensions/core.ts](src/extensions/core.ts)) — renderer registry with `id` + optional `aliases`; `BlockRenderer` supports `canRender` / `priority` for dynamic dispatch ([src/types.ts:65](src/types.ts:65)).
- **`BlockData.references: BlockReference[]`** ([src/data/api/blockData.ts:26](src/data/api/blockData.ts:26)) — content-derived (parsed from `[[alias]]` and `((uuid))`) by the `backlinks.parseReferences` post-commit processor ([src/plugins/backlinks/referencesProcessor.ts](src/plugins/backlinks/referencesProcessor.ts)). `BlockReference = { id, alias }` ([src/data/api/blockData.ts:4](src/data/api/blockData.ts:4)).
- **`AppExtension`** + facets — plugins contribute via `someFacet.of(contribution, {source})` ([video-player/index.ts](src/plugins/video-player/index.ts) is a good template).
- **`appEffectsFacet`** ([src/extensions/core.ts](src/extensions/core.ts)) — long-lived runtime effects with cleanup, used here for the data-defined-types watcher.

## Design

### 1. `typesFacet` — contributions, no imperative API

Add a new facet alongside the existing data-layer facets in `src/data/facets.ts`:

```ts
export interface TypeContribution {
  /** Stable id; matches the string written into the block's `types` array. */
  readonly id: string
  /** Properties that apply to blocks of this type. Drives field discovery
   *  in BlockProperties and the property panel. Use `AnyPropertySchema`
   *  (`PropertySchema<any>`) — `PropertySchema<T>` is invariant in this
   *  repo's variance model, mirroring `AnyMutator` / `AnyQuery`, so
   *  `PropertySchema<unknown>` will not accept real typed schemas like
   *  `PropertySchema<string>`. See [src/data/api/propertySchema.ts:90](src/data/api/propertySchema.ts:90). */
  readonly properties?: ReadonlyArray<AnyPropertySchema>
  /** Renderer id (looked up against blockRenderersFacet) used when a block
   *  is rendered *solely* by virtue of having this type — i.e. the block
   *  IS this thing (video-player, panel, type-definition). The common
   *  case for type-driven UI is *decoration*, not full-renderer
   *  replacement (todo checkbox, due-date chip, status badge); see §4
   *  for the type/decoration split. Leave undefined unless the type
   *  takes over the whole block presentation. */
  readonly defaultRenderer?: string
  /** Type-conditional defaults. Applied by the `addType(block, typeId)`
   *  mutator (§3a) — both at instance creation *and* whenever a type is
   *  added to an existing block. Keys are property names, values are
   *  decoded values run through the matching schema's codec. */
  readonly defaults?: Readonly<Record<string, unknown>>
  /** Renderer dispatch priority when a block has multiple types.
   *  Higher wins. `rendererProp` always overrides everything. */
  readonly priority?: number
  /** Tana-style supertag aliases — extra strings that map to this type
   *  (importer convenience: `'task'` → `'todo'`). */
  readonly aliases?: ReadonlyArray<string>
  /** Optional human label for the property panel / quick-find. */
  readonly label?: string
}

export const typesFacet = defineFacet<TypeContribution, ReadonlyMap<string, TypeContribution>>({
  id: 'data.types',
  combine: (values) => {
    const out = new Map<string, TypeContribution>()
    for (const t of values) {
      if (out.has(t.id)) {
        console.warn(`[typesFacet] duplicate registration for "${t.id}"; last-wins per facet convention`)
      }
      out.set(t.id, t)
      for (const a of t.aliases ?? []) out.set(a, t)
    }
    return out
  },
  empty: () => new Map(),
})
```

No `defineType()` helper. Plugins contribute the same way as today: `typesFacet.of({id: 'todo', ...}, {source: 'todo-plugin'})`.

### 2. Multi-type: `typesProp` replaces `typeProp` as the primary discriminator

Add a new schema and migrate single-string usage to it. Per [feedback_no_backcompat_in_alpha](../.claude/projects/-Users-vlad-coding-knowledge-knowledge-medium-knowledge-medium/memory/feedback_no_backcompat_in_alpha.md), no shim — one-shot data migration, drop `typeProp` after.

```ts
// src/data/properties.ts
export const typesProp = defineProperty<readonly string[]>('types', {
  codec: codecs.list(codecs.string),
  defaultValue: [],
  changeScope: ChangeScope.Default,
  kind: 'list',
})
```

`KERNEL_PROPERTY_SCHEMAS` includes `typesProp`; `typeProp` is removed. All current writers ([dailyNotes.ts](src/data/dailyNotes.ts), [LayoutRenderer.tsx](src/components/renderer/LayoutRenderer.tsx), [roamImport/import.ts](src/utils/roamImport/import.ts), [roamImport/plan.ts](src/utils/roamImport/plan.ts), [initData.ts](src/initData.ts), [exampleExtensions.ts](src/extensions/exampleExtensions.ts), [agent-runtime/commands.ts](src/plugins/agent-runtime/commands.ts)) switch from `typeProp.codec.encode('foo')` / `tx.setProperty(id, typeProp, 'foo')` to `typesProp` writes.

A one-shot migration backfills existing rows: any block with `properties.type` writes `properties.types = [oldValue]` and clears `type`. Land it as a kernel `LocalSchemaBackfill` on `propertySchemasFacet` plumbing (same mechanism that already exists for kernel migrations — see [src/data/facets.ts:21](src/data/facets.ts:21) `LocalSchemaBackfill`).

#### 2a. SQL / index migration — type lookup must move off `$.type`

Today's by-type lookup is SQL, not just property reads. Three call sites touch it:

- `idx_blocks_workspace_type` ([src/data/blockSchema.ts:111](src/data/blockSchema.ts:111)) — composite index on `(workspace_id, json_extract(properties_json, '$.type'))`.
- `SELECT_BLOCKS_BY_TYPE_SQL` ([src/data/internals/kernelQueries.ts:33](src/data/internals/kernelQueries.ts:33)) — generic `WHERE json_extract(properties_json, '$.type') = ?`.
- `findExtensionBlocksQuery` ([src/data/internals/kernelQueries.ts:384](src/data/internals/kernelQueries.ts:384)) — runs at every workspace bootstrap and on every extension change.

Switching to `types: string[]` breaks `=`-comparison; SQLite expression indexes can't directly index array membership. The right shape is a trigger-maintained side table, mirroring the `block_references` design at [src/plugins/backlinks/localSchema.ts](src/plugins/backlinks/localSchema.ts):

```sql
CREATE TABLE IF NOT EXISTS block_types (
  block_id     TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  type         TEXT NOT NULL,
  PRIMARY KEY (block_id, type)
);
CREATE INDEX IF NOT EXISTS idx_block_types_type_workspace
  ON block_types (type, workspace_id);
```

Triggers on `INSERT`, `UPDATE OF properties_json, deleted, workspace_id`, and `DELETE` walk `json_each(json_extract(properties_json, '$.types'))` and rewrite the rows for `block_id`. `SELECT_BLOCKS_BY_TYPE_SQL` becomes a join (`SELECT b.* FROM blocks b JOIN block_types t ON t.block_id = b.id WHERE t.workspace_id = ? AND t.type = ? AND b.deleted = 0`); `idx_blocks_workspace_type` is dropped. A one-shot backfill marker (`block_types_backfill_v1`, same pattern as `block_references_backfill_v1`) populates `block_types` from existing `properties_json.types` on first launch after migration.

This local-schema delta lives in the kernel, not in a plugin, since extension discovery (`findExtensionBlocks`) is bootstrap-critical and must not depend on plugin load order.

### 3. Field reuse — props are global, type-conditional bits live on the type

Reuse `PropertySchema` as the field primitive. A type *curates* which props apply to its instances rather than namespacing fields. This matches how Roam works (`priority::` is `priority::` regardless of tags) and keeps the property registry as a single shared vocabulary.

The two pieces that *would* have wanted namespacing instead live on the type contribution:

- **Type-conditional defaults** → `TypeContribution.defaults`. A `todo`'s `status='open'` and a `meeting`'s `status='scheduled'` are declared by their respective types, not the prop schema.
- **Per-type ref-target hints** → carried on the type contribution alongside the property reference (see §5). The codec is a single shared `refList`; the *hint* of "for this type, the picker should suggest Task-typed targets" lives on the type.

If two types ever want a same-named field with **incompatible codecs**, the rule is to pick distinct names (`todoStatus` vs `meetingStatus`). Don't pre-pay for fully-namespaced fields.

#### 3a. `addType` / `removeType` mutators — defaults apply on add, not just creation

Defaults at *creation* aren't enough. The common motion is "tag this existing block as a `todo`" — that block needs `status='open'` materialised so `where: {status: 'open'}` queries match. Without a central place to apply defaults, every writer (importer, command, agent action) has to remember to do it, and missed sites silently degrade query results.

Add two kernel mutators:

```ts
// repo.mutate.addType
async function addType(tx: Tx, args: { blockId: string; typeId: string }) {
  const block = await tx.read(args.blockId)
  const types = (block.properties[typesProp.name] as string[] | undefined) ?? []
  if (types.includes(args.typeId)) return
  const contribution = runtime.read(typesFacet).get(args.typeId)
  // Apply only defaults the block doesn't already have set.
  const defaults = contribution?.defaults ?? {}
  const newProps: Record<string, unknown> = { ...block.properties }
  newProps[typesProp.name] = typesProp.codec.encode([...types, args.typeId])
  for (const [name, value] of Object.entries(defaults)) {
    if (newProps[name] === undefined) {
      const schema = runtime.read(propertySchemasFacet).get(name)
      newProps[name] = schema ? schema.codec.encode(value) : value
    }
  }
  await tx.update(args.blockId, { properties: newProps })
}

// repo.mutate.removeType
async function removeType(tx: Tx, args: { blockId: string; typeId: string }) {
  // v1: just remove from `types`. Don't try to clean up properties —
  // determining which properties were "owned" by this type vs. set by
  // the user is ambiguous. Document the leak; revisit if it bites.
}
```

Every tag-mapping path (Roam importer, agent commands, command-palette "Add tag" action) goes through `addType`. Direct writes to `typesProp` are discouraged — add a lint or an engine guard if needed.

A *read-time overlay* (defaults synthesised on read when a block has the type but lacks the property) is the alternative — but it diverges queries from storage and complicates the typed-query backing in §8. Prefer the materialise-on-add approach.

**`Block` facade sugar** mirrors the existing `get`/`set`/`setContent`/`delete` pattern at [src/data/block.ts:159](src/data/block.ts:159)–[:228](src/data/block.ts:228):

```ts
get types(): readonly string[] {
  return this.peekProperty(typesProp) ?? []
}
hasType(typeId: string): boolean {
  return this.types.includes(typeId)
}
async addType(typeId: string): Promise<void> {
  await this.repo.mutate.addType({blockId: this.id, typeId})
}
async removeType(typeId: string): Promise<void> {
  await this.repo.mutate.removeType({blockId: this.id, typeId})
}
```

`block.hasType('todo')` is the canonical guard at every type-decoration call site (replaces `block.peekProperty(typesProp)?.includes('todo')`). No `setTypes(array)` sugar — the bulk path is the importer's, and going through `tx.update` keeps the "defaults-on-add" semantics explicit at that one site rather than implied by an atomic-looking facade method.

#### 3b. Multi-type interactions over shared property schemas

When two types share a property schema (the common case under §3's reuse model), how the per-type bits combine matters. The rules:

- **Field discovery (which props apply to a block).** Union of every `TypeContribution.properties` across the block's types, deduped by `name`. If `todo` and `task` both list `statusProp`, the property panel shows `status` once.
- **Codec.** A property has one codec globally — `propertySchemasFacet` is keyed by `name` and last-wins on duplicates. Multi-type doesn't change that. If two types want truly incompatible codecs, pick distinct names (the §3 rule).
- **Defaults — first-writer-wins, order-dependent.** `todo.defaults={status:'open'}` and `task.defaults={status:'todo'}` on a block with neither set: `addType('todo')` then `addType('task')` → `status='open'` (the second `addType` sees the property already set and skips). Reverse order → `status='todo'`. Bulk-write paths (importer setting `types=['todo','task']` in one shot) must iterate in array order with the same first-wins rule. The order types appear in `typesProp` is therefore semantically load-bearing for default conflicts. This is intuitive (the type tagged first wins) but worth pinning.
- **`refTargets` for a shared ref-prop.** Multi-type combine is **union** — `Project.refTargets={tasks:['task']}` + `Person.refTargets={tasks:['activity']}` on a block tagged both means the picker offers `task | activity`. Empty union after merging → fall back to "any type." Intersection would yield an empty picker as soon as two types disagreed; permission unions are the right combine here.
- **`defaultRenderer`.** Priority arbitration in §4b. Most types contribute none, so multi-type collisions are rare by construction.
- **Decorations / headers / click handlers (§4a).** Stack natively — every contribution's non-falsy return is applied in contribution order. Multi-type decoration is the easy path; this is the main reason to prefer decorations over renderer-replacement.
- **Validation (deferred follow-up).** When it lands, validations across types **intersect** — a value must satisfy *all* applicable types' constraints. Constraints restrict; if any type forbids, it's forbidden. Opposite combine rule from `refTargets`, which permits.
- **`removeType` when a prop is contributed by multiple types.** v1 leaves `block.properties` untouched. If `status` was contributed by both `todo` and `task` and you remove `todo`, `task` still contributes `statusProp` so the panel still shows it. If `status` was *only* contributed by the removed type, the value stays in `block.properties` but disappears from the type-driven panel — inert until re-tagged or manually edited. v1 accepts this leak; revisit if it bites.

### 4. Type-driven UI: decorations are the common case, full-renderer replacement is the exception

Most type-driven UI is *decoration* layered on the existing block content rendering — a `todo` adds a checkbox + strikethrough-when-done, a `priority=high` block adds a colored chip, a `due` field adds a date pill. Only a few types want to take over the entire block presentation (`video-player`, `panel`, `type-definition`). The design splits cleanly along that axis.

#### 4a. Decorations, headers, click handlers — via existing facets with a type-guard

The block-interaction facets in [src/extensions/blockInteraction.ts](src/extensions/blockInteraction.ts) (`blockContentDecoratorsFacet`, `blockHeaderFacet`, `blockChildrenFooterFacet`, `blockClickHandlersFacet`, `blockContentSurfacePropsFacet`, `blockLayoutFacet`) already have the right shape: each contribution is a function `(BlockResolveContext) => Contribution | null | undefined | false`, and returning a falsy value opts the block out. `BlockResolveContext` carries `block: Block`, so a type-bound contribution simply reads `typesProp` and bails when its type isn't present. **No new slot on `TypeContribution` is needed.**

The convention for type-driven decoration: a type contribution registers its decorators/headers/etc. into the existing facets via the same `AppExtension` array as everything else, gating each on `block.hasType(typeId)` (the §3a facade sugar). Example for `todo`:

```ts
const todoCheckboxDecorator: BlockContentDecoratorContribution = ({block}) => {
  if (!block.hasType('todo')) return null
  return (Inner) => (props) => (
    <>
      <TodoCheckbox blockId={props.block.id} />
      <Inner {...props} />
    </>
  )
}

export const todoPlugin: AppExtension = [
  typesFacet.of({id: 'todo', properties: [statusProp], defaults: {[statusProp.name]: 'open'}}, {source: 'todo'}),
  blockContentDecoratorsFacet.of(todoCheckboxDecorator, {source: 'todo'}),
  // optionally: header chip when overdue, click handler on the checkbox, etc.
]
```

This composes naturally under multi-type: each contributing type's decorations stack (all opt-in returns are collected and applied in contribution order), and there's no priority arbitration to do.

A small ergonomics improvement worth considering once a few types ship: a helper `whenHasType(typeId, contribution)` that does the guard. Don't pre-build it; extract from real call sites.

#### 4b. Full-renderer replacement — for "this block IS this type"

For the rare types that want to replace the entire renderer (video-player, panel, type-definition), `TypeContribution.defaultRenderer` drives dispatch. Update [src/hooks/useRendererRegistry.tsx](src/hooks/useRendererRegistry.tsx) so the resolution order becomes:

1. `rendererProp` set on the block → use that id verbatim.
2. Else read `typesProp`; for each id, look up the `TypeContribution` in `typesFacet`, collect each `defaultRenderer` with its `priority`. Highest-priority wins. Most types contribute no `defaultRenderer` and don't enter the contest.
3. Else fall through to the existing `canRender` / `priority` dynamic-dispatch path on `blockRenderersFacet`.
4. Else default renderer.

Multi-type composition concern is restricted to this path: when two types both claim a `defaultRenderer`, the higher `priority` wins. Avoidable in practice — most types should contribute decorations, leaving renderer-replacement to types where the block genuinely *is* the thing.

Existing `aliases` on `RendererContribution` continues to work for renderer-id resolution (it's about the renderer registry, not types).

### 5. Ref codecs — `codecs.ref`, `codecs.refList`

Today's codec set ([src/data/api/codecs.ts:73](src/data/api/codecs.ts:73)) is `string, number, boolean, date, optional, list, unsafeIdentity`. Add:

```ts
// Storage: a string block id. The codec exists so the data layer can
// recognise ref-bearing properties without per-block scanning, and so
// editor lookup in propertyUiFacet can default to a ref picker.
export const ref: () => Codec<string>             // single ref (block id)
export const refList: () => Codec<readonly string[]>  // list of refs
```

Both are tagged so `isRefCodec(codec)` and `isRefListCodec(codec)` return true at runtime — the projector in §7 needs to identify them. Add a `kind: 'ref' | 'refList'` to `PropertyKind` in [propertySchema.ts:5](src/data/api/propertySchema.ts:5) so the unknown-schema fallback editor can render a stub picker.

Schemas declare ref properties like:

```ts
export const projectTasksProp = defineProperty<readonly string[]>('tasks', {
  codec: codecs.refList(),
  defaultValue: [],
  kind: 'refList',
  changeScope: ChangeScope.Default,
})
```

The *target-type filter* for the picker UI lives on the type contribution (because two types may share a ref-prop name with different target types):

```ts
typesFacet.of({
  id: 'project',
  properties: [projectTasksProp],
  refTargets: { tasks: ['task'] },   // picker filter for this type's `tasks`
  ...
})
```

`refTargets` is `Record<propertyName, readonly TypeId[]>` on `TypeContribution`. Empty/missing means any type.

### 6. Schema delta: `BlockReference.sourceField`, plus `block_references` edge index

Two coordinated changes — the JSON shape *and* the trigger-maintained edge index that backlinks queries actually read.

#### 6a. `BlockReference` shape

`BlockReference` ([src/data/api/blockData.ts:4](src/data/api/blockData.ts:4)) gains an optional `sourceField`:

```ts
export interface BlockReference {
  readonly id: string
  readonly alias: string
  /** Property name that produced this reference. Absent when the
   *  reference was parsed from `content` (`[[alias]]` / `((uuid))`).
   *  Set when projected from a typed property whose codec is
   *  `ref`/`refList`. Drives named-backlinks. */
  readonly sourceField?: string
}
```

No back-compat shim. Existing content-derived rows simply have `sourceField` undefined.

#### 6b. `block_references` edge index — add `source_field` to PK

Backlinks/grouped-backlinks queries don't read `references_json` directly — they query the trigger-maintained `block_references` edge index built in [src/plugins/backlinks/localSchema.ts](src/plugins/backlinks/localSchema.ts). Today its PK is `(source_id, target_id, alias)`, which would collapse two property refs from the same source to the same target via different fields, and offers no way for grouped-backlinks to group by field name.

Schema delta:

```sql
CREATE TABLE IF NOT EXISTS block_references (
  source_id    TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  alias        TEXT NOT NULL,
  source_field TEXT NOT NULL DEFAULT '',   -- '' for content-derived
  PRIMARY KEY (source_id, target_id, alias, source_field)
);
```

The triggers (`blocks_references_insert`, `blocks_references_update`, the backfill `BACKFILL_BLOCK_REFERENCES_SQL`) all extend their `INSERT OR IGNORE` to read `json_extract(je.value, '$.sourceField')` and write it (coalesced to `''`) into the new column. The backlinks plugin's `InvalidationRule` for `block_references` already watches the table; the rule shape doesn't change because we're just adding a column to an existing table the rule already covers — verify against [src/plugins/backlinks/localSchema.ts](src/plugins/backlinks/localSchema.ts) at implementation time.

Existing rows (PK collisions on the new schema are impossible since old rows were content-derived with `source_field=''` by construction). The migration is a `CREATE TABLE block_references_new ... INSERT INTO block_references_new SELECT ..., '' FROM block_references; DROP TABLE block_references; ALTER TABLE block_references_new RENAME TO block_references` sequence, gated by a `block_references_source_field_v1` marker.

### 7. Extend `backlinks.parseReferences` to also project property refs

The existing post-commit processor ([src/plugins/backlinks/referencesProcessor.ts](src/plugins/backlinks/referencesProcessor.ts)) currently watches `{ kind: 'field', table: 'blocks', fields: ['content'] }` and rewrites `references[]` from parsed content. Extend it:

- Watch list expands to `fields: ['content', 'properties']`.
- After parsing content refs (existing path), iterate the block's `properties`. For each entry whose `PropertySchema.codec` is a ref-codec or ref-list codec (looked up via `propertySchemasFacet`), decode and emit one `BlockReference { id, alias: id, sourceField: propName }` per ref.
- Concatenate content-derived + property-derived into the new `references[]` and write through the same `tx.update(sourceId, {references}, {skipMetadata: true})`. The triggers from §6b copy `sourceField` into `block_references`.

Ordering / dedupe: identical `(id, sourceField)` pairs are deduped; content refs (no `sourceField`) and property refs (with `sourceField`) coexist for the same target — they represent different relationships.

#### 7a. ProcessorCtx must expose property schemas

Today `ProcessorCtx = { db, repo }` ([src/data/api/processor.ts:110](src/data/api/processor.ts:110)). Looking up `PropertySchema.codec` to identify ref-bearing properties needs the schema registry, which currently lives on `FacetRuntime` and isn't reachable from a processor.

The simpler patch: extend `ProcessorCtx` with a slot:

```ts
export interface ProcessorCtx {
  db: ProcessorReadDb
  repo: Repo
  /** Property-schema registry from the active runtime. Lets processors
   *  look up a property's codec — needed by `backlinks.parseReferences`
   *  to recognise ref-codec properties. */
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>
}
```

`processorRunner` ([src/data/internals/processorRunner.ts:226](src/data/internals/processorRunner.ts:226)) builds `ctx`; it gets the schema map from the same runtime path that `repo.setFacetRuntime` already propagates. The map is captured at ctx-construction time so a mid-flight runtime swap doesn't change what a running processor sees.

Alternative considered: hold a full `FacetRuntime` on `ctx`. Rejected — too broad a surface for a processor and pulls in extension-runtime dependencies the data layer otherwise doesn't need.

`grouped-backlinks` ([src/plugins/grouped-backlinks/](src/plugins/grouped-backlinks/)) gains a grouping mode keyed on `source_field` so a target block sees:

> Referenced by `tasks` from: [Project A] [Project B]
> Referenced by `relatedTo` from: [Note X]
> Mentioned in: [Daily 2026-05-04] [Inbox]   ← content-derived (`source_field=''`)

### 8. Reactive typed-query primitive — SQLite-backed

The kernel today exposes per-block traversal + content-ref backlinks. To support typed inboxes / agendas / "all open todos" without per-consumer indexing, add a `Repo` query API:

```ts
interface TypedQuery {
  readonly types?: readonly string[]                    // any-of (multi-type contains-any)
  readonly where?: Readonly<Record<string, unknown>>    // equality on decoded property values
  readonly referencedBy?: { id: string; sourceField?: string }
}

// On Repo:
//   repo.queryBlocks(q): Promise<BlockData[]>
//   repo.subscribeBlocks(q, (rows) => ...): () => void
```

**Backed by local SQLite, not an in-memory index.** This app receives row changes via two paths — local tx commit *and* the row-events tail from PowerSync sync-apply. An in-memory index would have to be initialised from a full table scan at startup AND wired to both commit and sync-apply streams, with care to not double-count or miss either. The `block_types` side table (§2a) and the `block_references` edge index (§6b) already live in SQLite and are maintained by triggers that fire on **all** writes to `blocks`, sync-applied or not. Reuse them:

- `types`-only queries → join `block_types`.
- `where` on a property → `json_extract(properties_json, '$.<name>') = ?` (and add per-property indices as we identify hot fields, same shape as `idx_blocks_workspace_type` was).
- `referencedBy` → join `block_references` filtered by `target_id` (and optionally `source_field`).
- `subscribeBlocks` rides the existing `InvalidationRule` / `repo` change-notification stream, which is already driven by row-event-aware machinery — same as backlinks consumers do today.

This reduces §8 from "build a new in-memory index that must consume two change streams" to "compose three SQL primitives that already exist or are added in §2a/§6b and re-execute on the existing notification stream."

**No PowerSync / Postgres changes.** `typesProp` is just another key in the existing JSON `properties` column; the `source_field` addition lives in the local-only `block_references` table; `block_types` is local-only. Server-side filtered sync (don't pull all blocks, only types X and Y) is a separate, deferred decision.

A `useBlockQuery(q)` hook in `src/hooks/` wraps `subscribeBlocks` for components.

### 9. User-authored types — code extensions only for v1

Types in v1 are facet contributions, full stop. End users who want to declare a new type write a small extension block (the existing `extension`-block path) whose source contributes `typesFacet.of({...})`. The extension-block compiler at [src/extensions/dynamicExtensions.ts](src/extensions/dynamicExtensions.ts) and the resolution-rebuild trigger via `refreshAppRuntime()` ([src/extensions/runtimeEvents.ts:3](src/extensions/runtimeEvents.ts:3)) already handle dynamic load, validation, and atomic switchover — there's no work to do for "user-defined types" beyond documenting that contributing to `typesFacet` is the supported path.

A dedicated declarative `type-definition` block (with a property-panel UI for non-coding authors) is **deferred to a follow-up**. It would land as a resolver in the resolution pipeline, symmetric to `dynamicExtensionsExtension`, with `refreshAppRuntime()` triggering rebuilds on change — explicitly *not* a mutable contribution sink, because `FacetRuntime` is immutable after construction ([src/extensions/facet.ts:88](src/extensions/facet.ts:88)) for real reasons (atomic switchover when mutators + processors + schemas register together, upfront validation, deterministic `combine`, order-independent visibility). When it lands, follow the `dynamicExtensions` shape exactly. Until then, the v1 surface is small: ship `typesFacet`, document the extension-author recipe, move on.

## Migration of existing `typeProp` users

Mechanical. Each replaces `typeProp` with `typesProp` (string array) and adds the matching `typesFacet.of({...})` contribution to its plugin or to the kernel data extension:

| Current `type=` value | Where set | Type contribution lives in |
|---|---|---|
| `extension` | [exampleExtensions.ts:309](src/extensions/exampleExtensions.ts:309), [agent-runtime/commands.ts:189](src/plugins/agent-runtime/commands.ts:189), [initData.ts:74](src/initData.ts:74) | `staticAppExtensions.ts` (kernel) |
| `page` | [roamImport/import.ts:836](src/utils/roamImport/import.ts:836), [roamImport/plan.ts:562](src/utils/roamImport/plan.ts:562) | kernel (`KERNEL_PROPERTY_SCHEMAS` neighbour) |
| `panel` | [LayoutRenderer.tsx:74](src/components/renderer/LayoutRenderer.tsx:74), [:120](src/components/renderer/LayoutRenderer.tsx:120) | kernel |
| `journal`, `daily-note` | [dailyNotes.ts:86](src/data/dailyNotes.ts:86), [:159](src/data/dailyNotes.ts:159) | kernel |
| (new) `todo` | importer + new todo plugin | new `src/plugins/todo/` |

Per `KERNEL_PROPERTY_SCHEMAS` ([properties.ts:191](src/data/properties.ts:191)) convention, kernel-level type contributions live in a parallel `KERNEL_TYPE_CONTRIBUTIONS` array in `src/data/properties.ts`, registered by `kernelDataExtension`.

The Roam importer ([src/utils/roamImport/](src/utils/roamImport/)) gains a tag-mapping table:

```ts
const TAG_TO_TYPE: Record<string, { types: string[]; defaults?: Record<string, unknown> }> = {
  TODO: { types: ['todo'], defaults: { status: 'open' } },
  DONE: { types: ['todo'], defaults: { status: 'done' } },
}
```

When a Roam block has a `#TODO` tag, the importer pushes `'todo'` into `typesProp` and merges `defaults` into the block's properties. Stripping the `#TODO` from content vs. preserving it for round-trip is an importer policy decision — recommend stripping, since the type captures the meaning.

## Out of scope (explicit non-goals for v1)

- **Type inheritance** — `extends`. Revisit only if duplication shows up.
- **Computed / derived fields** — `dueIn = due - now()`. Needs an expression language.
- **Workflow rules** — "when status flips to done, set completedAt = now". A `typeRulesFacet` is the natural shape but defer.
- **Server-side filtered sync** based on types. Indexing is in-memory only.
- **Field namespacing** (Tana-style `Project.status` vs `Task.status`). Use distinct prop names when codecs would diverge.
- **User-defined property schemas from data**. v1 only lets data-defined types reference *existing* code-defined property schemas by name.
- **Required-field validation at edit time**. Type contributions can declare it as data, but enforcing at the editor is a follow-up.
- **Data-defined `type-definition` blocks + property-panel UI for non-coders.** v1 ships types-as-facet-contributions only; users author types via small extension blocks. The data-defined path lands later when there's user demand — design sketch lives in §9 so it's not lost.

## Phases

Each phase is independently shippable and testable.

### Phase 1 — `typesFacet`, `typesProp`, `block_types` index, addType/removeType

1. Add `typesFacet` to [src/data/facets.ts](src/data/facets.ts).
2. Add `typesProp` schema to [src/data/properties.ts](src/data/properties.ts), include in `KERNEL_PROPERTY_SCHEMAS`.
3. Add the `block_types` table + triggers + backfill marker per §2a, in the kernel local-schema (mirror [src/plugins/backlinks/localSchema.ts](src/plugins/backlinks/localSchema.ts) shape).
4. Rewrite `SELECT_BLOCKS_BY_TYPE_SQL` and `findExtensionBlocksQuery` to join `block_types` ([src/data/internals/kernelQueries.ts:33](src/data/internals/kernelQueries.ts:33), [:384](src/data/internals/kernelQueries.ts:384)). Drop `idx_blocks_workspace_type` ([src/data/blockSchema.ts:111](src/data/blockSchema.ts:111)).
5. Add `KERNEL_TYPE_CONTRIBUTIONS` for `'page'`, `'panel'`, `'journal'`, `'daily-note'`, `'extension'`.
6. Add `repo.mutate.addType` / `repo.mutate.removeType` per §3a.
7. Add `Block` facade sugar: `block.types` getter, `block.hasType(id)`, `block.addType(id)`, `block.removeType(id)` ([src/data/block.ts](src/data/block.ts)). Use `hasType` at every type-decoration call site introduced in later phases.
8. One-shot data migration: backfill `properties.types = [oldType]` for every row with `properties.type` (clearing `properties.type`). The `block_types` triggers populate the side table from `properties.types` automatically.
9. Update every `typeProp` write site to call `addType` (or write `typesProp` directly for batch paths like the Roam importer that bypass mutators).
10. Update every `typeProp` read site to read `typesProp` and `.includes(value)` / `[0]` (or use `block.hasType`/`block.types` once #7 lands). Greps: `grep -rn "typeProp" src/`.
11. Remove `typeProp` from `KERNEL_PROPERTY_SCHEMAS` and from [properties.ts](src/data/properties.ts).

**Acceptance:** existing app behaviour unchanged. All current tests green. `repo` snapshots show `types: [...]` instead of `type:`. `findExtensionBlocks` returns the same set as before via `block_types` join.

### Phase 2 — type-driven renderer dispatch

1. Update [src/hooks/useRendererRegistry.tsx](src/hooks/useRendererRegistry.tsx) to consult `typesFacet` per §4.
2. Add `priority` to a few existing kernel type contributions so collisions resolve deterministically.

**Acceptance:** removing every explicit `rendererProp` from current code paths still renders correctly because the type drives dispatch.

### Phase 3 — ref codecs + named-backlinks (`block_references.source_field` + `ProcessorCtx`)

1. Add `codecs.ref()` / `codecs.refList()` to [src/data/api/codecs.ts](src/data/api/codecs.ts) with runtime `isRefCodec` / `isRefListCodec` predicates.
2. Add `kind: 'ref' | 'refList'` to `PropertyKind`.
3. Extend `BlockReference` with optional `sourceField`.
4. **Local-schema delta per §6b**: add `source_field TEXT NOT NULL DEFAULT ''` column to `block_references`, change PK to `(source_id, target_id, alias, source_field)`, update INSERT/UPDATE triggers and `BACKFILL_BLOCK_REFERENCES_SQL` to read `$.sourceField` from `references_json`, gated by a new backfill marker (`block_references_source_field_v1`). Re-verify the existing `InvalidationRule` for `block_references` covers the schema change.
5. **`ProcessorCtx` extension per §7a**: add `propertySchemas: ReadonlyMap<string, AnyPropertySchema>` to `ProcessorCtx` ([src/data/api/processor.ts:110](src/data/api/processor.ts:110)) and propagate from `processorRunner` ([src/data/internals/processorRunner.ts:226](src/data/internals/processorRunner.ts:226)) using the same runtime path that `repo.setFacetRuntime` already drives.
6. Extend `backlinks.parseReferences` ([src/plugins/backlinks/referencesProcessor.ts](src/plugins/backlinks/referencesProcessor.ts)) to also walk ref-typed properties (using `ctx.propertySchemas` to identify ref codecs); watch `properties` field too.
7. Add `source_field`-aware grouping mode to [src/plugins/grouped-backlinks/](src/plugins/grouped-backlinks/).

**Acceptance:** a block with a ref-typed property pointing to another block surfaces in the target's grouped backlinks under the property name; two property refs from the same source to the same target via different fields don't collapse.

### Phase 4 — reactive typed-query primitive (SQLite-backed)

1. Implement `repo.queryBlocks` / `repo.subscribeBlocks` per §8 backed by SQL: `JOIN block_types` for type filters, `json_extract(properties_json, '$.<name>') = ?` for `where`, `JOIN block_references` for `referencedBy`. Per-property indexes added incrementally as hot fields are identified.
2. Wire `subscribeBlocks` to the existing repo change-notification stream (which is already row-event-aware) so updates flow from both local commits and sync-applied changes.
3. Add `useBlockQuery` hook in `src/hooks/`.

**Acceptance:** subscribing to `{ types: ['todo'] }` returns a live list that updates when a block is tagged/untagged, including across a remote sync apply (e.g. another device adds a todo).

### Phase 5 — Roam todo import (downstream consumer)

1. Add `TAG_TO_TYPE` map to importer.
2. Add `'todo'` type contribution (its own small plugin, `src/plugins/todo/`) with at minimum `statusProp` and a renderer.
3. On import, project tag → `addType(block, 'todo')` followed by merging non-default fields. (Direct `properties.types` writes are acceptable in the importer's bulk path so long as type-defaults are materialised — `addType` is the simpler route.)

**Acceptance:** importing a Roam graph with `#TODO`/`#DONE` blocks produces blocks with `types: ['todo']` and matching `status`, surfaced via the todo renderer and queryable via `useBlockQuery({types: ['todo'], where: {status: 'open'}})`.

## Open questions for the implementer

- **Where `KERNEL_TYPE_CONTRIBUTIONS` is registered.** `kernelDataExtension` is the natural home (matches `KERNEL_PROPERTY_SCHEMAS`). Confirm by reading the kernel-extension wire-up before adding.
- **`removeType` cleanup policy.** v1 just removes from `typesProp` and leaves properties intact (defaults become inert). If this proves leaky in practice, add a "clear properties whose only contributing type is being removed" rule — but only after seeing the failure mode.
- **Importer content stripping.** Whether to strip `#TODO` from content after mapping to `types`. Recommend strip; confirm with user once Phase 5 begins.
- **Per-property indexes for typed queries.** Phase 4 starts with `json_extract` scans. Add expression indexes per hot field (e.g. `idx_blocks_status` on `json_extract(properties_json, '$.status')`) only when query latency shows up — easier to add later than to remove.
