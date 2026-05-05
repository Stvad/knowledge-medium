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
- **`appEffectsFacet`** ([src/extensions/core.ts](src/extensions/core.ts)) — long-lived runtime effects with cleanup. Not used in the v1 type-system shape (it would be the natural home for the deferred data-defined-types watcher; §9 explains why that's deferred).

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
  /** Optional human label for the property panel / quick-find. */
  readonly label?: string
  /** Optional longer description for hover tooltips in type pickers and
   *  the property panel section header. */
  readonly description?: string
  /** Per-type ref-target hints for ref-codec properties on this type
   *  (§5). Keys are property names; values are TypeId allowlists for
   *  the picker UI. Empty/missing = "any type." Multi-type combine
   *  is union (§3b). */
  readonly refTargets?: Readonly<Record<string, readonly string[]>>
  /** Optional escape hatch beyond `defaults`. Runs once when `addType`
   *  first applies this type to a block, after `defaults` are
   *  materialised, inside the same tx. See §3a-setup. Use sparingly —
   *  it's a code-execution hatch in the type registry. Common cases:
   *  child-block templates (meeting → Attendees/Agenda/Action items),
   *  computed initial values (`due = now() + 7 days`), cross-block
   *  wiring at add time. */
  readonly setup?: TypeSetup
}

export interface TypeSetupContext {
  readonly tx: Tx
  /** The block the type is being added to. */
  readonly id: string
  /** For ordinary repo operations — opening tx-internal queries, etc.
   *  Not for type/schema registry reads: those registries are private
   *  on Repo. Use the snapshots below instead. */
  readonly repo: Repo
  /** Type registry snapshotted at addType-call time, parallel to the
   *  ProcessorCtx.propertySchemas pattern (§7a). Lets a setup look up
   *  related type contributions (e.g. the parent's type) without
   *  reaching into Repo internals. */
  readonly types: ReadonlyMap<string, TypeContribution>
  /** Property-schema registry snapshotted at addType-call time. Lets
   *  setup encode values via a schema's codec when needed. */
  readonly propertySchemas: ReadonlyMap<string, AnyPropertySchema>
}

export type TypeSetup = (ctx: TypeSetupContext) => void | Promise<void>

/** Identity-typed helper for full type inference at definition sites,
 *  parallel to `defineProperty`. Does not register — registration is
 *  the facet's job (`typesFacet.of(definition, {source})`). */
export const defineBlockType = (def: TypeContribution): TypeContribution => def

export const typesFacet = defineFacet<TypeContribution, ReadonlyMap<string, TypeContribution>>({
  id: 'data.types',
  combine: (values) => {
    const out = new Map<string, TypeContribution>()
    for (const t of values) {
      if (out.has(t.id)) {
        console.warn(`[typesFacet] duplicate registration for "${t.id}"; last-wins per facet convention`)
      }
      out.set(t.id, t)
    }
    return out
  },
  empty: () => new Map(),
})
```

Plugins contribute the same way as today — through the facet: `typesFacet.of(definition, {source: 'todo-plugin'})`. The `defineBlockType` helper is identity-typed sugar for inference, not an imperative API.

### 2. Multi-type: `typesProp` replaces `typeProp` as the primary discriminator

Add a new schema and migrate single-string usage to it. Per [feedback_no_backcompat_in_alpha](../.claude/projects/-Users-vlad-coding-knowledge-knowledge-medium-knowledge-medium/memory/feedback_no_backcompat_in_alpha.md), no shim — one-shot data migration, drop `typeProp` after.

```ts
// src/data/properties.ts
export const typesProp = defineProperty<readonly string[]>('types', {
  codec: codecs.list(codecs.string),
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
  kind: 'list',
})
```

`KERNEL_PROPERTY_SCHEMAS` includes `typesProp`; `typeProp` is removed. All current writers ([dailyNotes.ts](src/data/dailyNotes.ts), [LayoutRenderer.tsx](src/components/renderer/LayoutRenderer.tsx), [roamImport/import.ts](src/utils/roamImport/import.ts), [roamImport/plan.ts](src/utils/roamImport/plan.ts), [initData.ts](src/initData.ts), [exampleExtensions.ts](src/extensions/exampleExtensions.ts), [agent-runtime/commands.ts](src/plugins/agent-runtime/commands.ts)) switch from `typeProp.codec.encode('foo')` / `tx.setProperty(id, typeProp, 'foo')` to `typesProp` writes.

A one-shot migration backfills existing rows: any block with `properties.type` writes `properties.types = [oldValue]` and clears `type`. Land it as a `LocalSchemaBackfill` contributed via `localSchemaFacet` ([src/data/facets.ts](src/data/facets.ts) — `LocalSchemaContribution.backfills`); `propertySchemasFacet` only combines schema registrations and won't run backfills. Kernel local-schema contributions live in the same place as the existing kernel-side migrations (mirror [src/plugins/backlinks/localSchema.ts](src/plugins/backlinks/localSchema.ts) for the pattern, including the `client_schema_state` marker key).

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

### 3. Property naming: flat for shared vocabulary, namespaced for plugin-private

Reuse `PropertySchema` as the field primitive — `propertySchemasFacet` stays one global registry keyed by `name`. The convention for *what to name a schema* is hybrid:

- **Flat** for shared-vocabulary fields whose meaning is consistent across types and that an untagged block could plausibly use the same way: `status`, `due`, `priority`, `tags`, `description`, `assignee`. One `statusProp` exists, multiple types list it in their `properties[]`, and a typeless block can read/write it via `block.set(statusProp, …)` without picking a "which status" namespace. The defaults differ per type via `TypeContribution.defaults`; the codec is shared.
- **Namespaced** for type-private / plugin-internal fields whose meaning is meaningless or confusing elsewhere: `video:playerView` (whether the video player is in notes mode — only the video plugin understands this), `roam:todo-state` (source-mirror metadata for round-trip — only the Roam importer cares), `extension:disabled` (already exists as `system:disabled`). These exist purely because *one* type needs them; namespacing prevents accidental collision with shared vocab and signals the limited scope.
- **Heuristic when in doubt:** could a different type or a typeless block reasonably use this field with the same meaning? Yes → flat. No → namespace. When two types genuinely want the same field name with **incompatible codec semantics**, namespace one (or both) — but this is rare in practice.

This sidesteps Tana-style per-supertag schema scoping (which makes "set status on an untagged block" ill-defined). Flat for `status` keeps that operation valid and unambiguous; namespacing for `video:playerView` keeps the video plugin's UI-state from polluting the shared vocabulary.

What still belongs on the type contribution rather than on the schema:

- **Type-conditional defaults** → `TypeContribution.defaults`. A `todo`'s `status='open'` and a `meeting`'s `status='scheduled'` are declared by their respective types, not the prop schema.
- **Per-type ref-target hints** → `TypeContribution.refTargets`. The codec is a single shared `refList`; the *hint* of "for this type, the picker should suggest Task-typed targets" lives on the type.
- **Per-type `properties[]` membership** → which schemas appear in this type's section of the property panel; a flat `statusProp` listed by both `todo` and `task` shows up under both.

#### 3-pure. Pure helpers on raw `BlockData`

Several call sites work on raw `BlockData` rows, not the `Block` facade: importer plan code ([src/utils/roamImport/plan.ts](src/utils/roamImport/plan.ts)) building rows pre-tx, post-commit processors receiving snapshot events, query code, tests constructing fixtures. Expose pure helpers in [src/data/properties.ts](src/data/properties.ts) so these paths don't need a live facade:

```ts
export const getBlockTypes = (data: Pick<BlockData, 'properties'>): readonly string[] => {
  const raw = data.properties[typesProp.name]
  return raw === undefined ? typesProp.defaultValue : typesProp.codec.decode(raw)
}

export const hasBlockType = (
  data: Pick<BlockData, 'properties'>,
  typeId: string,
): boolean => getBlockTypes(data).includes(typeId)

/** Returns a new `properties` map with `typeId` appended if absent.
 *  Does NOT apply defaults — for that, route through `repo.addType`,
 *  which is the only path that has access to the type contribution
 *  and can encode default values via the matching schema's codec. */
export const addBlockTypeToProperties = (
  properties: Record<string, unknown>,
  typeId: string,
): Record<string, unknown> => {
  const current = getBlockTypes({ properties })
  if (current.includes(typeId)) return properties
  return {
    ...properties,
    [typesProp.name]: typesProp.codec.encode([...current, typeId]),
  }
}
```

These are deliberately small. Registry resolution, defaults materialisation, and `setup` all happen inside `repo.addType` — these helpers don't replicate any of that.

**Important: `addBlockTypeToProperties` does NOT call defaults or setup.** It's a *raw membership writer* for paths that genuinely can't reach `repo.addType` — fixture construction in tests, processor snapshot rewrites, importer **plan** code that builds row shapes before commit. **Don't pre-write membership and then call `repo.addType` expecting `setup` to fire**: `repo.addType` always runs init-if-missing materialisation (so defaults *will* apply on a re-call), but `setup` only fires when `addType` actually transitions the block from "doesn't have type" to "does have type." Pre-writing typesProp via raw `tx.update` makes that transition invisible to `addType` — `setup` never runs.

The right boundary: paths that need full type-add semantics (defaults + setup) call `repo.addType` directly without prewriting. The Roam importer's apply phase iterates blocks and calls `repo.addType(blockId, 'todo')` per row; it does **not** stamp `typesProp` itself. Plan code that constructs `BlockData` rows pre-tx (deterministic-id paths) can use `addBlockTypeToProperties` — but those paths are responsible for either also writing the defaults that `addType` would have written, or leaving them unmaterialised and relying on the §3a-bis read overlay (acceptable for app-owned-init-only-if-missing semantics; see Phase 5 reimport rule).

#### 3a. `addType` / `removeType` mutators — defaults apply on add, not just creation

Defaults at *creation* aren't enough. The common motion is "tag this existing block as a `todo`" — that block needs `status='open'` materialised so `where: {status: 'open'}` queries match. Without a central place to apply defaults, every writer (importer, command, agent action) has to remember to do it, and missed sites silently degrade query results.

**API surface: `repo.addType` / `repo.removeType` are `Repo` methods, not registered mutators.** The `Mutator.apply: (tx, args) => Promise<R>` signature ([src/data/api/mutator.ts:9](src/data/api/mutator.ts:9)) deliberately doesn't carry runtime/registry access, and `addType` needs both `typesFacet` (for defaults) and `propertySchemasFacet` (to encode them). Adding a context arg to the mutator surface is a broad change for one call site; making `addType` a `Repo` method is the conservative fit — `Repo` is the natural home for orchestration that spans facet lookups + tx writes. (Pattern parallel: `repo.tx`, `repo.mutate.X` for low-level ops; `repo.addType` for type-system orchestration that needs registry access.)

**`Repo` must retain the registries it needs.** `Repo.setFacetRuntime` ([src/data/repo.ts:738](src/data/repo.ts:738)) today only extracts `mutators`, `processors`, `invalidationRules`, and `queries` — it does NOT store the runtime, `typesFacet`, or `propertySchemasFacet`. Phase 1 must extend `setFacetRuntime` to also retain narrower registries needed by type-system orchestration:

```ts
// Inside Repo
private types: ReadonlyMap<string, TypeContribution> = new Map()
private propertySchemas: ReadonlyMap<string, AnyPropertySchema> = new Map()

setFacetRuntime(runtime: FacetRuntime): void {
  this.mutators = new Map(runtime.read(mutatorsFacet))
  this.processors = new Map(runtime.read(postCommitProcessorsFacet))
  this.invalidationRules = runtime.read(invalidationRulesFacet)
  this.types = runtime.read(typesFacet)                   // NEW
  this.propertySchemas = runtime.read(propertySchemasFacet) // NEW
  const newQueries = new Map(runtime.read(queriesFacet))
  this.swapQueries(newQueries)
}
```

Storing the narrower registries (vs. holding a `runtime: FacetRuntime` field) keeps the surface small — `Repo` only sees what type-system orchestration needs, no general extension-runtime exposure. The same retained `propertySchemas` map is what gets snapshotted into `CommittedTxOutcome.propertySchemas` at tx-start (§7a), so processors see schemas from the same resolved runtime that produced their registry snapshot.

**Two-layer shape: in-tx primitives + tx-opening wrappers.** Every operation that composes (`toggleType`, `setBlockTypes`, anything similar in plugin code) needs to run end-to-end in one tx — read, decide, write all under the same writer slot — otherwise concurrent writes interleave and decisions made on stale reads survive. So define private in-tx helpers and have the public `Repo` methods open a tx and dispatch. Composers (toggle/set) call the helpers directly inside their own tx.

```ts
// On Repo (private in-tx primitives — share the same registry snapshots
// the public method captured before opening the tx)
private async _addTypeInTx(
  tx: Tx,
  types: ReadonlyMap<string, TypeContribution>,
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
  blockId: string,
  typeId: string,
  initialValues: Readonly<Record<string, unknown>>,
): Promise<void> {
  const contribution = types.get(typeId)
  const block = await tx.get(blockId)
  if (!block) return
  const current = (block.properties[typesProp.name] as string[] | undefined) ?? []
  const wasNew = !current.includes(typeId)
  const next: Record<string, unknown> = { ...block.properties }
  if (wasNew) {
    next[typesProp.name] = typesProp.codec.encode([...current, typeId])
  }
  // ALWAYS run materialisation — see §3a rationale.
  const merged = { ...(contribution?.defaults ?? {}), ...initialValues }
  let propsChanged = wasNew
  for (const [name, value] of Object.entries(merged)) {
    if (next[name] === undefined) {
      const schema = propertySchemas.get(name)
      next[name] = schema ? schema.codec.encode(value) : value
      propsChanged = true
    }
  }
  if (propsChanged) await tx.update(blockId, { properties: next })
  if (wasNew) await contribution?.setup?.({ tx, id: blockId, repo: this, types, propertySchemas })
}

private async _removeTypeInTx(tx: Tx, blockId: string, typeId: string): Promise<void> {
  const block = await tx.get(blockId)
  if (!block) return
  const current = (block.properties[typesProp.name] as string[] | undefined) ?? []
  if (!current.includes(typeId)) return
  const next: Record<string, unknown> = { ...block.properties }
  next[typesProp.name] = typesProp.codec.encode(current.filter(t => t !== typeId))
  // v1: don't clean up properties.
  await tx.update(blockId, { properties: next })
}

// Public wrappers — snapshot registries before tx, then dispatch.
async addType(
  blockId: string,
  typeId: string,
  /** Per-call initial values that take precedence over the type's
   *  `defaults`. Importers and "create with state" callers use this to
   *  set app-owned fields atomically with the tag. Init-only-if-missing
   *  semantics still apply: values already set on the block are not
   *  overwritten. */
  initialValues: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  const types = this.types
  const propertySchemas = this.propertySchemas
  await this.tx(async tx => {
    await this._addTypeInTx(tx, types, propertySchemas, blockId, typeId, initialValues)
  }, { scope: ChangeScope.BlockDefault, description: `addType ${typeId}` })
}

async removeType(blockId: string, typeId: string): Promise<void> {
  await this.tx(async tx => {
    await this._removeTypeInTx(tx, blockId, typeId)
  }, { scope: ChangeScope.BlockDefault, description: `removeType ${typeId}` })
}

async toggleType(blockId: string, typeId: string): Promise<void> {
  // Decision and write in ONE tx so concurrent toggles serialise
  // correctly. Two concurrent toggles from an initially-untyped block
  // both end up tagged otherwise: the load()-then-decide pattern lets
  // both branches choose addType, the second is a no-op and the user
  // expected toggle1+toggle2 to net out.
  const types = this.types
  const propertySchemas = this.propertySchemas
  await this.tx(async tx => {
    const block = await tx.get(blockId)
    if (!block) return
    const current = (block.properties[typesProp.name] as string[] | undefined) ?? []
    if (current.includes(typeId)) {
      await this._removeTypeInTx(tx, blockId, typeId)
    } else {
      await this._addTypeInTx(tx, types, propertySchemas, blockId, typeId, {})
    }
  }, { scope: ChangeScope.BlockDefault, description: `toggleType ${typeId}` })
}

async setBlockTypes(blockId: string, typeIds: readonly string[]): Promise<void> {
  // ONE tx wrapping removals + materialisation + final order rewrite.
  // Per-step txs would create multiple undo entries and let other
  // writers interleave; the final order rewrite could then drop or
  // reorder a type that arrived between steps.
  //
  // Steps:
  //   1. Remove unwanted types (drops their typesProp entry).
  //   2. addType for ALL desired types in array order — not just the
  //      new additions. addType is idempotent and intentionally
  //      re-materialises missing defaults / initial values even when
  //      the type is already present (§3a), so passing every desired
  //      type through it gives setBlockTypes a "make this the
  //      canonical state" semantics: missing fields on already-typed
  //      blocks get repaired.
  //   3. Rewrite typesProp to the deduped desired order if it doesn't
  //      already match. addType only appends, so existing memberships
  //      keep their original positions; without the rewrite, current
  //      = ['b','a'] + setBlockTypes(['a','b']) stays ['b','a']. The
  //      §3b read-overlay walks block.types order, so respecting
  //      caller intent here is meaningful (changes which type's
  //      default wins for unset shared fields).
  const desiredOrder = Array.from(new Set(typeIds))
  const types = this.types
  const propertySchemas = this.propertySchemas
  await this.tx(async tx => {
    const block = await tx.get(blockId)
    if (!block) return
    const current = (block.properties[typesProp.name] as string[] | undefined) ?? []
    const want = new Set(desiredOrder)
    for (const t of current) {
      if (!want.has(t)) await this._removeTypeInTx(tx, blockId, t)
    }
    for (const t of desiredOrder) {
      await this._addTypeInTx(tx, types, propertySchemas, blockId, t, {})
    }
    // Final order rewrite — addType only appends, so existing
    // memberships keep their position; e.g. current = ['b','a'] +
    // setBlockTypes(['a','b']) would stay ['b','a'] without this. The
    // §3a-bis read-overlay walks block.types in order, so the rewrite
    // is semantically meaningful for unset-shared-field defaults.
    const after = await tx.get(blockId)
    if (!after) return
    const stored = (after.properties[typesProp.name] as string[] | undefined) ?? []
    if (stored.length === desiredOrder.length && stored.every((t, i) => t === desiredOrder[i])) return
    const finalProps = { ...after.properties, [typesProp.name]: typesProp.codec.encode(desiredOrder) }
    await tx.update(blockId, { properties: finalProps })
  }, { scope: ChangeScope.BlockDefault, description: 'setBlockTypes' })
}
```

`block.addType(id)` / `block.removeType(id)` (the §3a facade sugar) delegate to `block.repo.addType(block.id, id)` / `block.repo.removeType(block.id, id)`.

Every tag-mapping path (Roam importer, agent commands, command-palette "Add tag" action) goes through `repo.addType`. Direct writes to `typesProp` are discouraged — add a lint or an engine guard if needed.

A *full* read-time overlay (defaults synthesised everywhere — storage reads, queries, indexes — whenever a block has a type but lacks the property) is the alternative, and it's worse: it forces every storage-level reader to know about types and complicates the SQL-backed typed-query primitive in §8. Prefer materialise-on-add as the storage-level invariant.

#### 3a-setup. The `setup` escape hatch beyond `defaults`

`defaults` is a static map: "if this property isn't set, set it to this literal value." A handful of legitimate type-add behaviors don't fit:

- **Child-block templates.** `meeting` creates child blocks for *Attendees*, *Agenda*, *Action items*. `project` creates *Tasks* and *Notes* container children. `daily-note` pre-populates the daily template structure.
- **Computed initial values.** `due = now() + 7 days`. `weekNumber = isoWeek(today)`. `assignee = currentUser`. Static defaults can't carry expressions.
- **Cross-block wiring at add time.** Setting `project = parent.id` when a `task` is added under a `project`-typed parent. (Borderline — react-to-context fits workflow rules better, but if it should fire *only* on the initial tag, `setup` is the place.)
- **Side effects sharing the tx.** Append a row to a side table or an "All Tasks" inbox subtree, with the same tx so undo of the type-add cleanly removes everything together.

The hook fires inside `repo.addType` after `defaults` are applied, in the same tx. `removeType` doesn't run a teardown — use the same "we don't clean up on remove in v1" rule as for properties; types that ship complex setups should be ones users add and rarely undo.

```ts
import { createChild } from '@/data/internals/kernelMutators'  // 'core.createChild' mutator

typesFacet.of(defineBlockType({
  id: 'meeting',
  label: 'Meeting',
  properties: [meetingDateProp, meetingAttendeesProp],
  defaults: { [meetingDateProp.name]: today() },
  setup: async ({ tx, id }) => {
    for (const label of ['Attendees:', 'Agenda:', 'Action items:']) {
      // tx.run dispatches a registered mutator inside this tx so the
      // child writes share the same transactional bucket as the
      // addType writes — undo of the type-add cleanly removes the
      // template subtree.
      const childId = await tx.run(createChild, { parentId: id, position: { kind: 'last' } })
      await tx.update(childId, { content: label })
    }
  },
}), { source: 'meeting' })
```

`tx.run(mutator, args)` ([src/data/api/tx.ts:130](src/data/api/tx.ts:130)) is the in-tx mutator dispatch — different from `repo.mutate.createChild(...)` which would open a separate tx and break the atomicity property `setup` exists for. Setup callbacks should always use `tx.run`, never `repo.mutate.X`.

**Use sparingly** — it's a code-execution hatch in the type registry. `defaults` covers ~90% of cases and is data (auditable, syncable, deterministic). `setup` is opaque code at add time. Two specific gotchas to flag at implementation time:

- **Bulk-write asymmetry.** `setup` fires from `repo.addType`. A bulk path that writes `typesProp = ['task', 'meeting']` directly via `tx.update` *bypasses* setup. Importers that want setup behavior must call `repo.addType` per type rather than writing typesProp directly.
- **Reimport runs setup again.** A Roam reimport that adds `task` to a block where the type wasn't previously present *will* run `setup`. That's usually correct (first-time-for-this-block tag), but means import paths can trigger child-block creation. Document in the importer.

This naturally subsumes existing "create-and-stamp-type" code. [src/data/dailyNotes.ts:86](src/data/dailyNotes.ts:86)'s daily-note creation, which today writes `type='daily-note'` plus its own initial structure imperatively, becomes `repo.addType(id, 'daily-note')` with the `daily-note` type's `setup` carrying the template.

#### 3a-bis. Narrow overlay on `block.get` for schema-aware code reads

Materialise-on-add covers the common case but has three edge cases where a block can carry a type without the corresponding properties materialised: sync from a device that didn't have the type contribution registered, bulk-import paths that bypass `addType` (Roam importer), and type evolution (a type's `defaults` map changes in code, or a new prop is added to `properties[]`, after blocks were tagged). Under those, `block.get(statusProp)` would today return `schema.defaultValue` (probably `undefined`), missing the meaningful type-conditional default that `addType` *would* have materialised.

Teach `block.get` to overlay type-conditional defaults — narrowly, only on this one call site:

The lookup itself lives on `Repo` so all consumers share one implementation against the retained registry (avoiding direct `runtime` exposure on `Repo` and keeping `Block` from poking into private fields):

```ts
// On Repo
resolveDefault<T>(types: readonly string[], schema: PropertySchema<T>): T {
  for (const typeId of types) {
    const v = this.types.get(typeId)?.defaults?.[schema.name]
    if (v !== undefined) return v as T
  }
  return schema.defaultValue
}
```

```ts
// Updated Block.get — preserves the existing loaded-row contract.
// `this.data` throws BlockNotLoadedError / BlockNotFoundError when the
// row isn't in cache (current behaviour at [src/data/block.ts:74](src/data/block.ts:74)),
// so callers see the same not-loaded error as today rather than
// silently getting schema.defaultValue back.
get<T>(schema: PropertySchema<T>): T {
  const data = this.data  // throws if not loaded
  const stored = data.properties[schema.name]
  if (stored !== undefined) return schema.codec.decode(stored) as T
  // Row IS loaded; the property just isn't materialised. Apply the
  // type-conditional overlay against the row's actual `types` array.
  const types = (data.properties[typesProp.name] as string[] | undefined) ?? []
  return this.repo.resolveDefault(types, schema)
}
```

Three companion rules:

- **`peekProperty` does NOT overlay.** It stays as "is this property actually materialised?" — used by `addType` itself to decide whether to write a default, by sync-conflict resolution, by debugging tools that want raw storage. The overlay is a `get`-only enhancement.
- **`useProperty` DOES overlay** ([src/hooks/block.ts:252](src/hooks/block.ts:252)) — by the same symmetry argument as `block.get`. Inside the selector, call `repo.resolveDefault(types, schema)` against the type ids read from `doc.properties[typesProp.name]`. **Reactivity caveat:** `useHandle` only re-runs on block-handle changes, so updating `Repo`'s retained `types` registry inside `setFacetRuntime` would NOT invalidate this hook on its own — a runtime swap that changes type defaults wouldn't re-render unless a row also changed. Two viable wirings:
  - **(a) Pull `runtime` into the hook's deps via `useAppRuntime()`** and pass the runtime as a selector dependency so the selector closure rebuilds on runtime swap. This forces `useHandle` to re-evaluate against the new selector identity. Cheap; only cost is one extra context read per `useProperty` call site.
  - **(b) Bump a `Repo.runtimeGeneration` counter** on each `setFacetRuntime` and have `useProperty` subscribe to it (or include it in the selector deps). Slightly more plumbing but keeps the React tree out of the runtime context for hooks that don't otherwise need it.
  Recommend **(a)** for v1 — `useAppRuntime()` already exists and most consumers of `useProperty` are inside the runtime-aware tree anyway. Add a parallel `usePeekProperty` returning `T | undefined` for the rare "is this materialised?" caller (no overlay, no runtime dependency). The downstream wrappers `useUIStateProperty` / `useRootUIStateProperty` / `useUserPrefsProperty` ([src/data/globalState.ts:275](src/data/globalState.ts:275)) inherit the overlay automatically — verify at implementation time that no UI-state schema name collides with a type-contributed prop name.
- **The typed-query primitive (§8) does NOT overlay by default.** SQL runs against `properties_json` and matches only materialised values. Under normal flows storage and overlay agree (because `addType` materialised them). At the three edges above, queries can miss until something materialises; `addType` remains the storage invariant. An opt-in `{ materialiseDefaults: true }` flag is a possible follow-up if real call sites want overlay-aware filtering, but defer until there's demand.
- **`BlockProperties` field discovery (§3c) reuses `repo.resolveDefault`.** Unset slots in the panel render whatever `repo.resolveDefault(block.types, schema)` returns — same answer `block.get` would produce — so the panel and code reads agree on what an unset-but-typed slot looks like. The signature replaces the earlier free-function `resolveDefault(block, schema, typesRegistry)` sketch; pass the type-id list and let `Repo` own the registry access.

**`Block` facade sugar** mirrors the existing `get`/`set`/`setContent`/`delete` pattern at [src/data/block.ts:159](src/data/block.ts:159)–[:228](src/data/block.ts:228):

```ts
get types(): readonly string[] {
  return this.peekProperty(typesProp) ?? []
}
hasType(typeId: string): boolean {
  return this.types.includes(typeId)
}
async addType(typeId: string): Promise<void> {
  await this.repo.addType(this.id, typeId)
}
async removeType(typeId: string): Promise<void> {
  await this.repo.removeType(this.id, typeId)
}
async toggleType(typeId: string): Promise<void> {
  await this.repo.toggleType(this.id, typeId)
}
```

`block.hasType('todo')` is the canonical guard at every type-decoration call site (replaces `block.peekProperty(typesProp)?.includes('todo')`). No `setTypes(array)` sugar on the facade — bulk-diff-and-apply lives on `Repo` (`repo.setBlockTypes`) where the call site is explicit about the operation rather than implied by an atomic-looking facade method.

**The addressing shape is `string`, not `TypeContribution`.** `block.hasType(typeId: string)`, `block.addType(typeId: string)`, etc. all take the persisted string id. This parallels `PropertySchema.name` as the storage primitive: the persisted shape and the API shape match. Three concrete reasons not to pass the contribution object: (a) blocks can carry types whose contribution hasn't been registered yet (sync from another device, dynamic extension not yet loaded, deferred type-definition block resolved later) — the string survives, an object reference can't; (b) data-defined paths (Roam importer's tag-mapping table, future type-definition blocks) only have strings to work with; (c) `repo.addType` looks up the contribution internally via the retained `types` registry to apply defaults — the contribution isn't useful as an *argument*, only as a *lookup target*, so taking it would force every caller to have runtime access for no win.

This differs from `block.set(statusProp, ...)` which takes the schema object because the *codec* lives on the schema and is needed at the encode site. Type ops have no per-type codec to apply (`typesProp`'s codec is just `list(string)`), so nothing to carry.

**Plugin-side typo safety:** export a string constant per type and import where used:

```ts
// src/plugins/todo/types.ts
export const TODO = 'todo' as const

// at every call site within the plugin
block.hasType(TODO)
block.addType(TODO)
```

A branded `TypeId<'todo'>` type would catch unrelated strings being passed, but is overkill for v1 — graduate to a brand only if string confusion becomes a real failure mode in practice.

#### 3b. Multi-type interactions over shared property schemas

When two types share a property schema (the common case under §3's reuse model), how the per-type bits combine matters. The rules:

- **Field discovery (which props apply to a block).** Union of every `TypeContribution.properties` across the block's types, deduped by `name`. If `todo` and `task` both list `statusProp`, the property panel shows `status` once.
- **Codec.** A property has one codec globally — `propertySchemasFacet` is keyed by `name` and last-wins on duplicates. Multi-type doesn't change that. If two types want truly incompatible codecs, namespace one of them per the §3 hybrid rule (use a plugin-private `myplugin:status` rather than overloading the shared `status`).
- **Defaults — first-writer-wins, order-dependent.** `todo.defaults={status:'open'}` and `task.defaults={status:'todo'}` on a block with neither set: `repo.addType('todo')` then `repo.addType('task')` → `status='open'` (the second `addType` sees the property already set during materialisation and skips it). Reverse order → `status='todo'`. The order callers invoke `repo.addType` in is therefore semantically load-bearing for default conflicts on shared fields; `repo.setBlockTypes(typeIds)` iterates the array in order and calls `addType` per type, which preserves the same first-wins rule. Don't pre-write `typesProp` directly via `tx.update` to apply both types "atomically" — that bypasses defaults / setup entirely and is the bug §3-pure / Phase 1 step 13 explicitly call out. This rule is intuitive (the type tagged first wins) but worth pinning.
- **`refTargets` for a shared ref-prop.** Multi-type combine is **union** — `Project.refTargets={tasks:['task']}` + `Person.refTargets={tasks:['activity']}` on a block tagged both means the picker offers `task | activity`. Empty union after merging → fall back to "any type." Intersection would yield an empty picker as soon as two types disagreed; permission unions are the right combine here.
- **`defaultRenderer`.** Priority arbitration in §4b. Most types contribute none, so multi-type collisions are rare by construction.
- **Decorations / headers / click handlers (§4a).** Stack natively — every contribution's non-falsy return is applied in contribution order. Multi-type decoration is the easy path; this is the main reason to prefer decorations over renderer-replacement.
- **Validation (deferred follow-up).** When it lands, validations across types **intersect** — a value must satisfy *all* applicable types' constraints. Constraints restrict; if any type forbids, it's forbidden. Opposite combine rule from `refTargets`, which permits.
- **`removeType` when a prop is contributed by multiple types.** v1 leaves `block.properties` untouched. If `status` was contributed by both `todo` and `task` and you remove `todo`, `task` still contributes `statusProp` so the panel still shows it. If `status` was *only* contributed by the removed type, the value stays in `block.properties` but disappears from the type-driven panel — inert until re-tagged or manually edited. v1 accepts this leak; revisit if it bites.

#### 3c. Field discovery in the property panel — surfacing type-contributed slots

Tana's "see the fields a supertag declares when looking at the block" is a small surgery on [src/components/BlockProperties.tsx:197](src/components/BlockProperties.tsx:197), which today iterates `Object.entries(block.properties)` and only shows what's actually set. Replace that with a union of (a) currently-set properties and (b) properties contributed by the block's types:

```ts
// Inside BlockProperties, alongside the existing schemas / uis reads:
const typesRegistry = runtime.read(typesFacet)

// The map holds known schemas; a parallel set of names without a registered
// schema flags those that need the existing unknown-schema fallback path.
const applicable = new Map<string, AnyPropertySchema>()
const unknownNames = new Set<string>()

// (a) actually-set properties — including ad-hoc / unknown-schema props
for (const name of Object.keys(properties)) {
  const s = schemas.get(name)
  if (s) applicable.set(name, s)
  else unknownNames.add(name)
}
// (b) type-contributed slots (may not yet be set on the block)
for (const typeId of block.types) {
  const t = typesRegistry.get(typeId)
  for (const schema of t?.properties ?? []) {
    applicable.set(schema.name, schema)
    unknownNames.delete(schema.name)  // type contribution promotes it
  }
}
```

The dedup by `name` is exactly what §3b's "field discovery is union by name" means at the code level. Multi-type composition is automatic — a prop declared by both `todo` and `task` lands in the map once.

**Empty slots render via the existing editor path, no new component.** For each entry in `applicable`: if `name in properties`, decode and edit (existing path); if not set, render `DefaultPropertyValueEditor` (or the contributed `PropertyUiContribution.Editor`) with `repo.resolveDefault(block.types, schema)` as its value (the same Repo method §3a-bis uses for `block.get`). This makes the panel show whatever `block.get(schema)` would return — type-conditional default for typed slots, schema default otherwise. The editor doesn't need a "placeholder mode" — first user interaction calls `block.set(schema, …)` which materialises the property.

For each entry in `unknownNames` — properties set on the block whose schema isn't registered (legacy ad-hoc props, plugin-not-loaded refs, etc.) — keep the existing unknown-schema fallback in [src/components/BlockProperties.tsx](src/components/BlockProperties.tsx) ([:201](src/components/BlockProperties.tsx:201)–[:204](src/components/BlockProperties.tsx:204)): `resolvePropertyDisplay` builds an `adhocSchema` and routes through the kind-inferred default editor. These rows still appear in the panel — the union must not silently drop them.

**Render order:** type-contributed properties in `block.types` array order, then in each type's `properties[]` order; ad-hoc / set-but-no-type properties last. Within each group, set values before unset slots so users see materialised state first. Aesthetic call, not a correctness one.

**Per-type grouping in the panel is the default rendering, not a v2.** Group rows by contributing type with section headers (`label` from `TypeContribution`, `description` available on hover). Block-level core fields (id, last-changed, changed-by — the existing read-only header rows in [BlockProperties.tsx](src/components/BlockProperties.tsx)) sit above; each type the block carries gets its own section listing the schemas in its `properties[]`; properties set on the block but not contributed by any current type collect under a final "Other" section, and unknown-schema ad-hoc props collect under "Unregistered." Section order: core, then types in `block.types` array order, then Other, then Unregistered. The "Add Property" form for ad-hoc properties stays unchanged. A property that's contributed by multiple types appears once, under the first contributing type in `block.types` order — multi-type display via supplementary `also: meeting` badge is fine but optional.

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

Both are tagged so `isRefCodec(codec)` and `isRefListCodec(codec)` return true at runtime — the projector in §7 needs to identify them. Add a `kind: 'ref' | 'refList'` to `PropertyKind` in [propertySchema.ts:5](src/data/api/propertySchema.ts:5) so the property panel can pick a ref-aware editor when a `PropertySchema` is registered.

**Unknown-schema fallback for refs is intentionally limited.** The unknown-schema path in [propertyEditors/defaults.tsx](src/components/propertyEditors/defaults.tsx) infers `kind` from raw JSON shape; a ref stored as a plain string id is indistinguishable from any other string, and a `refList` from any other `string[]`. Without a registered schema or an out-of-band marker on the value, the data layer has no way to know it's a ref. Accept this: unknown refs render via the primitive `string` / `list` editors, with no picker affordance, until the contributing plugin loads. Adding a `_ref: true` marker to stored values to make refs self-describing was considered and rejected — invasive, breaks JSON-equality compares, and "plugin not loaded" is rare enough that primitive-editor fallback is the right trade-off.

Schemas declare ref properties like:

```ts
export const projectTasksProp = defineProperty<readonly string[]>('tasks', {
  codec: codecs.refList(),
  defaultValue: [],
  kind: 'refList',
  changeScope: ChangeScope.BlockDefault,
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

The triggers (`blocks_references_insert`, `blocks_references_update`, the backfill `BACKFILL_BLOCK_REFERENCES_SQL`) all extend their `INSERT OR IGNORE` to read `json_extract(je.value, '$.sourceField')` and write it (coalesced to `''`) into the new column.

**Invalidation rule must diff by `(id, sourceField)`.** The existing `backlinksInvalidationRule` ([src/plugins/backlinks/invalidation.ts:9](src/plugins/backlinks/invalidation.ts:9)) compares before/after `references[]` by *target id only* — it builds `Set<string>` of ids and emits when an id appears or disappears. With named-backlinks, *changing a property ref's source-field on the same target* (e.g., a refactor that moves a ref from `Project.tasks` to `Project.archivedTasks`) wouldn't change the id set on either side and would silently fail to invalidate grouped backlinks.

Update both `collectFromSnapshots` and `collectFromRowEvent` to diff by composite key:

```ts
const emitReferenceTargetDiff = (
  before: ReadonlyArray<BlockReference>,
  after: ReadonlyArray<BlockReference>,
  emit: PluginInvalidationEmit,
): void => {
  const key = (r: BlockReference) => `${r.id}\u0000${r.sourceField ?? ''}`
  const beforeKeys = new Set(before.map(key))
  const afterKeys = new Set(after.map(key))
  const targets = new Set<string>()
  for (const r of before) if (!afterKeys.has(key(r))) targets.add(r.id)
  for (const r of after) if (!beforeKeys.has(key(r))) targets.add(r.id)
  for (const id of targets) emit(BACKLINKS_TARGET_INVALIDATION_CHANNEL, id)
}
```

The emitted channel value stays the target id (consumers index by target). The composite key is only for *deciding whether to emit*. A property-ref source-field change on a stable target now correctly emits, refreshing the grouped-backlinks panel.

Existing rows (PK collisions on the new schema are impossible since old rows were content-derived with `source_field=''` by construction). The migration is a `CREATE TABLE block_references_new ... INSERT INTO block_references_new SELECT ..., '' FROM block_references; DROP TABLE block_references; ALTER TABLE block_references_new RENAME TO block_references` sequence, gated by a `block_references_source_field_v1` marker.

### 7. Extend `backlinks.parseReferences` to also project property refs

The existing post-commit processor ([src/plugins/backlinks/referencesProcessor.ts](src/plugins/backlinks/referencesProcessor.ts)) currently watches `{ kind: 'field', table: 'blocks', fields: ['content'] }` and rewrites `references[]` from parsed content. Extend it:

- Watch list expands to `fields: ['content', 'properties']`.
- After parsing content refs (existing path), iterate the block's `properties`. For each entry whose `PropertySchema.codec` is a ref-codec or ref-list codec (looked up via `propertySchemasFacet`), decode and emit one `BlockReference { id, alias: id, sourceField: propName }` per ref. **Each property is decoded inside its own try/catch.** Stored values can be malformed for legitimate reasons — plugin upgraded the codec shape, ad-hoc edits in dev tools, sync from an older client that wrote a different encoding. A bad decode logs a warning, skips that one property, and the projector continues with the rest. Without per-property isolation, one corrupt ref-typed property would poison the whole `parseReferences` run for that block — content refs and other valid property refs would silently disappear from `references_json` until the data is fixed. v1 doesn't try to preserve prior `block_references` entries for the bad field; the field's refs simply go missing in the index until the next successful decode (the next `parseReferences` run after the property is fixed).
- Concatenate content-derived + property-derived into the new `references[]` and write through the same `tx.update(sourceId, {references}, {skipMetadata: true})`. The triggers from §6b copy `sourceField` into `block_references`.

Ordering / dedupe: identical `(id, sourceField)` pairs are deduped; content refs (no `sourceField`) and property refs (with `sourceField`) coexist for the same target — they represent different relationships.

#### 7-bis. Reproject when ref-codec set changes

The watch on `content` / `properties` field changes catches every per-block edit, but it doesn't catch **runtime changes to the ref-codec set itself**. Two real cases:

- A plugin registers a new `ref` / `refList` codec for a property name `relatedTo` that already exists on many blocks. No block row changes, so `parseReferences` never fires, and `references_json` / `block_references` stay missing the new edges until each affected block is edited.
- A schema *stops* being ref-typed (plugin removed, or its codec changed shape). Stale property-derived `BlockReference`s sit in `references_json` / `block_references` because no row write triggers re-projection.

Add a kernel-side reprojection step. On `setFacetRuntime`, diff the previous and new `propertySchemas` maps for property names whose ref-ness changed (was-not-ref → is-ref, was-ref → is-not-ref, or was-ref → is-different-ref-shape). For the affected name set, schedule a reprojection processor that:

1. Queries blocks whose `properties_json` contains any of the affected names. Cheap with a workspace-scoped scan; for large workspaces, build the index from `block_types` pattern (a side table keyed by property name) only if reprojection latency becomes an issue. v1 starts with the scan.
2. For each matching block, runs the same property-walk path as `parseReferences` — recomputes `references_json` against the new schema set and `tx.update`s through. The existing trigger maintains `block_references` from `references_json`, so the edge index falls in line automatically.
3. Runs in a separate tx (`scope: ChangeScope.References` per the existing reference-tx convention) so the reprojection doesn't bloat the user's normal undo bucket.

This is a one-shot pass at runtime-rebuild time; the watch on per-block edits handles steady-state. Plugin authors don't need to do anything — the kernel detects the schema-set change and triggers the pass automatically.

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

**Snapshot at tx-start, not at ctx-construction.** The existing pipeline already captures the processor registry at tx-start in `CommittedTxOutcome.processors` ([src/data/internals/processorRunner.ts:55](src/data/internals/processorRunner.ts:55)–[:67](src/data/internals/processorRunner.ts:67)) so a `setFacetRuntime` call landing mid-flight can't change which processors fire (or with what `apply` fn) for an already-running tx. `propertySchemas` must be captured in the same bundle, otherwise an old processor snapshot can pair with a newer schema registry: the runner would build `ctx.propertySchemas` from `repo.propertySchemas` *after* the rebuild but the processor it's about to run was resolved against the previous runtime.

Concretely:

```ts
// CommittedTxOutcome gains a peer to `processors`
export interface CommittedTxOutcome {
  txId: string
  user: User
  workspaceId: string | null
  snapshots: SnapshotsMap
  afterCommitJobs: AfterCommitJob[]
  processors: ReadonlyMap<string, AnyPostCommitProcessor>
  /** Property-schema registry snapshotted at the same tx-start point
   *  as `processors`, so processors and the schemas they look up came
   *  from the same resolved runtime. */
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>
}
```

The `Repo` commit pipeline ([src/data/repo.ts:664](src/data/repo.ts:664)) passes `this.propertySchemas` into the tx-engine alongside `this.processors`; the engine puts both on the result; `processorRunner.dispatch` builds each `ctx` with the bundle's `propertySchemas` rather than reading `repo.propertySchemas` afresh.

This requires a public read access on `Repo` only for the tx-engine plumbing path (the engine sees `Repo` internals already). No public getter is needed for general consumers; the type-system orchestration paths (`addType`, `resolveDefault`) read the same private field directly. (If a future consumer outside `Repo` needs schemas, add a getter then — keeping the API surface small for now.)

Same snapshotting rule applies to `types` if a processor ever needs the type registry — wire it through `CommittedTxOutcome.types` at the same time. Currently no processor needs it; `parseReferences` only looks at `propertySchemas` to detect ref codecs.

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

- `types`-only queries → use `EXISTS` (or `SELECT DISTINCT`) against `block_types`, not a plain join. A block matching multiple requested types would otherwise appear once per matching row. Prefer `EXISTS` because it short-circuits and avoids hash-dedup overhead:
  ```sql
  SELECT b.* FROM blocks b
  WHERE b.workspace_id = ? AND b.deleted = 0
    AND EXISTS (SELECT 1 FROM block_types bt
                WHERE bt.block_id = b.id
                  AND bt.workspace_id = b.workspace_id
                  AND bt.type IN (?, ?, ?))
  ```
- `where` on a property → compile each `(name, decodedValue)` entry to `json_extract(properties_json, ?) = ?` and bind two parameters: the **JSON path** (computed safely — see below) and the **encoded** value run through the matching `PropertySchema.codec`. **Don't string-interpolate the property name into a `$.<name>` literal** — property names with `:`, `-`, or `.` (e.g. `system:collapsed`, `daily-note`) break naive interpolation. Use SQLite's path syntax: `'$.' || quote(name)` doesn't work directly, so build the path in JS with proper escaping (wrap in `"..."` and escape inner quotes — SQLite's JSON path accepts `$."weird:name"`). Look up the schema in `propertySchemasFacet`; if no schema is registered for that name, refuse the query with a clear error rather than guessing the codec — the caller is asking for typed-equality, ad-hoc schemas have `unsafeIdentity` codec which is meaningless to compare.

  **`where` is restricted to scalar-encoded fields in v1.** `json_extract` returns SQL primitives (`TEXT` / `INTEGER` / `REAL` / `NULL`) for scalar values and JSON-text strings for arrays/objects. Comparing a bound JS array/object against the JSON-text return is unreliable (whitespace, key ordering, codec encoding all diverge), so refuse `where` on schemas whose `kind` is `list`, `object`, `ref`, or `refList`. Callers needing membership-style filters use `referencedBy` (which goes through `block_references`, not `properties_json`) or wait for a follow-up that defines explicit JSON-comparison semantics. Document the restriction at the API site so a typed-query author hits a clear error rather than silent miss.

  **`null` / `undefined` semantics on the where value.** SQL `=` doesn't match NULL — `json_extract(...) = NULL` is always FALSE — and `json_extract` itself returns NULL for missing JSON paths, so naive `= ?` against an encoded null silently matches nothing. v1 rules:
  - Decoded value is `undefined` → reject the query with a clear error. `undefined` isn't a valid encoded value (codecs encode "no value" as omitted or null) and almost always indicates a caller bug like `where: {status: someVar}` where `someVar` isn't set.
  - Decoded value encodes to `null` (e.g. an `optional(string)` codec on a "no value") → compile to `(json_extract(properties_json, ?) IS NULL)`. This deliberately conflates "property is unset" with "property is set to null"; most schemas don't distinguish the two so this is the natural meaning. If a schema does want to distinguish, the caller can post-filter or use `peekProperty`-equivalent membership checks — out of scope for v1 typed queries.
  - All other encoded scalars → compile to `json_extract(...) = ?` as before.
  Document both rules at the API site so a typed-query author can predict behaviour.
  Per-property indices (e.g. `CREATE INDEX idx_blocks_status ON blocks (json_extract(properties_json, '$.status'))`) follow the same path-quoting rule and are added incrementally for hot fields.
- `referencedBy` → use `EXISTS` against `block_references` filtered by `target_id` (and optionally `source_field`). Same dedup reason: a source could reference the same target through multiple fields and the join would duplicate the source row otherwise.
  ```sql
  WHERE EXISTS (SELECT 1 FROM block_references br
                WHERE br.source_id = b.id
                  AND br.target_id = ?
                  AND br.workspace_id = b.workspace_id)
  ```
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
const TAG_TO_TYPE: Record<string, { types: string[]; appOwnedInit: Record<string, unknown>; sourceMirror: Record<string, unknown> }> = {
  TODO: {
    types: ['todo'],
    appOwnedInit: { status: 'open' },        // app-owned: init only if missing
    sourceMirror: { 'roam:todo-state': 'TODO' }, // source-mirror: refresh freely
  },
  DONE: {
    types: ['todo'],
    appOwnedInit: { status: 'done' },
    sourceMirror: { 'roam:todo-state': 'DONE' },
  },
}
```

When a Roam block carries a `{{[[TODO]]}}` / `{{[[DONE]]}}` marker, the importer:
1. Calls `repo.addType(blockId, 'todo', appOwnedInit)` — passes the source's app-owned initial values as the third arg. Per the addType contract, these win over the type's `defaults` on first add (so `DONE` correctly initialises `status='done'` instead of being clobbered by `todo.defaults.status='open'`), and stay init-only-if-missing relative to existing block state (so reimport doesn't overwrite a locally completed task).
2. Refreshes **source-mirror** fields (`roam:todo-state`) freely via `block.set` or a separate property write.

The marker is stripped from `content` since the type now captures the meaning; the source-mirror field preserves what Roam said for round-trip and conflict-resolution purposes. Per the §3 hybrid naming rule, `status` is the shared-vocabulary field (flat name) and `roam:todo-state` is the namespaced source-mirror.

#### Reimport conflict semantics

The current Roam importer upserts deterministic IDs and replaces `content` / `properties` / `references` wholesale on existing rows. That's safe for source-authoritative snapshots but destroys app state on reimport:

1. Roam export says `TODO`. Import initialises `status = 'open'`.
2. User completes the task locally → `status = 'done'`.
3. Re-importing the same Roam export would plan `status = 'open'` again.
4. Wholesale overwrite loses the local completion.

**First-pass rule (v1):**

- **Type membership is additive.** If the Roam tag maps to a type the block doesn't yet have, `repo.addType` adds it. If the block already has that type, no-op.
- **Source-mirror fields (`roam:*`) refresh freely.** They represent "what the source said at this import." Always overwrite.
- **App-owned fields (`status`, `due`, anything not in the `roam:` namespace) initialise only if missing.** Reimport never overwrites an app-owned value that already exists. The `appOwnedInit` map in the tag-mapping table is passed to `repo.addType` as `initialValues` — these win over type defaults so source-specific values (e.g. `DONE → status='done'`) are honoured rather than overwritten by the type's default. On reimport, `addType` re-runs the materialisation pass but every `appOwnedInit` field already has a value and is skipped (the init-only-if-missing rule); app-owned fields stay as the user left them. `setup` doesn't re-run either since the type is already present.
- **Removed source markers** (Roam now lacks the marker that previously implied the type) do *not* automatically remove the type. Removing a tag in Roam shouldn't silently un-task the user's block.

**Second-pass rule (deferred):** track per-field source fingerprints — record what value was last imported for each source-mirrored field. On reimport, apply a source update only if the local value still equals the previous imported value. If both source and local changed, surface a conflict (or keep local by policy). The fingerprints live alongside the source mirror, e.g. `roam:todo-state-fingerprint` keyed by import session. Build this when reimport conflicts become a real problem; v1's "init-only-if-missing" rule covers the common case.

The same shape generalises to other importers (Notion, Obsidian) when they arrive — each owns its own tag-mapping table and source-mirror namespace (`notion:*`, `obsidian:*`).

## Out of scope (explicit non-goals for v1)

- **Type inheritance** — `extends`. Revisit only if duplication shows up.
- **Computed / derived fields** — `dueIn = due - now()`. Needs an expression language.
- **Workflow rules** — "when status flips to done, set completedAt = now". A `typeRulesFacet` is the natural shape but defer.
- **Server-side filtered sync** based on types. Local indexing for typed queries lives in SQLite (§8) — `block_types` and the existing `block_references` are local-only side tables — but PowerSync still pulls all blocks. Restricting which blocks sync based on types is a separate, deferred decision.
- **Tana-style per-supertag schema scoping** (`Project.status` vs `Task.status` as separately-scoped fields). v1 uses the §3 hybrid: shared-vocab fields are flat (one `status`, one codec), plugin-private fields are namespaced by name (`video:playerView`). True per-supertag scoping with same-name-different-meaning isn't planned.
- **User-defined property schemas from data**. v1 only lets data-defined types reference *existing* code-defined property schemas by name.
- **Required-field validation at edit time**. Type contributions can declare it as data, but enforcing at the editor is a follow-up.
- **Data-defined `type-definition` blocks + property-panel UI for non-coders.** v1 ships types-as-facet-contributions only; users author types via small extension blocks. The data-defined path lands later when there's user demand — design sketch lives in §9 so it's not lost.

## Phases

Each phase is independently shippable and testable.

### Phase 1 — `typesFacet`, `typesProp`, `block_types` index, addType/removeType

1. Add `typesFacet` and the `defineBlockType` identity helper to [src/data/facets.ts](src/data/facets.ts) / `@/data/api`.
2. Add `typesProp` schema to [src/data/properties.ts](src/data/properties.ts), include in `KERNEL_PROPERTY_SCHEMAS`.
3. Add pure helpers `getBlockTypes` / `hasBlockType` / `addBlockTypeToProperties` per §3-pure to [src/data/properties.ts](src/data/properties.ts).
4. Add the `block_types` table + triggers + backfill marker per §2a, in the kernel local-schema (mirror [src/plugins/backlinks/localSchema.ts](src/plugins/backlinks/localSchema.ts) shape).
5. Rewrite `SELECT_BLOCKS_BY_TYPE_SQL` and `findExtensionBlocksQuery` to join `block_types` ([src/data/internals/kernelQueries.ts:33](src/data/internals/kernelQueries.ts:33), [:384](src/data/internals/kernelQueries.ts:384)). Drop `idx_blocks_workspace_type` ([src/data/blockSchema.ts:111](src/data/blockSchema.ts:111)).
6. Extend `Repo.setFacetRuntime` per §3a to retain `types` and `propertySchemas` registries on `Repo`. These are the registries `repo.addType` / `block.get` overlay / `ProcessorCtx` propagation depend on.
7. Add `KERNEL_TYPE_CONTRIBUTIONS` for `'page'`, `'panel'`, `'journal'`, `'daily-note'`, `'extension'`.
8. Add `repo.addType(blockId, typeId)` / `repo.removeType(blockId, typeId)` / `repo.toggleType(blockId, typeId)` / `repo.setBlockTypes(blockId, typeIds)` as `Repo` methods (not registered mutators — see §3a). `addType` runs `contribution.setup?.()` per §3a-setup after applying defaults.
9. Add `Block` facade sugar: `block.types` getter, `block.hasType(id)`, `block.addType(id)`, `block.removeType(id)`, `block.toggleType(id)` ([src/data/block.ts](src/data/block.ts)). Use `hasType` at every type-decoration call site introduced in later phases.
10. Add `Repo.resolveDefault(types, schema)` per §3a-bis and update `block.get` to call it for the unset-property fallback (first-applicable-type default wins, falls back to `schema.defaultValue`). `peekProperty` is unchanged. The typed-query primitive in Phase 4 stays storage-only.
11. Update `useProperty` ([src/hooks/block.ts:252](src/hooks/block.ts:252)) to use the overlay via `repo.resolveDefault(types, schema)`. Add `useAppRuntime()` as a hook dependency so the selector closure rebuilds when the runtime swaps (per §3a-bis reactivity caveat — without this, retained-registry updates wouldn't invalidate `useHandle`). Add a parallel `usePeekProperty` returning `T | undefined` for raw-storage reads (no overlay, no runtime dep). Audit `useUIStateProperty`/`useRootUIStateProperty`/`useUserPrefsProperty` for accidental name collisions with type-contributed props.
12. One-shot data migration: backfill `properties.types = [oldType]` for every row with `properties.type` (clearing `properties.type`). The `block_types` triggers populate the side table from `properties.types` automatically.
13. Update every `typeProp` write site to call `repo.addType(blockId, typeId, initialValues?)` directly — never prewrite `typesProp` and then call `addType` (per §3-pure: `addType` still materialises defaults on re-call, but `setup` only fires on actual membership transitions, so prewriting silently bypasses any template/wiring the type defines). Bulk paths like the Roam importer iterate blocks and call `repo.addType` per row, passing source-specific app-owned values via `initialValues`. `addBlockTypeToProperties` is reserved for raw-`BlockData` callers (tests, processor snapshot rewrites, importer **plan** rows that have no runtime access) and never composes with `addType`.
14. Update every `typeProp` read site to read `typesProp` and `.includes(value)` / `[0]` (or use `block.hasType`/`block.types` once #9 lands; or `hasBlockType(data, ...)` for raw `BlockData`). Greps: `grep -rn "typeProp" src/`.
15. Remove `typeProp` from `KERNEL_PROPERTY_SCHEMAS` and from [properties.ts](src/data/properties.ts).

**Acceptance:** existing app behaviour unchanged. All current tests green. `repo` snapshots show `types: [...]` instead of `type:`. `findExtensionBlocks` returns the same set as before via `block_types` join. `repo.addType('some-existing-block', 'todo')` materialises the type's defaults and runs its `setup` (if any) atomically.

### Phase 2 — type-driven UI: renderer dispatch + property-panel field discovery

1. Update [src/hooks/useRendererRegistry.tsx](src/hooks/useRendererRegistry.tsx) to consult `typesFacet` per §4b.
2. Add `priority` to a few existing kernel type contributions so collisions resolve deterministically.
3. Update [src/components/BlockProperties.tsx](src/components/BlockProperties.tsx) per §3c: replace the `Object.entries(properties)` iteration with the union over actually-set + type-contributed schemas; render unset type-slots via the existing default-editor path with `repo.resolveDefault(block.types, schema)` so type-conditional defaults appear in the panel (matches §3a-bis).

**Acceptance:** removing every explicit `rendererProp` from current code paths still renders correctly because the type drives dispatch. Tagging a block with a type whose contribution declares properties surfaces those property slots in the panel even when unset, and editing one writes the property.

### Phase 3 — ref codecs + named-backlinks (`block_references.source_field` + `ProcessorCtx`)

1. Add `codecs.ref()` / `codecs.refList()` to [src/data/api/codecs.ts](src/data/api/codecs.ts) with runtime `isRefCodec` / `isRefListCodec` predicates.
2. Add `kind: 'ref' | 'refList'` to `PropertyKind`.
3. Extend `BlockReference` with optional `sourceField`.
4. **Local-schema delta per §6b**: add `source_field TEXT NOT NULL DEFAULT ''` column to `block_references`, change PK to `(source_id, target_id, alias, source_field)`, update INSERT/UPDATE triggers and `BACKFILL_BLOCK_REFERENCES_SQL` to read `$.sourceField` from `references_json`, gated by a new backfill marker (`block_references_source_field_v1`). Update `backlinksInvalidationRule` ([src/plugins/backlinks/invalidation.ts](src/plugins/backlinks/invalidation.ts)) to diff by `(id, sourceField)` per §6b so source-field-only changes invalidate grouped backlinks.
5. **`ProcessorCtx` extension per §7a**: add `propertySchemas: ReadonlyMap<string, AnyPropertySchema>` to `ProcessorCtx` ([src/data/api/processor.ts:110](src/data/api/processor.ts:110)). Add `propertySchemas` to `CommittedTxOutcome` ([src/data/internals/processorRunner.ts:55](src/data/internals/processorRunner.ts:55)) so it's snapshotted alongside `processors` at tx-start; the commit pipeline at [src/data/repo.ts:664](src/data/repo.ts:664) passes `this.propertySchemas` through. `processorRunner.dispatch` reads the bundle's snapshot rather than `repo.propertySchemas` directly so processors and schemas come from the same resolved runtime.
6. Extend `backlinks.parseReferences` ([src/plugins/backlinks/referencesProcessor.ts](src/plugins/backlinks/referencesProcessor.ts)) to also walk ref-typed properties (using `ctx.propertySchemas` to identify ref codecs); watch `properties` field too. Per §7, isolate each property decode in a try/catch so one malformed value doesn't poison the whole projector run.
7. Add ref-codec-set diff + reprojection pass to `setFacetRuntime` per §7-bis: detect property names whose ref-ness changed between the old and new `propertySchemas` maps, schedule a one-shot processor that re-runs the property-walk over blocks containing those names. Backfills new ref edges and clears stale ones. Tx scope is `References`.
8. Add `source_field`-aware grouping mode to [src/plugins/grouped-backlinks/](src/plugins/grouped-backlinks/).

**Acceptance:** a block with a ref-typed property pointing to another block surfaces in the target's grouped backlinks under the property name; two property refs from the same source to the same target via different fields don't collapse.

### Phase 4 — reactive typed-query primitive (SQLite-backed)

1. Implement `repo.queryBlocks` / `repo.subscribeBlocks` per §8 backed by SQL: `EXISTS` subqueries against `block_types` for type filters and `block_references` for `referencedBy` (avoids duplicating block rows when multiple edge rows match); `json_extract(properties_json, ?) = ?` for scalar `where` — bind the JSON path (built safely per §8 to handle property names containing `:`/`-`/`.`) and the codec-encoded value as parameters. Refuse the query when no schema is registered for a referenced field; refuse `where` on non-scalar kinds (`list`, `object`, `ref`, `refList`) per §8; refuse `undefined` `where` values; compile encoded `null` to `IS NULL` (matches both unset and explicit-null per §8). Per-property indexes added incrementally as hot fields are identified, following the same path-quoting rule.
2. Wire `subscribeBlocks` to the existing repo change-notification stream (which is already row-event-aware) so updates flow from both local commits and sync-applied changes.
3. Add `useBlockQuery` hook in `src/hooks/`.

**Acceptance:** subscribing to `{ types: ['todo'] }` returns a live list that updates when a block is tagged/untagged, including across a remote sync apply (e.g. another device adds a todo).

### Phase 5 — Roam todo import (downstream consumer)

1. Add `TAG_TO_TYPE` map to importer per the Migration section's expanded shape (separate `appOwnedInit` from `sourceMirror`).
2. Add `'todo'` type contribution (its own small plugin, `src/plugins/todo/`) with `statusProp` (shared-vocab, flat name), a checkbox decorator via `blockContentDecoratorsFacet` gated on `block.hasType('todo')`, and `defaults: {[statusProp.name]: 'open'}` so freshly-tagged blocks default open.
3. Add namespaced `roam:todo-state` schema in the importer (or a `roam` plugin) for the source-mirror field.
4. **Change `upsertImportedBlock` ([src/utils/roamImport/import.ts:756](src/utils/roamImport/import.ts:756)) to merge properties on live-row hits, using an explicit app-owned allowlist.** Today's path is "last-write-wins": on an existing row it `tx.update`s `content`/`properties`/`references` with the planned values, dropping any local edits. That destroys app-owned state on reimport *before* any subsequent `repo.addType` runs — `appOwnedInit` then sees the imported value already there and skips, preserving the wrong thing (the source value, not the user's local edit). The fix isn't "namespace as classifier" though — the importer already plans source-authoritative non-`roam:` fields too (e.g. `alias` on pages, type-marker properties, page attribute promotions), and reimport SHOULD refresh those. Required behaviour:
   - **`content` and `references`**: still overwrite (Roam content is source-authoritative; references are recomputed from content via the backlinks processor anyway).
   - **`properties`**: per-key merge driven by an **explicit app-owned allowlist** carried alongside the plan. Each TAG_TO_TYPE entry already declares its app-owned fields via `appOwnedInit` keys; the planner unions those into a per-block `appOwnedFields: Set<string>` (typically `{ 'status' }` for a Roam todo block, possibly empty for a non-task page). On upsert:
     - Keys in `appOwnedFields` AND already present on the existing row → keep existing value (the user's local edit survives).
     - All other keys (everything the importer planned that *isn't* in `appOwnedFields`, including `alias`, the type marker, source-mirror `roam:*`, page attributes) → overwrite with the planned value.
     - Keys present on the existing row but NOT in the planned `properties` and NOT in `appOwnedFields` → keep (the user's ad-hoc props on the block survive reimport).
   - For brand-new blocks (`createOrGet → inserted: true`), no merge is needed — the planned properties are the only state.
   The simplest implementation: split `upsertImportedBlock` into "create new" (current path) and "merge into existing." The merge path takes `(existing, planned, appOwnedFields)` and computes the merged properties map. The plan-side `appOwnedInit` for the source's TODO/DONE state continues to flow through `repo.addType`'s `initialValues` arg — it's the safety net for blocks that arrive without source-mirror state (e.g. tagged on a device that didn't have the contribution), not the primary write path for re-imported live rows.
5. On import, for each Roam block carrying a `{{[[TODO]]}}` / `{{[[DONE]]}}` marker:
   - Call `repo.addType(blockId, 'todo', appOwnedInit)` — pass the source-specific app-owned values via the third arg per §3a. addType is idempotent and always runs init-if-missing materialisation (so already-typed blocks from sync without contribution / raw `typesProp` writes still get their `status` filled in); `setup` only fires on actual first transitions.
   - Write the source-mirror field (`roam:todo-state`) freely (always-overwrite via `block.set`).
   - Strip the marker from `content`.

**Acceptance:** importing a Roam graph with `#TODO`/`#DONE` blocks produces blocks with `types: ['todo']`, matching `status`, and `roam:todo-state` reflecting the source. Surfaced via the todo checkbox decorator and queryable via `useBlockQuery({types: ['todo'], where: {status: 'open'}})`. **Reimport-after-local-change preserves user state**: locally completing a task (`status='done'`) and reimporting the original Roam export leaves `status='done'` untouched (the upsert merge preserves the local app-owned value) while `roam:todo-state` refreshes to `'TODO'` (source-mirror semantics). Verified against the importer write path, not just the `addType` path.

## Open questions for the implementer

- **Where `KERNEL_TYPE_CONTRIBUTIONS` is registered.** `kernelDataExtension` is the natural home (matches `KERNEL_PROPERTY_SCHEMAS`). Confirm by reading the kernel-extension wire-up before adding.
- **`removeType` cleanup policy.** v1 just removes from `typesProp` and leaves properties intact (defaults become inert). If this proves leaky in practice, add a "clear properties whose only contributing type is being removed" rule — but only after seeing the failure mode.
- **Per-property indexes for typed queries.** Phase 4 starts with `json_extract` scans. Add expression indexes per hot field (e.g. `idx_blocks_status` on `json_extract(properties_json, '$.status')`) only when query latency shows up — easier to add later than to remove.
- **Source-fingerprint reimport (deferred from Phase 5).** When the basic init-only-if-missing rule isn't enough — typically when a single Roam export is reimported many times and users expect Roam-side edits to flow through to fields they haven't locally touched — implement per-field source fingerprints so source updates apply when the local value still equals the previous import. v1's rule is conservative and won't blow up local state; the upgrade path is well-defined.
