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
  /** Properties that apply to blocks of this type. Carries the
   *  schema *objects* (not just names): the type contribution is
   *  the registration. The lift happens in `Repo.setFacetRuntime`
   *  via `mergeLiftedSchemas` (§1a) — NOT in `typesFacet.combine`,
   *  because a facet's combine function only sees that facet's
   *  contributions and can't read another facet's registrations.
   *  The runtime merge step is what folds these schemas into the
   *  same flat name-keyed registry that `propertySchemasFacet.of(...)`
   *  populates (single-source-of-truth — see §1a). Multiple types
   *  listing the same imported `statusProp` (object identity) dedup
   *  harmlessly; different objects with the same name follow the
   *  kernel's uniform last-wins-with-warn convention.
   *
   *  Drives field discovery in BlockProperties and the property
   *  panel. Use `AnyPropertySchema` (`PropertySchema<any>`) —
   *  `PropertySchema<T>` is invariant in this repo's variance
   *  model, mirroring `AnyMutator` / `AnyQuery`, so
   *  `PropertySchema<unknown>` will not accept real typed schemas
   *  like `PropertySchema<string>`. See
   *  [src/data/api/propertySchema.ts:90](src/data/api/propertySchema.ts:90). */
  readonly properties?: ReadonlyArray<AnyPropertySchema>
  /** Optional human label for the property panel / quick-find. */
  readonly label?: string
  /** Optional longer description for hover tooltips in type pickers and
   *  the property panel section header. */
  readonly description?: string
  /** Optional escape hatch for type-add work that needs more than the
   *  per-call `initialValues` arg can express. Runs once when `addType`
   *  first applies this type to a block, after the caller-provided
   *  initial values are written, inside the same tx. See §3a-setup.
   *  Use sparingly — it's a code-execution hatch in the type registry.
   *  Common cases: child-block templates (meeting → Attendees / Agenda /
   *  Action items), computed initial values (`due = now() + 7 days`),
   *  cross-block wiring at add time. Setup callbacks that write
   *  block-level fields they don't strictly own should follow
   *  init-if-missing semantics so a re-add or competing call doesn't
   *  clobber a user value. */
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

#### 1a. Schema lift: type contributions register their schemas

A type contribution's `properties[]` carries `PropertySchema` *objects*, and **the runtime build step (`Repo.setFacetRuntime`) lifts those schemas into the same flat name-keyed `propertySchemas` map that `propertySchemasFacet.of(...)` populates** ([src/data/facets.ts:114](src/data/facets.ts:114)). The lift can't live inside `typesFacet`'s `combine` because a facet's combine function only sees its own contributions — it can't read `propertySchemasFacet`'s. So the merge runs once per runtime swap in `setFacetRuntime` after both facets have been read; see the implementation sketch below. One merged registry, two contribution paths, single source of truth.

The reason: without the lift, a type contribution's `properties[]` would store schema objects that the rest of the system has to ignore in favor of `propertySchemasFacet`'s registry-by-name lookup — which means a type can list `statusPropA` but if some `propertySchemasFacet.of(statusPropB)` registration wins globally under the same name, decoders / encoders / the property panel silently use `statusPropB`. The schema object on the contribution becomes confusingly vestigial. The lift removes the parallel-registry problem: the contribution IS the registration.

Implementation shape (the runtime build, not the facet's combine itself, since one facet can't read another's contributions during its own combine):

```ts
// In Repo.setFacetRuntime (after both reads), build the merged map:
const directSchemas = runtime.read(propertySchemasFacet)  // existing
const types = runtime.read(typesFacet)                    // existing

const mergedSchemas = new Map<string, AnyPropertySchema>()
// Type-lifted schemas first — these are the type's "default
// understanding" of its fields. Last-wins among lifted, by
// types-registration order.
for (const t of types.values()) {
  for (const schema of t.properties ?? []) {
    const existing = mergedSchemas.get(schema.name)
    if (existing && existing !== schema) {
      console.warn(
        `[schema-lift] type "${t.id}" registers schema "${schema.name}" ` +
        `that conflicts with an earlier type-lifted registration; last-wins per facet convention`,
      )
    }
    mergedSchemas.set(schema.name, schema)
  }
}
// Direct registrations second — these are the explicit "shared
// vocabulary" path per the §3 hybrid rule, and they take precedence
// over type-lifted entries. A plugin overrides a kernel type's
// schema by registering directly after; the existing
// "register-after-to-override" pattern works uniformly for direct
// registrations regardless of source.
for (const [name, schema] of directSchemas) {
  const existing = mergedSchemas.get(name)
  if (existing && existing !== schema) {
    console.warn(
      `[schema-lift] direct propertySchemasFacet registration "${name}" ` +
      `replaces an earlier (type-lifted or direct) registration; last-wins per facet convention`,
    )
  }
  mergedSchemas.set(name, schema)
}
this._propertySchemas = mergedSchemas
```

Properties this gives:

1. **Object-identity dedup.** The most common case: shared schemas declared once in a kernel/shared module and imported by multiple type contributions. `todo` and `task` both list the imported `statusProp` — same object, no warn, one registry entry.
2. **Last-wins-with-warn on real conflicts.** Two contributions registering different `statusProp` objects under the same name follow the same convention as every other facet ([src/data/facets.ts:121](src/data/facets.ts:121)).
3. **Direct registrations always win over type-lifted ones.** This is the deliberate ordering choice. The §3 hybrid rule says shared vocabulary lives in `propertySchemasFacet` directly; type contributions list shared schemas to declare *membership*, but the canonical registration is the direct one. So direct second / wins, type-lifted first / loses. This preserves the existing "register after to override" pattern uniformly for any plugin that wants to replace a kernel schema — whether the kernel registered it directly or via a type contribution, a plugin's `propertySchemasFacet.of(...)` after the kernel always wins.
4. **No cross-source ordering between two type-lifted entries and a direct registration interleaved.** The merge runs lifted-first / direct-second as two passes, not in unified registration order across both facets — that would require runtime API changes beyond v1's scope. In practice this only differs from unified ordering when a plugin registers BOTH a type-lifted schema and a direct schema for the same name in a specific interleaved order with kernel registrations; the §3 hybrid rule means this shouldn't happen in well-behaved code. If it does, the rule is "direct wins" regardless of relative load order.

The shape applies whether `properties[]` carries 1 schema or 30. A type contribution that lists no schemas (an `extension` type with all its data in `roam:*`-style namespaced source-mirror fields) lifts nothing — fully compatible with the §3 hybrid rule.

A separate strict-mode-with-`overrides:` target mechanism (declared override of a named earlier registration; throws if target is missing; replaces silently if present) is a deferred follow-up — see follow-ups doc. It would also bring full unified ordering (declared-target overrides are explicit, no implicit ordering needed). v1 ships the lift + last-wins-with-warn + lifted-first/direct-second pass order described above.

#### 1a-public. The merged map is the public schema registry

Consumers outside `Repo` — `BlockProperties`, the typed-query primitive, plugin code reading schemas — must read the **merged** map, not `propertySchemasFacet` directly, otherwise type-lifted-only schemas (anything contributed exclusively through a type's `properties[]`) won't be visible.

Concretely:

- `Repo` exposes `get propertySchemas(): ReadonlyMap<string, AnyPropertySchema>` — a read-only public getter over the same map populated by the merge above. Backed by a private `_propertySchemas` field (TypeScript doesn't allow a private field and a public getter to share an identifier).
- React consumers go through a small hook `usePropertySchemas()`. The hook **must subscribe to the runtime context**, not just read `useRepo().propertySchemas` directly: `Repo`'s identity is stable across `setFacetRuntime` swaps, so a plain `useRepo()` read won't re-render when the merged map changes (a newly loaded type-lifted schema would stay invisible in `BlockProperties` until some unrelated subscription fires).
  ```ts
  // src/hooks/propertySchemas.ts (new)
  export const usePropertySchemas = (): ReadonlyMap<string, AnyPropertySchema> => {
    // useAppRuntime ([src/extensions/runtimeContext.ts:8](src/extensions/runtimeContext.ts:8))
    // changes identity on every setFacetRuntime via the
    // appRuntimeUpdateEvent listener wired up in
    // [AppRuntimeProvider.tsx:61](src/extensions/AppRuntimeProvider.tsx:61).
    // Reading it here makes this hook a subscriber: any runtime
    // swap re-renders consumers, and Repo.propertySchemas is read
    // *after* setFacetRuntime has already updated the merged map.
    useAppRuntime()
    return useRepo().propertySchemas
  }
  ```
  The `useAppRuntime()` read is the subscription dependency, even though we're not using its return value — it's the "why this hook re-renders." Comment that intent at the call site so a future reader doesn't delete it as dead code. (If a derived-facet primitive lands later — `runtime.derived(...)` — the hook becomes `runtime.read(derivedPropertySchemasFacet)` and the indirection through Repo goes away. Until then, `useAppRuntime()` + `useRepo().propertySchemas` is the path.)
- `propertySchemasFacet` itself is **not** read directly by app code outside `Repo` after this lands. Audit and migrate every `runtime.read(propertySchemasFacet)` call site to read the merged map. The grep target is small today: [src/components/BlockProperties.tsx](src/components/BlockProperties.tsx) is the only direct consumer; processor code reads via `ProcessorCtx.propertySchemas` (already snapshotted from the merged map per §7a); the typed-query primitive reads via `Repo.propertySchemas`. Phase 1's checklist enforces this audit.

The lift mechanism itself stays internal to the runtime build — `propertySchemasFacet` doesn't change shape, `typesFacet` doesn't change shape; the merge is a two-input function in `setFacetRuntime`. The public surface is just the getter.

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

Reuse `PropertySchema` as the field primitive — the merged `propertySchemas` registry (per §1a: `propertySchemasFacet` direct registrations plus type-lifted schemas) stays one global registry keyed by `name`. The convention for *what to name a schema* is hybrid:

- **Flat** for shared-vocabulary fields whose meaning is consistent across types and that an untagged block could plausibly use the same way: `status`, `due`, `priority`, `tags`, `description`, `assignee`. One `statusProp` exists with one global default and one codec; multiple types list it in their `properties[]`, and a typeless block can read/write it via `block.set(statusProp, …)` without picking a "which status" namespace. If two types disagree on the value space (todo: `'open' | 'done'` vs meeting: `'scheduled' | 'happening' | 'finished' | 'cancelled'`), their codecs differ and §3 says use distinct schema names — that's a different field, not a shared field with per-type defaults.
- **Namespaced** for type-private / plugin-internal fields whose meaning is meaningless or confusing elsewhere: `video:playerView` (whether the video player is in notes mode — only the video plugin understands this), `roam:todo-state` (source-mirror metadata for round-trip — only the Roam importer cares), `extension:disabled` (already exists as `system:disabled`). These exist purely because *one* type needs them; namespacing prevents accidental collision with shared vocab and signals the limited scope.
- **Heuristic when in doubt:** could a different type or a typeless block reasonably use this field with the same meaning? Yes → flat. No → namespace. When two types genuinely want the same field name with **incompatible codec semantics**, namespace one (or both) — but this is rare in practice.

This sidesteps Tana-style per-supertag schema scoping (which makes "set status on an untagged block" ill-defined). Flat for `status` keeps that operation valid and unambiguous; namespacing for `video:playerView` keeps the video plugin's UI-state from polluting the shared vocabulary.

What still belongs on the type contribution rather than on the schema:

- **Per-type `properties[]` membership** → which schemas appear in this type's section of the property panel; a flat `statusProp` listed by both `todo` and `task` shows up under both.
- **Per-type `setup` callbacks** → child-block templates, computed initial values, cross-block wiring at add time (§3a-setup).

Defaults belong on the schema (one global per field), not on per-type overrides — the §3 hybrid rule covers value-space differences by namespacing into a different field rather than by overriding a shared field's default. Ref-target constraints — "this `tasks` field accepts only Task-typed blocks" — live on the codec itself, also not on per-type overrides; see §5.

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
 *  Does NOT materialise per-call `initialValues` and does NOT run
 *  `setup`. Type contributions don't carry defaults (schema-level
 *  defaultValue is read-time fallback only — see §3); the only
 *  per-add-call materialisation is `initialValues` passed into
 *  `repo.addType` / `repo.addTypeInTx`, which is what callers
 *  should route through if they want fields populated atomically
 *  with the membership write. */
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

These are deliberately small. Registry resolution, `initialValues` materialisation, and `setup` all happen inside `repo.addType` — these helpers don't replicate any of that.

**Important: `addBlockTypeToProperties` does NOT run `setup` or apply `initialValues`.** It's a *raw membership writer* for paths that genuinely can't reach `repo.addType` — fixture construction in tests, processor snapshot rewrites, importer **plan** code that builds row shapes before commit. **Don't pre-write membership and then call `repo.addType` expecting `setup` to fire**: `repo.addType` will still run init-if-missing materialisation against any `initialValues` you pass on a re-call, but `setup` only fires when `addType` actually transitions the block from "doesn't have type" to "does have type." Pre-writing typesProp via raw `tx.update` makes that transition invisible to `addType` — `setup` never runs.

The right boundary: paths that need full type-add semantics (`initialValues` materialisation + `setup`) call the type-system orchestration entry point directly without prewriting. App-level callers outside an existing tx use `repo.addType`. The Roam importer's apply phase is already inside chunked `repo.tx` calls — it must use `repo.addTypeInTx(tx, blockId, 'todo', initialValues?, snapshot?)` per row to share atomicity with the surrounding `upsertImportedBlock` writes; calling the public `repo.addType` from inside an active tx would either fail against the writer slot or open a separate tx and lose the atomicity guarantee. Either way the importer does **not** stamp `typesProp` itself. Plan code that constructs `BlockData` rows pre-tx (deterministic-id paths) can use `addBlockTypeToProperties` — those paths get tagged blocks but don't get `setup` execution or `initialValues` materialisation. Read fallbacks come from `PropertySchema.defaultValue` automatically; `initialValues` skipped here just means the block reads its schema default until something writes the field.

#### 3a. `addType` / `removeType` — orchestration that owns membership, init values, and setup

Type tagging needs a central orchestration point that materialises caller-supplied initial values and runs any `setup` callback in the same tx as the membership write. Without it, every tag-mapping path (importer, command, agent action) has to hand-roll the sequence and forget pieces. Schema-level defaults still surface via `block.get` for unset fields without any per-call work — that path is unchanged. Per-call `initialValues` (typically the source-specific app-owned values an importer wants to apply atomically with the tag) flow through `addType`'s materialisation pass.

**API surface: `repo.addType` / `repo.removeType` are `Repo` methods, not registered mutators.** The `Mutator.apply: (tx, args) => Promise<R>` signature ([src/data/api/mutator.ts:9](src/data/api/mutator.ts:9)) deliberately doesn't carry runtime/registry access, and `addType` needs `typesFacet` (to look up the contribution's `setup` callback and verify the type id is registered) and `propertySchemasFacet` (to encode caller-supplied `initialValues` through the right codec — schemas don't follow callers around as values). Adding a context arg to the mutator surface is a broad change for one call site; making `addType` a `Repo` method is the conservative fit — `Repo` is the natural home for orchestration that spans facet lookups + tx writes. (Pattern parallel: `repo.tx`, `repo.mutate.X` for low-level ops; `repo.addType` for type-system orchestration that needs registry access.) There are no per-type defaults to apply — schema-level `defaultValue` is read-time fallback only, surfaced through `block.get` without any registry lookup at write time.

**`Repo` must retain the registries it needs.** `Repo.setFacetRuntime` ([src/data/repo.ts:738](src/data/repo.ts:738)) today only extracts `mutators`, `processors`, `invalidationRules`, and `queries` — it does NOT store the runtime, `typesFacet`, or `propertySchemasFacet`. Phase 1 must extend `setFacetRuntime` to also retain narrower registries needed by type-system orchestration:

```ts
// Inside Repo. Backing fields are underscore-prefixed because the
// public API exposes a `get propertySchemas()` getter (§1a-public)
// — TypeScript doesn't allow a private field and a public getter
// to share an identifier on the same class.
private _types: ReadonlyMap<string, TypeContribution> = new Map()
private _propertySchemas: ReadonlyMap<string, AnyPropertySchema> = new Map()

get types(): ReadonlyMap<string, TypeContribution> {
  return this._types
}
get propertySchemas(): ReadonlyMap<string, AnyPropertySchema> {
  return this._propertySchemas
}

setFacetRuntime(runtime: FacetRuntime): void {
  this.mutators = new Map(runtime.read(mutatorsFacet))
  this.processors = new Map(runtime.read(postCommitProcessorsFacet))
  this.invalidationRules = runtime.read(invalidationRulesFacet)
  this._types = runtime.read(typesFacet)                   // NEW
  // §1a schema-lift: merge type-lifted schemas (from typesFacet
  // contributions' properties[]) with direct propertySchemasFacet
  // registrations. Type-lifted FIRST, direct SECOND — direct
  // registrations override type-lifted entries with the same name,
  // preserving the kernel's "register-after-to-override" pattern
  // uniformly across sources. Last-wins-with-warn on real
  // conflicts; object-identity dedup is silent. The merged map is
  // the single source of truth used by addType encoding,
  // BlockProperties (§3c), processors via CommittedTxOutcome
  // (§7a), the typed-query primitive (§8), etc.
  this._propertySchemas = mergeLiftedSchemas(
    runtime.read(propertySchemasFacet),
    this._types,
  )
  const newQueries = new Map(runtime.read(queriesFacet))
  this.swapQueries(newQueries)
}
```

`mergeLiftedSchemas` is the helper sketched in §1a (lifted-first / direct-second). Storing the narrower registries (vs. holding a `runtime: FacetRuntime` field) keeps the surface small — `Repo` only sees what type-system orchestration needs, no general extension-runtime exposure. The public getters expose them to consumers that need read access (the `usePropertySchemas` hook, the typed-query primitive); the underscore-prefixed backing fields are written only by `setFacetRuntime`. Internal code on `Repo` itself (in-tx primitives, snapshot helpers) can read either form — the sketches below use `this._propertySchemas` / `this._types` for clarity that they're touching the backing slot. `addType` reads `_types` for `setup` lookup and contribution existence, and `_propertySchemas` for `initialValues` codec encoding. (Reads don't need either registry — schema defaults live on `PropertySchema.defaultValue` and surface naturally through `block.get` / `useProperty` without any type-aware overlay.) The same retained merged `_propertySchemas` map is what gets snapshotted into `CommittedTxOutcome.propertySchemas` at tx-start (§7a), so processors see schemas from the same resolved runtime that produced their registry snapshot.

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
  if (!contribution) {
    // Verify the type id is registered. Silently persisting an
    // unknown type id papers over typos / load-order mistakes /
    // missing plugins, and skips `setup` for a type the caller
    // believed was registered. The §3 facade comment explicitly
    // says blocks may carry types whose contribution is not yet
    // registered (sync from another device, deferred type-def
    // block, dynamic extension still loading) — but those rows
    // arrive via raw row writes from sync, NOT through this
    // orchestration entry point. Anything that goes through
    // addType is a deliberate local action and the type id should
    // resolve. Throw and let the caller decide whether to import
    // the contribution, fall back to addBlockTypeToProperties for
    // raw membership, or fix the typo.
    throw new Error(
      `[addType] type id ${JSON.stringify(typeId)} is not registered. ` +
      `Register the contribution via typesFacet before calling addType, ` +
      `or use addBlockTypeToProperties for raw membership writes that ` +
      `intentionally bypass setup / initialValues.`,
    )
  }
  const block = await tx.get(blockId)
  if (!block) return
  const current = (block.properties[typesProp.name] as string[] | undefined) ?? []
  const wasNew = !current.includes(typeId)
  const next: Record<string, unknown> = { ...block.properties }
  if (wasNew) {
    next[typesProp.name] = typesProp.codec.encode([...current, typeId])
  }
  // Init-if-missing materialisation for caller-supplied initial values.
  // Schema-level defaults aren't applied here — they live on
  // PropertySchema.defaultValue and surface naturally on read via
  // block.get / useProperty. Type contributions don't carry defaults
  // (per §3 hybrid: value-space differences become distinct schemas).
  //
  // Every initialValues key MUST resolve to a registered schema —
  // codecs define the storage shape (date → ISO string, optional →
  // sentinel-or-value, custom codecs → arbitrary), and writing a
  // raw decoded value through bypasses that and silently corrupts
  // the row. Throw on unknown names; the caller has either typo'd
  // or is depending on a plugin that isn't loaded, both worth
  // surfacing loudly.
  let propsChanged = wasNew
  for (const [name, value] of Object.entries(initialValues)) {
    if (next[name] === undefined) {
      const schema = propertySchemas.get(name)
      if (!schema) {
        throw new Error(
          `[addType] initialValues['${name}'] has no registered PropertySchema. ` +
          `Register the schema (propertySchemasFacet) before passing it as an initial value, ` +
          `or pass a pre-encoded raw value via tx.update directly if that's intentional.`,
        )
      }
      next[name] = schema.codec.encode(value)
      propsChanged = true
    }
  }
  if (propsChanged) await tx.update(blockId, { properties: next })
  if (wasNew) await contribution.setup?.({ tx, id: blockId, repo: this, types, propertySchemas })
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
  /** Per-call initial values, encoded through each registered
   *  PropertySchema's codec and written init-if-missing in the
   *  same tx as the membership write. Importers and "create with
   *  state" callers use this to set app-owned fields atomically
   *  with the tag (e.g. Roam DONE → `status='done'`). Already-set
   *  values are NOT overwritten — re-calling addType with a
   *  different status does nothing to a block that already has a
   *  status. Type contributions don't carry their own defaults,
   *  so there's no "type default" for these values to take
   *  precedence over; an unset field reads its
   *  `PropertySchema.defaultValue` via the normal block.get /
   *  useProperty fallback regardless of any type membership.
   *  Every key MUST resolve to a registered schema — see the
   *  in-tx primitive's encode loop for why raw fallthrough is
   *  unsafe. */
  initialValues: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  const types = this._types
  const propertySchemas = this._propertySchemas
  await this.tx(async tx => {
    await this._addTypeInTx(tx, types, propertySchemas, blockId, typeId, initialValues)
  }, { scope: ChangeScope.BlockDefault, description: `addType ${typeId}` })
}

async removeType(blockId: string, typeId: string): Promise<void> {
  await this.tx(async tx => {
    await this._removeTypeInTx(tx, blockId, typeId)
  }, { scope: ChangeScope.BlockDefault, description: `removeType ${typeId}` })
}

/** Captured registry snapshot for callers that need consistency across
 *  many addTypeInTx calls inside one tx (importer loops, multi-row
 *  apply paths). Take the snapshot once via `repo.snapshotTypeRegistries()`
 *  before opening the outer tx, then thread the snapshot through every
 *  addTypeInTx call inside the tx. */
export interface TypeRegistrySnapshot {
  readonly types: ReadonlyMap<string, TypeContribution>
  readonly propertySchemas: ReadonlyMap<string, AnyPropertySchema>
}

/** Public method, returns the current registries as a frozen pair.
 *  Importers / orchestration code call this once before their tx
 *  loop. */
snapshotTypeRegistries(): TypeRegistrySnapshot {
  return { types: this._types, propertySchemas: this._propertySchemas }
}

/** Public tx-aware helper for callers that already hold a tx
 *  (importers running batched repo.tx chunks, plugin code orchestrating
 *  multi-step writes). Optional `snapshot` arg pins the registry pair
 *  to one captured value across many calls inside the same tx; without
 *  it, registries are re-read at call time (fine for one-off calls
 *  where setFacetRuntime mid-call is sufficiently rare).
 *
 *  Importer pattern:
 *  ```ts
 *  const snap = repo.snapshotTypeRegistries()
 *  await repo.tx(async tx => {
 *    for (const block of chunk) {
 *      await upsertImportedBlock(tx, block.data)
 *      await repo.addTypeInTx(tx, block.id, 'todo', appOwnedInit, snap)
 *    }
 *  }, { ... })
 *  ``` */
async addTypeInTx(
  tx: Tx,
  blockId: string,
  typeId: string,
  initialValues: Readonly<Record<string, unknown>> = {},
  snapshot?: TypeRegistrySnapshot,
): Promise<void> {
  const types = snapshot?.types ?? this._types
  const propertySchemas = snapshot?.propertySchemas ?? this._propertySchemas
  await this._addTypeInTx(tx, types, propertySchemas, blockId, typeId, initialValues)
}

/** Symmetric for completeness — composers needing remove inside an
 *  existing tx (`setBlockTypes`'s in-tx body, importer chunks that
 *  also need un-tagging). */
async removeTypeInTx(tx: Tx, blockId: string, typeId: string): Promise<void> {
  await this._removeTypeInTx(tx, blockId, typeId)
}

async toggleType(blockId: string, typeId: string): Promise<void> {
  // Decision and write in ONE tx so concurrent toggles serialise
  // correctly. Two concurrent toggles from an initially-untyped block
  // both end up tagged otherwise: the load()-then-decide pattern lets
  // both branches choose addType, the second is a no-op and the user
  // expected toggle1+toggle2 to net out.
  const types = this._types
  const propertySchemas = this._propertySchemas
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
  //   2. addTypeInTx for desired types — passes initialValues = {}
  //      because setBlockTypes is a membership-shaping API, not a
  //      field-materialisation one. For first-time additions this
  //      runs `setup` (transition triggers it). For already-present
  //      types it's a no-op on fields. setBlockTypes does NOT
  //      "repair" missing app-owned fields on already-typed blocks
  //      — there's nothing to repair from, since type contributions
  //      no longer carry defaults; field values come from per-call
  //      `initialValues` to addType, which setBlockTypes can't
  //      synthesize. Callers that want to materialise fields go
  //      through repo.addType / addTypeInTx directly with the
  //      relevant initialValues map.
  //   3. Rewrite typesProp to the deduped desired order if it doesn't
  //      already match. addType only appends, so existing memberships
  //      keep their original positions; without the rewrite, current
  //      = ['b','a'] + setBlockTypes(['a','b']) stays ['b','a']. Order
  //      matters for: deterministic storage / diffs, the §3c per-type
  //      property-panel section ordering, the order setup callbacks
  //      see when they iterate types, and the renderer-resolution
  //      `body:byType` walk order documented in
  //      [docs/renderer-resolution.md](docs/renderer-resolution.md).
  //      No type-aware read overlay exists, so order does NOT change
  //      which type's "default wins" for shared fields — that read
  //      path goes straight to PropertySchema.defaultValue.
  const desiredOrder = Array.from(new Set(typeIds))
  const types = this._types
  const propertySchemas = this._propertySchemas
  await this.tx(async tx => {
    const block = await tx.get(blockId)
    if (!block) return
    const current = (block.properties[typesProp.name] as string[] | undefined) ?? []
    const want = new Set(desiredOrder)
    for (const t of current) {
      if (!want.has(t)) await this._removeTypeInTx(tx, blockId, t)
    }
    // Only run _addTypeInTx for ids that aren't already on the block.
    // For ids already in `current`, no membership transition is
    // happening — _addTypeInTx would early-return on the wasNew
    // check anyway except that its registry-existence guard now
    // throws on unregistered ids (§3a). A block that arrived from
    // sync or an unloaded plugin can carry a typeId we don't
    // recognise locally; preserving it through setBlockTypes must
    // not throw just because we're keeping it in place. Skip the
    // _addTypeInTx call for already-present ids; the order rewrite
    // below preserves them positionally regardless of registration.
    const currentSet = new Set(current)
    for (const t of desiredOrder) {
      if (currentSet.has(t)) continue
      await this._addTypeInTx(tx, types, propertySchemas, blockId, t, {})
    }
    // Final order rewrite — addType only appends, so existing
    // memberships keep their position; e.g. current = ['b','a'] +
    // setBlockTypes(['a','b']) would stay ['b','a'] without this.
    // setBlockTypes passes initialValues = {} per type, so this
    // step does NOT affect any per-call materialisation conflict
    // (there is none to conflict over). What it does affect:
    // deterministic storage / diffs across calls, the §3c per-type
    // panel section ordering, the order setup callbacks see when
    // they iterate types, and the renderer-resolution body:byType
    // walk per [docs/renderer-resolution.md](docs/renderer-resolution.md).
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

Every tag-mapping path goes through the type-system orchestration entry points — outside an existing tx use `repo.addType` (agent commands, command-palette "Add tag" action, app-level UI), inside an existing tx use `repo.addTypeInTx` (Roam importer chunks around `upsertImportedBlock`, plugin code orchestrating multi-step writes). Calling the public `repo.addType` from inside an active tx would either fail against the writer slot or open a separate tx and lose atomicity with the surrounding writes. Direct `tx.update` writes to `typesProp` are discouraged either way — add a lint or engine guard if needed.

No type-aware read-time overlay exists. `block.get` returns `schema.defaultValue` for unset properties (current behaviour, unchanged); `useProperty` does the same; the typed-query primitive (§8) reads materialised state directly. The §3 hybrid rule means a value-space difference becomes a different schema with its own default rather than a per-type override of a shared field, which keeps the read paths simple — no cross-registry lookup needed for the unset-property case.

#### 3a-setup. The `setup` escape hatch beyond `initialValues`

`initialValues` covers static caller-supplied values per add. A handful of legitimate type-add behaviors fall outside that:

- **Child-block templates.** `meeting` creates child blocks for *Attendees*, *Agenda*, *Action items*. `project` creates *Tasks* and *Notes* container children. `daily-note` pre-populates the daily template structure.
- **Computed initial values defined by the type** (not supplied by every caller). `due = now() + 7 days`. `weekNumber = isoWeek(today)`. Type-specific computations the caller shouldn't have to reproduce.
- **Cross-block wiring at add time.** Setting `project = parent.id` when a `task` is added under a `project`-typed parent. (Borderline — react-to-context fits workflow rules better, but if it should fire *only* on the initial tag, `setup` is the place.)
- **Side effects sharing the tx.** Append a row to a side table or an "All Tasks" inbox subtree, with the same tx so undo of the type-add cleanly removes everything together.

The hook fires inside `repo.addType` after `initialValues` are written, in the same tx. `removeType` doesn't run a teardown — use the same "we don't clean up on remove in v1" rule as for properties; types that ship complex setups should be ones users add and rarely undo.

```ts
import { createChild } from '@/data/internals/kernelMutators'  // 'core.createChild' mutator

typesFacet.of(defineBlockType({
  id: 'meeting',
  label: 'Meeting',
  properties: [meetingDateProp, meetingAttendeesProp],
  setup: async ({ tx, id }) => {
    // Type-defined computed initial value, init-if-missing. Setup runs
    // AFTER caller-supplied initialValues are written, so a meeting
    // imported with an explicit date (or one already set on the row
    // via sync) will already be present here — read first, skip the
    // write if so, otherwise compute today() and stamp it.
    const block = await tx.get(id)
    if (!block) return
    if (block.properties[meetingDateProp.name] === undefined) {
      const next = { ...block.properties, [meetingDateProp.name]: meetingDateProp.codec.encode(today()) }
      await tx.update(id, { properties: next })
    }
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

`tx.run(mutator, args)` ([src/data/api/tx.ts:130](src/data/api/tx.ts:130)) is the in-tx mutator dispatch — different from `repo.mutate.createChild(...)` which would open a separate tx and break the atomicity property `setup` exists for. Setup callbacks should always use `tx.run`, never `repo.mutate.X`. Setup callbacks that write block-level fields they don't strictly own should be init-if-missing too — read the existing value via `tx.get` first and skip writes for fields already set.

**Use sparingly** — it's a code-execution hatch in the type registry. `initialValues` (caller-supplied static map) and `PropertySchema.defaultValue` (read-time fallback) cover the static cases without code. `setup` is opaque code at add time. Two specific gotchas to flag at implementation time:

- **Bulk-write asymmetry.** `setup` fires from `repo.addType` / `repo.addTypeInTx`. A bulk path that writes `typesProp = ['task', 'meeting']` directly via `tx.update` *bypasses* both `setup` and `initialValues` materialisation. Tag-mapping callers should use the orchestration entry point appropriate to their context — `repo.addType` outside an existing tx, `repo.addTypeInTx(tx, blockId, typeId, initialValues?, snapshot?)` inside one. The Roam importer's apply phase runs inside chunked `repo.tx` calls (see §3-pure), so it must use `repo.addTypeInTx` per type per row to share atomicity with the surrounding `upsertImportedBlock` writes; calling the public `repo.addType` from inside an active tx would either fail against the writer slot or open a separate tx and lose the atomicity guarantee.
- **Reimport runs setup again.** A Roam reimport that adds `task` to a block where the type wasn't previously present *will* run `setup`. That's usually correct (first-time-for-this-block tag), but means import paths can trigger child-block creation. Document in the importer.

This naturally subsumes existing "create-and-stamp-type" code. [src/data/dailyNotes.ts:86](src/data/dailyNotes.ts:86)'s daily-note creation, which today writes `type='daily-note'` plus its own initial structure imperatively, becomes a `repo.addTypeInTx(tx, id, 'daily-note', {}, snapshot)` call **inside the same `repo.tx` block** that runs the existing `tx.create` / `tx.restore` for the journal and the daily-note row, with the `daily-note` type's `setup` carrying the template. Splitting type-add into a separate top-level `repo.addType` would leave a window where the row exists without its template if `setup` fails — atomicity with the create write is the whole point of using the in-tx variant. `snapshotTypeRegistries()` is called before opening the tx (or once per chunk) per §3a.

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

`block.hasType('todo')` replaces `block.peekProperty(typesProp)?.includes('todo')` — but it's a *snapshot* read, not a reactive subscription. Use it inside reactive contexts (a wrapper component subscribing to `useProperty(block, typesProp)` separately, or a renderer's `canRender` predicate that's re-evaluated by `useRenderer`'s subscriptions) where the surrounding code provides reactivity. **Don't use `block.hasType` as the gate inside a non-reactive facet contribution function** — that's exactly the pattern §4a documents as broken because `DefaultBlockRenderer` memoizes resolver outputs without a `typesProp` dependency. Non-component facets need an explicit reactive dep on `typesProp`; see §4a's component-wrapper pattern for the correct shape.

No `setTypes(array)` sugar on the facade — bulk-diff-and-apply lives on `Repo` (`repo.setBlockTypes`) where the call site is explicit about the operation rather than implied by an atomic-looking facade method.

**The addressing shape is `string`, not `TypeContribution`.** `block.hasType(typeId: string)`, `block.addType(typeId: string)`, etc. all take the persisted string id. This parallels `PropertySchema.name` as the storage primitive: the persisted shape and the API shape match. Three concrete reasons not to pass the contribution object: (a) blocks can carry types whose contribution hasn't been registered yet (sync from another device, dynamic extension not yet loaded, deferred type-definition block resolved later) — the string survives, an object reference can't; (b) data-defined paths (Roam importer's tag-mapping table, future type-definition blocks) only have strings to work with; (c) `repo.addType` looks up the contribution internally via the retained `types` registry to verify the id is registered and to find the `setup` callback — the contribution isn't useful as an *argument*, only as a *lookup target*, so taking it would force every caller to have runtime access for no win.

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
- **`initialValues` — first-writer-wins, order-dependent.** Schema defaults are global (one default per field on `PropertySchema.defaultValue`), so there's no per-type defaults to combine. The only multi-type ordering question is around caller-supplied `initialValues` to sequential `addType` calls: `repo.addType('todo', {status: 'open'})` then `repo.addType('task', {status: 'doing'})` on a block with no `status` → `status='open'` (the second `addType` sees the property already set during materialisation and skips it). Reverse order → `status='doing'`. The order callers invoke `repo.addType` in is therefore load-bearing for `initialValues` conflicts on shared fields. `repo.setBlockTypes(typeIds)` is **not** part of this story — it passes `initialValues = {}` per type and is explicitly a membership-shaping API (§3a); use sequential `repo.addType` / `repo.addTypeInTx` calls when ordering of `initialValues` matters. Don't pre-write `typesProp` directly via `tx.update` to apply both types "atomically" — that bypasses `initialValues` / setup and is the bug §3-pure / Phase 1 step 13 explicitly call out. Convention for `setup` callbacks that write block-level fields they don't strictly own: be init-if-missing too.
- **Decorations / headers / click handlers (§4a).** Stack natively — every contribution's non-falsy return is applied in contribution order. Multi-type decoration is the easy path; this is the main reason to prefer decorations over renderer-replacement.
- **Validation (deferred follow-up).** When it lands, validations across types **intersect** — a value must satisfy *all* applicable types' constraints. Constraints restrict; if any type forbids, it's forbidden.
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
// (b) type-contributed slots (may not yet be set on the block).
// Per §1a, type contributions' schemas are LIFTED into the same
// merged `schemas` registry that propertySchemasFacet populates,
// so `schemas.get(declared.name)` and `declared` resolve to the
// same object (or to a last-wins replacement that won the merge —
// either way, the entry the rest of the system is using). Reading
// from `schemas` rather than from `declared` directly keeps the
// panel consistent with whichever registration won the lift's
// last-wins, but they should not disagree under normal operation.
for (const typeId of block.types) {
  const t = typesRegistry.get(typeId)
  for (const declared of t?.properties ?? []) {
    const active = schemas.get(declared.name)
    if (active) {
      applicable.set(declared.name, active)
      unknownNames.delete(declared.name)
    }
    // Defensive only: if a type declares a name with no entry in
    // the merged registry, the lift didn't complete (unreachable
    // under §1a) — skip rather than render with a desync'd schema.
  }
}
```

The dedup by `name` is exactly what §3b's "field discovery is union by name" means at the code level. Multi-type composition is automatic — a prop declared by both `todo` and `task` lands in the map once.

**Empty slots render via the existing editor path, no new component.** For each entry in `applicable`: if `name in properties`, decode and edit (existing path); if not set, render `DefaultPropertyValueEditor` (or the contributed `PropertyUiContribution.Editor`) with `schema.defaultValue` as its value — same global default `block.get` returns for an unset property, since defaults live on the schema, not on type contributions. The editor doesn't need a "placeholder mode" — first user interaction calls `block.set(schema, …)` which materialises the property.

For each entry in `unknownNames` — properties set on the block whose schema isn't registered (legacy ad-hoc props, plugin-not-loaded refs, etc.) — keep the existing unknown-schema fallback in [src/components/BlockProperties.tsx](src/components/BlockProperties.tsx) ([:201](src/components/BlockProperties.tsx:201)–[:204](src/components/BlockProperties.tsx:204)): `resolvePropertyDisplay` builds an `adhocSchema` and routes through the kind-inferred default editor. These rows still appear in the panel — the union must not silently drop them.

**Render order:** type-contributed properties in `block.types` array order, then in each type's `properties[]` order; ad-hoc / set-but-no-type properties last. Within each group, set values before unset slots so users see materialised state first. Aesthetic call, not a correctness one.

**Per-type grouping in the panel is the default rendering, not a v2.** Group rows by contributing type with section headers (`label` from `TypeContribution`, `description` available on hover). Block-level core fields (id, last-changed, changed-by — the existing read-only header rows in [BlockProperties.tsx](src/components/BlockProperties.tsx)) sit above; each type the block carries gets its own section listing the schemas in its `properties[]`; properties set on the block but not contributed by any current type collect under a final "Other" section, and unknown-schema ad-hoc props collect under "Unregistered." Section order: core, then types in `block.types` array order, then Other, then Unregistered. The "Add Property" form for ad-hoc properties stays unchanged. A property that's contributed by multiple types appears once, under the first contributing type in `block.types` order — multi-type display via supplementary `also: meeting` badge is fine but optional.

### 4. Type-driven UI: decorations are the common case, full-renderer replacement is the exception

Most type-driven UI is *decoration* layered on the existing block content rendering — a `todo` adds a checkbox + strikethrough-when-done, a `priority=high` block adds a colored chip, a `due` field adds a date pill. Only a few types want to take over the entire block presentation (`video-player`, `panel`, `type-definition`). The design splits cleanly along that axis.

#### 4a. Decorations, headers, click handlers — via existing facets with a type-guard

The block-interaction facets in [src/extensions/blockInteraction.ts](src/extensions/blockInteraction.ts) (`blockContentDecoratorsFacet`, `blockHeaderFacet`, `blockChildrenFooterFacet`, `blockClickHandlersFacet`, `blockContentSurfacePropsFacet`, `blockLayoutFacet`) already have the right shape: each contribution is a function `(BlockResolveContext) => Contribution | null | undefined | false`, and returning a falsy value opts the block out. **No new slot on `TypeContribution` is needed.**

**Reactivity gotcha — don't gate the contribution function on `block.hasType(...)`; gate inside the rendered component.** [DefaultBlockRenderer.tsx:298](src/components/renderer/DefaultBlockRenderer.tsx:298) memoizes `resolveContext` on stable per-block inputs that *deliberately don't include `block.peek()` or `typesProp`* — that's what keeps `UpdateIndicator` and other decorations from remounting on every focus/edit/selection toggle. Every facet resolver downstream (`decorateContent`, `resolveBlockClickHandler`, `resolveHeaderSections`, etc.) is also memoized on `resolveContext`. So if a contribution function returns `null` because `block.hasType('todo')` was false at first render, that `null` is cached: when the user later adds the `todo` type, neither `resolveContext` nor any of its dependents re-runs, and the decoration never appears until something unrelated invalidates the chain (a focus change, navigation, a hot-reload).

The fix at the contribution level is to **always return a wrapper component** and have that component subscribe to the type state itself, rendering `null` when its type isn't present. That's idiomatic React — invalidation flows through the component's own `useProperty(block, typesProp)` subscription instead of through a stale resolver cache. Example for `todo`:

```ts
import { typesProp } from '@/data/properties.ts'
import { useProperty } from '@/hooks/block.ts'

const TodoCheckboxWrap = (Inner: ComponentType<BlockRendererProps>) =>
  (props: BlockRendererProps) => {
    const [types] = useProperty(props.block, typesProp)
    if (!types.includes('todo')) return <Inner {...props}/>
    return (
      <>
        <TodoCheckbox blockId={props.block.id} />
        <Inner {...props} />
      </>
    )
  }

const todoCheckboxDecorator: BlockContentDecoratorContribution = () =>
  TodoCheckboxWrap

// statusProp is the shared status concept (declared in src/plugins/todo
// or kernel — wherever it lives, its `defaultValue: 'open'` is the
// global read fallback for any unset status field).
export const todoPlugin: AppExtension = [
  typesFacet.of({id: 'todo', properties: [statusProp]}, {source: 'todo'}),
  blockContentDecoratorsFacet.of(todoCheckboxDecorator, {source: 'todo'}),
  // optionally: header chip when overdue, click handler on the checkbox, etc.
]
```

The contribution function returns the wrapper unconditionally, so it's always part of the decoration chain. The wrapper renders `<Inner/>` on its own when the type isn't present (a single component-tree level of pass-through, cheap), and renders the decoration when it is. Adding/removing the `todo` type re-runs the wrapper's `useProperty` subscription and the decoration appears or disappears reactively. Same pattern applies to `blockHeaderFacet` (return a component that conditionally renders), `blockChildrenFooterFacet`, etc.

For `blockClickHandlersFacet` / `blockContentSurfacePropsFacet` / `blockLayoutFacet` — facets that return non-component values rather than wrapped components — the resolver-time gate is the only path, and that gate must come from a *subscribed* read of `typesProp`, not from `block.peek()`. `block.peek()` returns the cached row without subscribing, so a key derived from `peek` won't trigger rerender when types change; the resolver memo's deps must include a value flowing through `useProperty(block, typesProp)` (or an equivalent handle-level subscription) read in the same component the resolver runs in. Concretely, [DefaultBlockRenderer.tsx:298](src/components/renderer/DefaultBlockRenderer.tsx:298)'s `resolveContext` memo needs `types` added to both the context shape and its dep list, populated from a `useProperty(block, typesProp)` call colocated with the existing `useInFocus` subscription. Then resolver outputs that depend on `resolveContext` invalidate when types change, and contribution functions reading `ctx.types` see the current value. Either implementation path lands the same constraint: subscribe-read, memo-dep, document-the-boundary so type-gated contributions don't silently cache at the wrong granularity.

This composes naturally under multi-type: each contributing type's wrapper sits in the chain unconditionally; whether each *renders* its decoration is reactive on the type set; multiple type-bound decorations stack as wrappers.

A small ergonomics improvement worth considering once a few types ship: a helper `withTypeGuard(typeId, Wrapped)` that produces the wrapper above. Don't pre-build it; extract from real call sites.

#### 4b. Full-renderer replacement — keep using the existing `blockRenderersFacet` path

For the rare types that want to replace the entire renderer (video-player, panel, type-definition), v1 keeps using the existing `blockRenderersFacet` + `BlockRenderer.canRender` / `priority` dynamic-dispatch path that [src/hooks/useRendererRegistry.tsx](src/hooks/useRendererRegistry.tsx) already runs. A type plugin that wants to own the body registers a renderer there with a `canRender` predicate that checks `block.hasType(...)`, exactly the way [VideoPlayerRenderer](src/plugins/video-player/VideoPlayerRenderer.tsx:176) checks `ReactPlayer.canPlay` today. `rendererProp` continues to override.

The type system deliberately doesn't carry renderer-resolution metadata. The current model exists to give plugins a real lever — they can supplant top-level / layout / breadcrumb renderers and remap how the app is rendered, which is a load-bearing design goal. Encoding `defaultRenderer` + numeric `priority` on `TypeContribution` would duplicate the existing facet's job, leak behavior into the membership layer (the §1 split says types declare semantic membership, existing facets declare behavior), and pre-commit to single-winner dispatch. Multi-view futures (Embark-style, simultaneous presentations of the same block keyed off frame, not a tournament) further argue for not freezing renderer ownership on types now.

There are real problems with the current resolution scheme — uncoordinated global priority numbers, no explainability when the wrong renderer wins, three different decisions (frame vs body vs missing-data) flattened onto one scalar, magic-string `default` fallback, silent no-op on misspelled `rendererProp`. Those are worth fixing, but as a separate refactor in its own doc — `docs/renderer-resolution.md` — not bundled with this. Once that lands and the resolution shape is settled, types may grow back a way to contribute renderers; design that against the new shape, not the current one.

Until then, the practical guidance for type authors stays the same as for any other plugin: register a renderer in `blockRenderersFacet` with a type-checking `canRender`, pick a priority that fits the existing landscape (kernel renderers are at 1, 5, 10, 20), and remember decorations are the common case.

### 5. Ref codecs — `codecs.ref`, `codecs.refList`

Today's codec set ([src/data/api/codecs.ts:73](src/data/api/codecs.ts:73)) is `string, number, boolean, date, optional, list, unsafeIdentity`. Add:

```ts
// RefCodec<T> extends Codec<T> with the picker constraint —
// "this `tasks` field accepts only Task-typed blocks" — colocated
// with the codec / schema rather than as per-type overrides.
// Extending the codec type (rather than the schema) keeps every
// usage site of Codec<T> unaware of ref-ness; sites that DO care
// (the property-ref projector, the picker editor) narrow with
// `isRefCodec` / `isRefListCodec` first.
//
// PropertySchema<T>.codec is typed as Codec<T>, so direct field
// access `schema.codec.targetTypes` won't type-check — the
// RefCodec subtype is erased at the schema boundary and consumers
// must narrow before reading. Concretely:
//
//   const codec: AnyCodec = schema.codec
//   if (isRefCodec(codec) || isRefListCodec(codec)) {
//     const targets = codec.targetTypes  // ok here
//   }
//
// `refKind` is the runtime discriminator the predicates dispatch
// on. `targetTypes` alone cannot tell ref from a plain string
// codec (an unconstrained `ref()` has no targets) and cannot
// distinguish ref from refList, but the property-ref projector
// and grouped-backlinks both need to dispatch on those two cases.
// A literal field is cheaper to check than a symbol brand and
// survives serialisation / structuredClone if a codec ever
// crosses a worker boundary.
export interface RefCodec<T> extends Codec<T> {
  readonly refKind: 'ref' | 'refList'
  readonly targetTypes?: readonly string[]
}

// Storage: a string block id. Codec exists so the data layer can
// recognise ref-bearing properties without per-block scanning, and
// so editor lookup in propertyUiFacet can default to a ref picker.
// Empty/missing targetTypes = "any type."
export const ref: (targetTypes?: readonly string[]) => RefCodec<string>
export const refList: (targetTypes?: readonly string[]) => RefCodec<readonly string[]>

// AnyCodec = variance-erased Codec for storage in heterogeneous
// collections + predicate inputs, mirroring AnyPropertySchema /
// AnyMutator. Codec<T> is invariant in T (encode contravariant,
// decode covariant), so a generic predicate input `Codec<T>` can't
// narrow to RefCodec<string> — RefCodec<string> is not assignable
// to Codec<T> for arbitrary T. Erased input solves it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCodec = Codec<any>

// Predicates dispatch on the `refKind` discriminator above; the
// targetTypes-only earlier draft couldn't tell ref from refList
// reliably and false-negatived on unconstrained ref().
export const isRefCodec: (codec: AnyCodec) => codec is RefCodec<string>
export const isRefListCodec: (codec: AnyCodec) => codec is RefCodec<readonly string[]>
```

Add a `kind: 'ref' | 'refList'` to `PropertyKind` in [propertySchema.ts:5](src/data/api/propertySchema.ts:5) so the property panel can pick a ref-aware editor when a `PropertySchema` is registered. The projector in §7 only needs the ref-ness check (`isRefCodec` / `isRefListCodec`); picker UIs additionally read `targetTypes` after narrowing.

**Unknown-schema fallback for refs is intentionally limited.** The unknown-schema path in [propertyEditors/defaults.tsx](src/components/propertyEditors/defaults.tsx) infers `kind` from raw JSON shape; a ref stored as a plain string id is indistinguishable from any other string, and a `refList` from any other `string[]`. Without a registered schema or an out-of-band marker on the value, the data layer has no way to know it's a ref. Accept this: unknown refs render via the primitive `string` / `list` editors, with no picker affordance, until the contributing plugin loads. Adding a `_ref: true` marker to stored values to make refs self-describing was considered and rejected — invasive, breaks JSON-equality compares, and "plugin not loaded" is rare enough that primitive-editor fallback is the right trade-off.

Schemas declare ref properties with their target-type constraint colocated on the codec:

```ts
export const projectTasksProp = defineProperty<readonly string[]>('tasks', {
  codec: codecs.refList(['task']),   // picker constraint lives on the codec
  defaultValue: [],
  kind: 'refList',
  changeScope: ChangeScope.BlockDefault,
})
```

The picker UI narrows the codec via `isRefListCodec(schema.codec)` and reads `targetTypes` from the resulting `RefCodec<readonly string[]>`. Empty/missing means "any type." Two types that genuinely need differently-constrained refs (e.g. `Project.tasks → Task[]` vs `Person.activities → Activity[]`) use distinct schema names per the §3 hybrid rule — different acceptable targets means different meaning means different schema. There's no per-type override path for ref targets.

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
- After parsing content refs (existing path), iterate the block's `properties`. For each entry whose `PropertySchema.codec` is a ref-codec or ref-list codec (looked up via `ctx.propertySchemas` — the snapshot of the **merged** schemas map per §7a, populated by the §1a lift; not `propertySchemasFacet` directly), decode and emit one `BlockReference { id, alias: id, sourceField: propName }` per ref. **Each property is decoded inside its own try/catch.** Stored values can be malformed for legitimate reasons — plugin upgraded the codec shape, ad-hoc edits in dev tools, sync from an older client that wrote a different encoding. A bad decode logs a warning, skips that one property, and the projector continues with the rest. Without per-property isolation, one corrupt ref-typed property would poison the whole `parseReferences` run for that block — content refs and other valid property refs would silently disappear from `references_json` until the data is fixed. v1 doesn't try to preserve prior `block_references` entries for the bad field; the field's refs simply go missing in the index until the next successful decode (the next `parseReferences` run after the property is fixed).
- Concatenate content-derived + property-derived into the new `references[]` and write through the same `tx.update(sourceId, {references}, {skipMetadata: true})`. The triggers from §6b copy `sourceField` into `block_references`.

Ordering / dedupe: identical `(id, sourceField)` pairs are deduped; content refs (no `sourceField`) and property refs (with `sourceField`) coexist for the same target — they represent different relationships.

#### 7-bis. Reproject when ref-codec set changes

The watch on `content` / `properties` field changes catches every per-block edit, but it doesn't catch **runtime changes to the ref-codec set itself**. Two real cases:

- A plugin registers a new `ref` / `refList` codec for a property name `relatedTo` that already exists on many blocks. No block row changes, so `parseReferences` never fires, and `references_json` / `block_references` stay missing the new edges until each affected block is edited.
- A schema *stops* being ref-typed (plugin removed, or its codec changed shape). Stale property-derived `BlockReference`s sit in `references_json` / `block_references` because no row write triggers re-projection.

Add a kernel-side reprojection step. `setFacetRuntime` itself is synchronous and not workspace-scoped — it just swaps the retained registries — so the reprojection runs as an *async job enqueued from* `setFacetRuntime`, not as work done inside it. Concretely:

1. **Inside `setFacetRuntime` (synchronous):** diff the previous and new `propertySchemas` maps for property names whose ref-ness changed (was-not-ref → is-ref, was-ref → is-not-ref, or was-ref → is-different-ref-shape). If the affected name set is empty, no enqueue. If non-empty, push a job onto the post-runtime-rebuild queue carrying the affected name set.
2. **The async job runs after `setFacetRuntime` returns.** Two-phase shape, matching the existing `parseReferences` pattern (`docs/processor-tx-deadlock.md`): all SQL reads happen *before* opening a write tx so the read doesn't hold a writer slot.
   - **Read phase (no tx).** Enumerate workspaces this `Repo` has blocks for. For client-side apps this is typically just `repo.activeWorkspaceId`; for multi-workspace state run `SELECT DISTINCT workspace_id FROM blocks` against the underlying read DB. For each workspace, query the candidate ids: `SELECT id, properties_json, references_json FROM blocks WHERE workspace_id = ? AND deleted = 0 AND ...` filtering by the affected property-name set. v1 uses the workspace-scoped scan; if reprojection latency becomes an issue, build a side table indexing property-name occurrences (same pattern as `block_types`).
   - **Write phase (one tx per workspace).** `RepoTxOptions` ([src/data/api/tx.ts:169](src/data/api/tx.ts:169)) carries `scope` + `description` only — `repo.tx` doesn't consult `activeWorkspaceId` and switching the UI-visible active workspace is a side effect, not a tx scope. The tx pins to a workspace when its first write fires (driven by the row being touched). So per-workspace reprojection works without any tx-options change: the read phase already grouped ids by `workspace_id`, so iterate per-workspace id list and open one `repo.tx(async tx => { ... }, { scope: ChangeScope.References })`. Every `tx.update(id, ...)` inside hits a row with the same `workspace_id`, pinning the tx accordingly. Inside the tx, iterate the precomputed ids:
     - `await tx.get(id)` to read the current row (read-your-own-writes semantics).
     - Run the same property-walk path as `parseReferences` — recompute `references_json` against the new schema set.
     - **Skip the `tx.update` when the recomputed `references_json` deep-equals the existing one** (same `(id, alias, sourceField)` tuples in the same order). On initial app start, the previous `propertySchemas` snapshot is empty, so every registered ref schema *looks* "new"; a naive implementation would touch every block carrying any ref-typed property — pure churn for rows whose references are already correct, including unnecessary undo entries and upload pressure.
     - When the row does need updating, write through `tx.update(id, {references}, {skipMetadata: true})` — same flag the existing `parseReferences` processor uses ([referencesProcessor.ts](src/plugins/backlinks/referencesProcessor.ts)) so the reprojection isn't credited as a user edit (no `updatedAt` / `updatedBy` bump).
3. The `ChangeScope.References` tx scope keeps the reprojection out of the user's normal undo bucket, matching the convention `parseReferences` already uses. The trigger that maintains `block_references` from `references_json` runs inside the same tx, so the edge index falls in line automatically.

This is a one-shot pass per runtime rebuild; the watch on per-block edits handles steady-state. Plugin authors don't need to do anything — the kernel detects the schema-set change and triggers the pass automatically. Workspace iteration matters even for predominantly single-workspace clients because the `Repo` may briefly hold blocks from multiple workspaces during workspace switches; one tx per workspace keeps the writer-slot semantics clean.

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

The `Repo` commit pipeline ([src/data/repo.ts:664](src/data/repo.ts:664)) passes `this._propertySchemas` into the tx-engine alongside `this.processors`; the engine puts both on the result; `processorRunner.dispatch` builds each `ctx` with the bundle's `propertySchemas` rather than reading `repo.propertySchemas` afresh.

The tx-engine plumbing reads `this._propertySchemas` directly (the engine sees `Repo` internals). External consumers — `BlockProperties` in §3c, the typed-query primitive in §8, plugin code — go through the public `repo.propertySchemas` getter and the reactive `usePropertySchemas` hook (§1a-public). Phase 1 step 6 enforces the audit: every existing `runtime.read(propertySchemasFacet)` call site outside `Repo` migrates to the merged-map path, otherwise type-lifted-only schemas stay invisible.

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
- `where` on a property → compile each `(name, decodedValue)` entry to `json_extract(properties_json, ?) = ?` and bind two parameters: the **JSON path** (computed safely — see below) and the **encoded** value run through the matching `PropertySchema.codec`. **Don't string-interpolate the property name into a `$.<name>` literal** — property names with `:`, `-`, or `.` (e.g. `system:collapsed`, `daily-note`) break naive interpolation. Use SQLite's path syntax: `'$.' || quote(name)` doesn't work directly, so build the path in JS with proper escaping (wrap in `"..."` and escape inner quotes — SQLite's JSON path accepts `$."weird:name"`). Look up the schema in **the merged `repo.propertySchemas` map** (§1a-public — not `propertySchemasFacet` directly, otherwise type-lifted-only schemas won't be found); if no schema is registered for that name, refuse the query with a clear error rather than guessing the codec — the caller is asking for typed-equality, ad-hoc schemas have `unsafeIdentity` codec which is meaningless to compare.

  **`where` is restricted to scalar-encoded fields in v1.** `json_extract` returns SQL primitives (`TEXT` / `INTEGER` / `REAL` / `NULL`) for scalar values and JSON-text strings for arrays/objects. Comparing a bound JS array/object against the JSON-text return is unreliable (whitespace, key ordering, codec encoding all diverge), so refuse `where` on schemas whose `kind` is `list`, `object`, `ref`, or `refList`. Callers needing membership-style filters use `referencedBy` (which goes through `block_references`, not `properties_json`) or wait for a follow-up that defines explicit JSON-comparison semantics. Document the restriction at the API site so a typed-query author hits a clear error rather than silent miss.

  **`null` / `undefined` semantics on the where value.** SQL `=` doesn't match NULL — `json_extract(...) = NULL` is always FALSE — and `json_extract` itself returns NULL for missing JSON paths, so naive `= ?` against an encoded null silently matches nothing. v1 rules:
  - Caller-supplied `where` value is `undefined` → reject the query with a clear error. `undefined` is the JS "no value" sentinel and almost always indicates a caller bug like `where: {status: someVar}` where `someVar` isn't set; rejecting forces the caller to be explicit. To filter "field is unset," pass `null` explicitly (next bullet).
  - Caller-supplied `where` value is `null` (or a value that the field's codec encodes to JSON null — e.g. some custom codecs may map a sentinel object to null) → compile to `(json_extract(properties_json, ?) IS NULL)`. Note the `optional(T)` codec's "no value" input is `undefined`, which is rejected at the previous bullet — so the IS-NULL path is reached by callers passing `null` directly, not via `optional(undefined)`. This deliberately conflates "property is unset" with "property is set to null"; most schemas don't distinguish the two so this is the natural meaning. If a schema does want to distinguish, the caller can post-filter or use `peekProperty`-equivalent membership checks — out of scope for v1 typed queries.
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

When a Roam block carries a `{{[[TODO]]}}` / `{{[[DONE]]}}` marker, the importer is already inside a `repo.tx` chunk (the existing planning + apply pipeline does this around `upsertImportedBlock`). Within that same tx:
1. Calls `repo.addTypeInTx(tx, blockId, 'todo', appOwnedInit)` — the tx-aware variant per §3a so the type tag, init writes, and any `setup` share atomicity with the row write. Passes the source's app-owned initial values as the fourth arg; per the addType contract these are init-if-missing (so `DONE` initialises `status='done'` on a previously-untyped block, but doesn't overwrite a user's local `'in-progress'`). Read fallback: blocks with no `status` set read `statusProp.defaultValue = 'open'` directly via `block.get`/`useProperty`, no overlay needed. Calling the public `repo.addType` from here would open a separate tx and break atomicity with `upsertImportedBlock`.
2. Refreshes **source-mirror** fields (`roam:todo-state`) freely in the same tx — but **per-property**, not via a wholesale `tx.update({properties: sourceMirror})`. `tx.update`'s `properties` patch *replaces* the whole map, so passing only the source-mirror keys would clobber the `typesProp` and any `appOwnedInit` writes that step 1 just made. Use `tx.setProperty(blockId, roamTodoStateProp, value)` per source-mirror key (single-property semantics; engine handles the merge), or read the row back with `tx.get` and merge before passing the whole map. The Phase 5 checklist below carries the same constraint.

The marker is stripped from `content` since the type now captures the meaning; the source-mirror field preserves what Roam said for round-trip and conflict-resolution purposes. Per the §3 hybrid naming rule, `status` is the shared-vocabulary field (flat name) and `roam:todo-state` is the namespaced source-mirror.

#### Reimport conflict semantics

The current Roam importer upserts deterministic IDs and replaces `content` / `properties` / `references` wholesale on existing rows. That's safe for source-authoritative snapshots but destroys app state on reimport:

1. Roam export says `TODO`. Import initialises `status = 'open'`.
2. User completes the task locally → `status = 'done'`.
3. Re-importing the same Roam export would plan `status = 'open'` again.
4. Wholesale overwrite loses the local completion.

**First-pass rule (v1):**

- **Type membership is additive.** If the Roam tag maps to a type the block doesn't yet have, `repo.addType` adds it (and `setup` fires once for that transition). If the block already has that type, the membership write and `setup` are no-ops, **but `addType` still runs init-if-missing materialisation against the `appOwnedInit` map** — so a block that arrived already-typed via raw sync but with no `status` yet gets `status` materialised on first reimport. Don't early-return on "already has the type"; pass through to `addType` either way and let init-if-missing decide per field.
- **Source-mirror fields (`roam:*`) refresh freely.** They represent "what the source said at this import." Always overwrite.
- **App-owned fields initialise only if missing.** App-owned fields are *exactly* the keys declared in each tag mapping's `appOwnedInit` (e.g. `status` for the TODO/DONE mapping); they are not "everything outside the `roam:` namespace" — that mis-classifies source-authored non-namespaced fields like `alias`, page-type markers, and promoted page attributes, which the importer plans and reimports should refresh. Reimport never overwrites an app-owned value that already exists. The `appOwnedInit` map is passed to `repo.addTypeInTx` (Phase 5 step 5) as `initialValues` — these encode source-specific values atomically with the type tag (e.g. `DONE → status='done'`). Type contributions don't carry their own defaults, so the only writes here are the `appOwnedInit` map itself; an unset field after import reads `statusProp.defaultValue = 'open'` via the normal block.get / useProperty fallback. On reimport, `addTypeInTx` re-runs the materialisation pass but every `appOwnedInit` field already has a value and is skipped (the init-only-if-missing rule); app-owned fields stay as the user left them. `setup` doesn't re-run either since the type is already present.
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
6. Extend `Repo.setFacetRuntime` per §3a to retain `types` and the **merged `propertySchemas`** map (§1a schema-lift) on `Repo`. The merge runs the two-pass shape from §1a — type-lifted first, direct second, last-wins-with-warn on conflicts, object-identity dedup. Direct registrations end up winning over type-lifted entries with the same name, preserving the kernel's "register-after-to-override" pattern uniformly across sources. Expose a public `get propertySchemas()` getter on `Repo` and a `usePropertySchemas()` hook (§1a-public). **Audit and migrate** every `runtime.read(propertySchemasFacet)` call site to read the merged map: today the only non-`Repo` consumer is [src/components/BlockProperties.tsx](src/components/BlockProperties.tsx); processor consumers already read from `ProcessorCtx.propertySchemas` which is sourced from the merged map per §7a. This merged map is what `repo.addType` reads (for `setup` lookup and `initialValues` codec encoding), what gets snapshotted into `CommittedTxOutcome.propertySchemas` at tx-start (§7a), what the property panel reads in §3c, and what the typed-query primitive reads in §8. Reads on the read path still use `PropertySchema.defaultValue` directly and don't need either registry.
7. Add `KERNEL_TYPE_CONTRIBUTIONS` for `'page'`, `'panel'`, `'journal'`, `'daily-note'`, `'extension'`.
8. Add `repo.addType(blockId, typeId, initialValues?)` / `repo.addTypeInTx(tx, ...)` / `repo.removeType` / `repo.removeTypeInTx` / `repo.toggleType` / `repo.setBlockTypes` / `repo.snapshotTypeRegistries` as `Repo` methods (not registered mutators — see §3a). `addType` runs `contribution.setup?.()` per §3a-setup on first transitions; init-if-missing materialisation runs against `initialValues` only (no per-type defaults).
9. Add `Block` facade sugar: `block.types` getter, `block.hasType(id)`, `block.addType(id)`, `block.removeType(id)`, `block.toggleType(id)` ([src/data/block.ts](src/data/block.ts)). `hasType` is a snapshot read; use it inside reactive contexts (component bodies that subscribe to `useProperty(block, typesProp)` separately, or `canRender` predicates re-evaluated by `useRenderer`). Don't use it as the gate inside non-reactive facet contribution functions per §4a's reactivity gotcha.
10. `block.get` and `useProperty` ship unchanged in semantics from current behaviour: unset properties return `schema.defaultValue` via the existing fallback. No type-aware overlay, no `Repo.resolveDefault` helper, no `usePeekProperty` parallel — schema defaults are sufficient since type contributions don't carry per-type defaults.
11. One-shot data migration: backfill `properties.types = [oldType]` for every row with `properties.type` (clearing `properties.type`). The `block_types` triggers populate the side table from `properties.types` automatically.
12. Update every `typeProp` write site to use the type-system orchestration path — never prewrite `typesProp` and then call `addType` (per §3-pure: `addType` still runs init-if-missing materialisation on re-call, but `setup` only fires on actual membership transitions, so prewriting silently bypasses any template/wiring the type defines). Pick the right entry point for the calling context:
    - **Outside an existing tx** (typical app code, command palette, agent runtime) → `repo.addType(blockId, typeId, initialValues?)`. Opens its own tx.
    - **Inside an existing tx** (Roam importer chunks around `upsertImportedBlock`, plugin code orchestrating multi-step writes) → `repo.addTypeInTx(tx, blockId, typeId, initialValues?, snapshot?)`. Shares atomicity with the surrounding row writes; calling the public `repo.addType` from inside another tx would either fail against the active writer or open a separate tx and lose the atomicity guarantee.
    Bulk paths like the Roam importer go through `addTypeInTx` per row inside their existing chunked tx, passing source-specific app-owned values via `initialValues` and a captured `repo.snapshotTypeRegistries()` for cross-row consistency. `addBlockTypeToProperties` is reserved for raw-`BlockData` callers (tests, processor snapshot rewrites, importer **plan** rows that have no runtime access) and never composes with `addType` / `addTypeInTx`.
13. Update every `typeProp` read site to read `typesProp` and `.includes(value)` / `[0]` (or use `block.hasType`/`block.types` once #9 lands; or `hasBlockType(data, ...)` for raw `BlockData`). Greps: `grep -rn "typeProp" src/`.
14. Remove `typeProp` from `KERNEL_PROPERTY_SCHEMAS` and from [properties.ts](src/data/properties.ts).

**Acceptance:** existing app behaviour unchanged. All current tests green. `repo` snapshots show `types: [...]` instead of `type:`. `findExtensionBlocks` returns the same set as before via `block_types` join. `repo.addType('some-existing-block', 'todo', {status: 'open'})` writes `status='open'` if unset and runs `setup` (if any) atomically. A re-call with the type already present **still runs init-if-missing materialisation against `initialValues`** (so already-typed blocks from sync without contribution / raw `typesProp` writes get any missing fields filled in); only `setup` is gated on actual first transitions and skipped on re-call.

### Phase 2 — type-driven UI: decorations + property-panel field discovery

1. Wire decoration / header / click-handler contributions for the kernel types that need them via the existing `blockInteraction` facets per §4a. **Decorations and headers** return wrapper components that subscribe to `useProperty(block, typesProp)` and conditionally render — see §4a. **Click handlers / surface props / layout** are non-component values; their resolver path needs `typesProp` baked in as a reactive dep. Concretely: extend [DefaultBlockRenderer.tsx:298](src/components/renderer/DefaultBlockRenderer.tsx:298)'s `resolveContext` shape with a `types` field populated from a colocated `useProperty(block, typesProp)` subscription, and add `types` to the dep list. Then resolver outputs invalidate when types change, and contribution functions can branch on `ctx.types` safely. No changes to `useRendererRegistry`; renderer-replacement types continue to register in `blockRenderersFacet` with type-checking `canRender` predicates per §4b.
2. Update [src/components/BlockProperties.tsx](src/components/BlockProperties.tsx) per §3c: replace the `Object.entries(properties)` iteration with the union over actually-set + type-contributed schemas; render unset type-slots via the existing default-editor path with `schema.defaultValue` (the same global default `block.get` returns).

**Acceptance:** tagging a block with a type whose contribution declares decorations (e.g. `todo` checkbox) makes the decoration appear without a `rendererProp` change. Tagging a block with a type whose contribution declares properties surfaces those property slots in the panel even when unset, and editing one writes the property.

### Phase 3 — ref codecs + named-backlinks (`block_references.source_field` + `ProcessorCtx`)

1. Add `codecs.ref()` / `codecs.refList()` to [src/data/api/codecs.ts](src/data/api/codecs.ts) with runtime `isRefCodec` / `isRefListCodec` predicates.
2. Add `kind: 'ref' | 'refList'` to `PropertyKind`.
3. Extend `BlockReference` with optional `sourceField`.
4. **Local-schema delta per §6b**: add `source_field TEXT NOT NULL DEFAULT ''` column to `block_references`, change PK to `(source_id, target_id, alias, source_field)`, update INSERT/UPDATE triggers and `BACKFILL_BLOCK_REFERENCES_SQL` to read `$.sourceField` from `references_json`, gated by a new backfill marker (`block_references_source_field_v1`). Update `backlinksInvalidationRule` ([src/plugins/backlinks/invalidation.ts](src/plugins/backlinks/invalidation.ts)) to diff by `(id, sourceField)` per §6b so source-field-only changes invalidate grouped backlinks.
5. **`ProcessorCtx` extension per §7a**: add `propertySchemas: ReadonlyMap<string, AnyPropertySchema>` to `ProcessorCtx` ([src/data/api/processor.ts:110](src/data/api/processor.ts:110)). Add `propertySchemas` to `CommittedTxOutcome` ([src/data/internals/processorRunner.ts:55](src/data/internals/processorRunner.ts:55)) so it's snapshotted alongside `processors` at tx-start; the commit pipeline at [src/data/repo.ts:664](src/data/repo.ts:664) passes `this._propertySchemas` through. `processorRunner.dispatch` reads the bundle's snapshot rather than reading the public `repo.propertySchemas` afresh, so processors and schemas come from the same resolved runtime.
6. Extend `backlinks.parseReferences` ([src/plugins/backlinks/referencesProcessor.ts](src/plugins/backlinks/referencesProcessor.ts)) to also walk ref-typed properties (using `ctx.propertySchemas` to identify ref codecs); watch `properties` field too. Per §7, isolate each property decode in a try/catch so one malformed value doesn't poison the whole projector run.
7. Add ref-codec-set diff + reprojection pass to `setFacetRuntime` per §7-bis: detect property names whose ref-ness changed between the old and new `propertySchemas` maps, schedule a one-shot processor that re-runs the property-walk over blocks containing those names. Skip `tx.update` when the recomputed `references_json` deep-equals the existing one (avoids churning every block on initial app start when the prior snapshot is empty). Updates use `{skipMetadata: true}` so reprojection isn't credited as a user edit. Tx scope is `References`.
8. Add `source_field`-aware grouping mode to [src/plugins/grouped-backlinks/](src/plugins/grouped-backlinks/).

**Acceptance:** a block with a ref-typed property pointing to another block surfaces in the target's grouped backlinks under the property name; two property refs from the same source to the same target via different fields don't collapse.

### Phase 4 — reactive typed-query primitive (SQLite-backed)

1. Implement `repo.queryBlocks` / `repo.subscribeBlocks` per §8 backed by SQL: `EXISTS` subqueries against `block_types` for type filters and `block_references` for `referencedBy` (avoids duplicating block rows when multiple edge rows match); `json_extract(properties_json, ?) = ?` for scalar `where` — bind the JSON path (built safely per §8 to handle property names containing `:`/`-`/`.`) and the codec-encoded value as parameters. Refuse the query when no schema is registered for a referenced field; refuse `where` on non-scalar kinds (`list`, `object`, `ref`, `refList`) per §8; refuse `undefined` `where` values; compile encoded `null` to `IS NULL` (matches both unset and explicit-null per §8). Per-property indexes added incrementally as hot fields are identified, following the same path-quoting rule.
2. Wire `subscribeBlocks` to the existing repo change-notification stream (which is already row-event-aware) so updates flow from both local commits and sync-applied changes.
3. Add `useBlockQuery` hook in `src/hooks/`.

**Acceptance:** subscribing to `{ types: ['todo'] }` returns a live list that updates when a block is tagged/untagged, including across a remote sync apply (e.g. another device adds a todo).

### Phase 5 — Roam todo import (downstream consumer)

1. Add `TAG_TO_TYPE` map to importer per the Migration section's expanded shape (separate `appOwnedInit` from `sourceMirror`).
2. Add `'todo'` type contribution (its own small plugin, `src/plugins/todo/`) with `statusProp` (shared-vocab, flat name) listed in `properties[]`, and a checkbox decorator via `blockContentDecoratorsFacet`. Implement the decorator per §4a's component-wrapper pattern: the contribution returns a wrapper unconditionally, the wrapper subscribes to `useProperty(block, typesProp)` and renders the checkbox only when `'todo'` is present. Do NOT gate the contribution function itself on `block.hasType('todo')` — that's the broken-on-add pattern §4a calls out. The default `'open'` lives on `statusProp.defaultValue` (the schema's global default), not on the type contribution. Reads of unset `status` return `'open'` via the existing `block.get`/`useProperty` schema-default path.
3. Add namespaced `roam:todo-state` schema in the importer (or a `roam` plugin) for the source-mirror field.
4. **Change `upsertImportedBlock` ([src/utils/roamImport/import.ts:756](src/utils/roamImport/import.ts:756)) to merge properties on live-row hits, using explicit allowlists.** Today's path is "last-write-wins": on an existing row it `tx.update`s `content`/`properties`/`references` with the planned values, dropping any local edits. That destroys app-owned state on reimport *before* any subsequent type-application runs. The fix uses two explicit per-block allowlists carried alongside the plan, not namespaces as classifiers:
   - `appOwnedFields: Set<string>` — fields the user owns post-import. Computed as the union of `appOwnedInit` keys from every matching TAG_TO_TYPE entry for the block (typically `{ 'status' }` for a Roam todo block, empty for a plain page).
   - `sourceFields: Set<string>` — the **source-owned universe** for this row, not just what the source currently exports. Built from three pieces unioned together:
     1. Keys of the current planned `properties` map (what the source has *now*).
     2. Existing keys on the row matching the importer's source-mirror namespace prefix(es) — for the Roam importer that's any key starting with `'roam:'`. This catches keys the source previously exported but no longer does, so they can be deleted.
     3. Other source-authoritative non-namespaced fields the importer writes (declared explicitly per importer: `alias`, type-marker, etc.). Removal of these is rarer in practice (a page name isn't usually deleted) but the explicit declaration keeps the rule honest.
   Naive `sourceFields = planned + source-mirror-keys-the-planner-wrote-this-time` is wrong — it can't detect that Roam stopped exporting `roam:author` because the new planned map simply doesn't have it. Including all *existing* `roam:*` keys in `sourceFields` is what makes source-side removals propagate.
   On live-row upsert, the merge applies per existing key:
   - Key in `appOwnedFields` → keep existing value if present, write planned/init value if missing.
   - Key in `sourceFields` AND in planned → overwrite with planned (source-authoritative refresh).
   - Key in `sourceFields` but NOT in planned → **delete** (source removed it; e.g. a `roam:author` Roam stopped exporting, a page attribute that's no longer planned).
   - Key in neither set → keep (user's ad-hoc props on the block survive reimport).
   For brand-new blocks (`createOrGet → inserted: true`), no merge is needed — the planned properties are the only state.
   The implementation splits `upsertImportedBlock` into "create new" (current path) and "merge into existing"; the merge takes `(existing, planned, appOwnedFields, sourceMirrorPrefixes, otherSourceFields)` and computes `sourceFields` from the union above before applying the per-key rules. Per-importer config carries the source-mirror prefix list (Roam: `['roam:']`, Notion: `['notion:']`) so the same shape generalises. **`content` and `references`** still overwrite wholesale (Roam content is source-authoritative; references are recomputed from content by the backlinks processor anyway).
5. On import, for each Roam block carrying a `{{[[TODO]]}}` / `{{[[DONE]]}}` marker, the importer is already inside a `repo.tx` chunk (the existing planning + apply pipeline does this around `upsertImportedBlock`). Within that same tx:
   - Capture a registry snapshot once via `repo.snapshotTypeRegistries()` *before* opening the chunk's tx, then thread it through every per-row call: `repo.addTypeInTx(tx, blockId, 'todo', appOwnedInit, snapshot)`. This pins the type registry across all rows in the chunk so a `setFacetRuntime` rebuild mid-import doesn't leave half the chunk on the old contributions and the rest on the new — see §3a `TypeRegistrySnapshot` for the rationale. The tx-aware variant shares atomicity with the row write; calling the public `repo.addType` would open a separate tx and break that. addType is idempotent and always runs init-if-missing materialisation (so already-typed blocks from sync without contribution / raw `typesProp` writes still get their `status` filled in); `setup` only fires on actual first transitions.
   - Write the source-mirror field via **`tx.setProperty(blockId, roamTodoStateProp, value)`** (per-property write, in the same tx). Always-overwrite is the source-mirror semantic, but **do NOT use `tx.update({properties: {...}})`** with just the source-mirror keys — that replaces the whole properties map and would clobber the `typesProp` / `appOwnedInit` writes `addTypeInTx` just made. If a future caller needs to write multiple source-mirror keys atomically and `tx.setProperty` looping is awkward, read with `tx.get`, merge the source-mirror keys into the read-back `properties`, then `tx.update`.
   - Strip the marker from `content`.

**Acceptance:** importing a Roam graph with `#TODO`/`#DONE` blocks produces blocks with `types: ['todo']`, matching `status`, and `roam:todo-state` reflecting the source. Surfaced via the todo checkbox decorator and queryable via `useBlockQuery({types: ['todo'], where: {status: 'open'}})`. **Reimport-after-local-change preserves user state**: locally completing a task (`status='done'`) and reimporting the original Roam export leaves `status='done'` untouched (the upsert merge preserves the local app-owned value) while `roam:todo-state` refreshes to `'TODO'` (source-mirror semantics). Verified against the importer write path, not just the `addType` path.

## Open questions for the implementer

- **Where `KERNEL_TYPE_CONTRIBUTIONS` is registered.** `kernelDataExtension` is the natural home (matches `KERNEL_PROPERTY_SCHEMAS`). Confirm by reading the kernel-extension wire-up before adding.
- **`removeType` cleanup policy.** v1 just removes from `typesProp` and leaves properties intact (defaults become inert). If this proves leaky in practice, add a "clear properties whose only contributing type is being removed" rule — but only after seeing the failure mode.
- **Per-property indexes for typed queries.** Phase 4 starts with `json_extract` scans. Add expression indexes per hot field (e.g. `idx_blocks_status` on `json_extract(properties_json, '$.status')`) only when query latency shows up — easier to add later than to remove.
- **Source-fingerprint reimport (deferred from Phase 5).** When the basic init-only-if-missing rule isn't enough — typically when a single Roam export is reimported many times and users expect Roam-side edits to flow through to fields they haven't locally touched — implement per-field source fingerprints so source updates apply when the local value still equals the previous import. v1's rule is conservative and won't blow up local state; the upgrade path is well-defined.
