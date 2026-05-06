# User-defined property schemas

## Goal

Let users create ad-hoc properties on a block that carry richer value semantics than primitive JSON shapes — refs, URLs, dates, future presets like maps or emails — without writing code, with the choice surviving reload.

The first downstream consumer is the Roam importer: every imported `key:: value` attribute becomes a registered property schema (typically a `refList`) instead of an unschemaed string blob. After this lands, schemaless properties are a transient state, not a steady-state design choice.

## Background — what exists today

Load-bearing pieces this design composes:

- **`PropertySchema<T>`** ([src/data/api/propertySchema.ts:8](src/data/api/propertySchema.ts:8)) — name + codec + defaultValue + changeScope. The codec is the single source of truth for value semantics after the [db2a987](https://github.com/) refactor (`kind` removed; editor selection derives from codec via `propertyEditorFallbackFacet`).
- **`Codec<T>`** ([src/data/api/codecs.ts:9](src/data/api/codecs.ts:9)) — primitive encode/decode contract running at four boundary call sites. Carries `shape: CodecShape` for storage primitive; semantic codecs add discriminators (`RefCodec.refKind`, etc.).
- **`propertySchemasFacet` / `propertyUiFacet` / `propertyEditorFallbackFacet`** ([src/data/facets.ts](src/data/facets.ts)) — facet-resolved registries; today read once at `setFacetRuntime` and merged per [type-system.md §1a](type-system.md) into `repo.propertySchemas`.
- **`AddPropertyForm`** ([src/components/propertyPanel/AddPropertyForm.tsx](src/components/propertyPanel/AddPropertyForm.tsx)) — the panel's "add field" UI. Currently picks an `AddablePropertyShape` (subset of `CodecShape`, excludes `date` and refs) and synthesizes an in-memory `adhocSchema`.
- **`adhocSchema` / `inferShapeFromValue`** ([src/components/propertyEditors/defaults.tsx:220](src/components/propertyEditors/defaults.tsx:220)) — the unknown-schema fallback path. Lossy by design: a stored ref looks like a string on read.
- **`subscribeBlocks`** (deferred — [type-system.md §8](type-system.md)) — typed-query primitive backing reactive subscriptions on type-tagged blocks.

The gap the refactor exposed: `CodecShape` is the wrong vocabulary for the user-facing picker. It's the JSON storage primitive, deliberately doesn't grow `'ref'` / `'url'` / etc. The user wants a richer menu of *value presets* — bundles of (codec factory, default, label, glyph, optional config) — that map down to codecs at registration time.

The codec refactor itself was the right move and stays. What's missing is the user-vocabulary layer above it, plus a runtime-mutable contribution path so schemas can be added without rebuilding the whole facet runtime.

## Design

### 1. `ValuePreset` — the user-facing value vocabulary

```ts
// src/data/api/valuePresets.ts (new)
export interface ValuePreset<TConfig = void> {
  /** Stable id; persisted alongside user-defined schema rows. */
  readonly id: string
  /** Human label for the picker. */
  readonly label: string
  /** Glyph for the property-row button and config sheet. */
  readonly Glyph: ComponentType<{className?: string}>
  /** Build the codec from preset-specific config. Called at schema
   *  registration time and on runtime rebuild — must be deterministic
   *  in `config`. */
  readonly build: (config: TConfig) => AnyCodec
  /** Default value used when the schema is registered and the property
   *  is first materialised. Lives on the resulting `PropertySchema`. */
  readonly defaultValue: unknown
  /** Optional config UI rendered inside `FieldConfigSheet`. Only
   *  presets with non-trivial config (refs, future enums) ship one. */
  readonly ConfigEditor?: ComponentType<ValuePresetConfigEditorProps<TConfig>>
}

export interface ValuePresetConfigEditorProps<TConfig> {
  value: TConfig
  onChange: (next: TConfig) => void
}

export const definePreset = <TConfig>(
  preset: ValuePreset<TConfig>,
): ValuePreset<TConfig> => preset
```

Kernel preset set, registered via a new `valuePresetsFacet`:

```ts
const kernelValuePresets: readonly AnyValuePreset[] = [
  definePreset({id: 'string',  label: 'Plain text', Glyph: TypeIcon,    build: () => codecs.string,             defaultValue: ''}),
  definePreset({id: 'number',  label: 'Number',     Glyph: Hash,        build: () => codecs.number,             defaultValue: 0}),
  definePreset({id: 'boolean', label: 'Checkbox',   Glyph: CheckSquare, build: () => codecs.boolean,            defaultValue: false}),
  definePreset({id: 'list',    label: 'Options',    Glyph: List,        build: () => codecs.list(codecs.string), defaultValue: []}),
  definePreset({id: 'date',    label: 'Date',       Glyph: Calendar,    build: () => codecs.date,               defaultValue: undefined}),
  definePreset({id: 'url',     label: 'URL',        Glyph: LinkIcon,    build: () => urlCodec,                  defaultValue: ''}),
  definePreset<RefCodecOptions>({
    id: 'ref',     label: 'Reference',  Glyph: AtSign,
    build: cfg => codecs.ref(cfg),
    defaultValue: '',
    ConfigEditor: RefTargetTypePicker,
  }),
  definePreset<RefCodecOptions>({
    id: 'refList', label: 'References', Glyph: AtSignList,
    build: cfg => codecs.refList(cfg),
    defaultValue: [],
    ConfigEditor: RefTargetTypePicker,
  }),
]
```

`urlCodec` is a new string-shaped codec that adds a `format: 'url'` discriminator (parallel to `RefCodec.refKind`) so a `kernel.url` fallback editor in `propertyEditorFallbackFacet` can match before the generic `kernel.string` fallback. Same pattern applies to any future semantic codec.

Plugins contribute presets the same way — `valuePresetsFacet.of(preset, {source: 'plugin'})`. No imperative API.

### 2. Facets gain a runtime contribution source

Today contributions to a facet come exclusively from the static extension graph processed by `setFacetRuntime`. Add a runtime mutation path so user data can participate without rebuilding the whole runtime:

```ts
// On Repo (or a new RuntimeContributionStore alongside it).
//
// Per facet, contributions are bucketed by sourceId. Static
// extension contributions land under their declared {source}
// (the existing `someFacet.of(value, {source: 'todo-plugin'})`
// metadata). Runtime contributions land under whatever sourceId
// the caller passes to setRuntimeContributions.
//
// `runtime.read(facet)` runs `combine` over the union of static +
// runtime contributions, in declaration order with per-source
// last-wins on collisions matching the facet's existing convention.
setRuntimeContributions(
  facet: AnyFacet,
  sourceId: string,
  contributions: readonly unknown[],
): void
```

Per-source replacement (not append) is the right granularity: each subscription owner manages its own bucket, the user-data source is one bucket, future sources (workspace settings, agent commands, etc.) get their own buckets.

A facet contribution change fires a per-facet change notification, not a global runtime swap. Subscribers (the rebuild steps below) react.

### 3. Rebuild steps — split monolithic `setFacetRuntime`

Today `setFacetRuntime` is one big read-everything-write-everything function. Refactor into named steps that declare their inputs:

```ts
// src/extensions/rebuildSteps.ts (new)
type RebuildInput = { kind: 'facet'; facet: AnyFacet }

interface RebuildStep<TOut extends Record<string, unknown>> {
  readonly id: string
  readonly inputs: readonly RebuildInput[]
  readonly outputs: ReadonlyArray<keyof TOut & string>
  readonly run: (ctx: { read: <T>(f: Facet<T>) => T }) => TOut
}
```

Existing logic decomposes into ~5 steps (mutators, processors, invalidationRules, queries, propertySchemas-merge). Each declares which facets it reads.

Two reconfiguration entry points:

- **Full extension swap** (existing `setFacetRuntime` semantics) — runs every step. Used at workspace bootstrap and when the static extension graph changes (plugin install/disable, hot reload).
- **Per-facet runtime contribution change** — fires from `setRuntimeContributions`. Walks the steps, runs only those whose `inputs` include the changed facet. Notifies subscribers for the affected outputs.

Both paths converge on the same `notifyOutputs(changedOutputs)` fan-out that drives `usePropertySchemas` and other subscriptions.

The `propertySchemas` step:

```ts
const propertySchemasStep: RebuildStep<{
  _propertySchemas: ReadonlyMap<string, AnyPropertySchema>
  _types: ReadonlyMap<string, TypeContribution>
}> = {
  id: 'propertySchemas',
  inputs: [
    {kind: 'facet', facet: propertySchemasFacet},
    {kind: 'facet', facet: typesFacet},
  ],
  outputs: ['_propertySchemas', '_types'],
  run: ({read}) => {
    const direct = read(propertySchemasFacet)  // includes user-data source
    const types  = read(typesFacet)
    return {
      _types: types,
      _propertySchemas: mergeSchemas(types, direct),
    }
  },
}
```

User schemas don't need a separate input — they arrive through `propertySchemasFacet`'s `'user-data'` source bucket, combined automatically by the facet's existing `combine`.

Precedence inside the merge stays as in [type-system.md §1a](type-system.md): type-lifted first, direct second (last-wins among direct sources). `'user-data'` is one direct source among others; if a kernel/plugin source registers the same name in the same `setFacetRuntime` pass, last-wins among direct decides — which the form's preflight prevents anyway by refusing collisions before the user submits.

### 4. Schemas are blocks under a Properties page

User-defined schemas persist as **blocks**, not a side table. A new kernel type `'property-schema'` with three fields:

```ts
// src/data/internals/coreProperties.ts (additions)
export const propertyNameProp = defineProperty<string>('property-schema:name', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})
export const presetIdProp = defineProperty<string>('property-schema:preset', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})
export const presetConfigProp = defineProperty<Record<string, unknown>>('property-schema:config', {
  codec: codecs.unsafeIdentity('object'),  // preset-specific JSON
  defaultValue: {},
  changeScope: ChangeScope.BlockDefault,
})
```

These three are *kernel* schemas (registered directly via `propertySchemasFacet`). The chicken-and-egg "schema for schemas" is solved by making the meta-layer kernel-owned — kernel schemas are always present, user schemas read from kernel-defined property-schema blocks.

A canonical Properties page exists per workspace, created at workspace bootstrap. Property-schema blocks live as its children. Convention: one Properties page per workspace, identified by a stable id or a `panel:properties` type tag. The page is a normal navigable block — users can open it and edit schemas inline like any other content.

### 5. `UserSchemasService` — reactive subscription over schema blocks

```ts
// src/data/userSchemasService.ts (new)
export class UserSchemasService {
  constructor(private readonly repo: Repo) {}

  start(): () => void {
    return this.repo.subscribeBlocks({types: ['property-schema']}, blocks => {
      const presets = this.repo.read(valuePresetsFacet)
      const contributions: AnyPropertySchema[] = []
      for (const block of blocks) {
        const presetId = block.get(presetIdProp)
        const preset = presets.get(presetId)
        if (!preset) continue   // preset's plugin not loaded yet — skip
        const name = block.get(propertyNameProp)
        if (!name) continue
        contributions.push({
          name,
          codec: preset.build(block.get(presetConfigProp)),
          defaultValue: preset.defaultValue,
          changeScope: ChangeScope.BlockDefault,
        })
      }
      this.repo.setRuntimeContributions(propertySchemasFacet, 'user-data', contributions)
    })
  }
}
```

Behavior:

- Every time a property-schema block is created, edited, or deleted, the subscription fires, the service rebuilds the user-data contribution list, the runtime updates the facet's `'user-data'` bucket, the `propertySchemas` step re-runs, the merged map updates, subscribers re-render.
- Preset-not-loaded entries are skipped silently. They reappear on the next subscription fire after the plugin lands (the subscription doesn't refire on plugin load alone — see "preset facet changes" below).
- No SQL migrations, no separate persistence path. Sync, undo, history all work because schemas are blocks.

#### Preset facet changes

If `valuePresetsFacet`'s contributions change (plugin loads, ships a new preset), schemas registered against the new preset need to re-resolve. Add a second trigger in `UserSchemasService`: also re-emit when `valuePresetsFacet` changes, by either (a) wrapping the block subscription with a `valuePresetsFacet`-dependent dependency or (b) re-running the contributions build inside the existing `propertySchemas` step (move preset → schema synthesis into the step itself, drop the service's subscription path for it).

Option (b) is cleaner — the step would read both `propertySchemasFacet` and `valuePresetsFacet`, and a separate input for "user-defined property-schema blocks" via a different mechanism. But that requires the rebuild-step framework to read non-facet inputs, which we explicitly chose against in §2. Option (a) keeps the service as the integration point and is the sketch above.

### 6. `AddPropertyForm` — autocomplete + default preset

Two UX changes from today's form:

#### Default preset is `ref`

Knowledge-base ad-hoc properties skew toward references in practice (Roam-style attributes, Tana defaults). The glyph next to the name input opens `FieldConfigSheet`, which now shows the full preset list rather than just `AddablePropertyShape`. User can change before or after typing.

#### Name input has autocomplete from registered schemas

```
┌─[ref glyph] [ name input: "stat" ] [ value editor                 ]
                ▼
                ├─ status        (Plain text)
                ├─ statusOf      (Reference → Task)
                └─ statusReason  (Plain text)
```

Suggestions are drawn from `repo.propertySchemas` filtered by name prefix. Each row shows the preset glyph + label so the user can see what they'd be adopting.

Two submit paths:

- **User picks a suggestion** → form adopts the existing schema (preset + config locked to whatever's registered). Submit calls `block.set(existingSchema, existingSchema.defaultValue)`. No new schema is created.
- **User types a fresh name and submits without picking** → form calls `userSchemasService.addSchema({name, presetId, config})`. The service creates a property-schema block under the Properties page, the subscription fires, the merged map updates, and the form then writes the initial value through the now-registered schema.

The adoption-cheap path reinforces the §3 hybrid rule (shared vocabulary stays shared) by making "use the existing one" the default outcome.

#### Collision preflight

Before calling `addSchema`, check `repo.propertySchemas.get(name)`:

- Hit, source is `'user-data'` → existing user schema, treated as adoption (same as picking from autocomplete).
- Hit, source is direct facet (kernel/plugin) → kernel/plugin owns the name. Refuse with a clear message, suggest the user pick a different name.
- Miss → proceed with `addSchema`.

This avoids the user-data write that would lose to direct-source last-wins anyway, and keeps the error path obvious.

### 7. `addSchema` — create the schema block

```ts
// On UserSchemasService
async addSchema(args: {
  name: string
  presetId: string
  config?: unknown
}): Promise<void> {
  const propertiesPageId = this.repo.propertiesPageId  // resolved at workspace bootstrap
  await this.repo.tx(async tx => {
    const id = await tx.run(createChild, {parentId: propertiesPageId, position: {kind: 'last'}})
    await tx.update(id, {
      properties: {
        [typesProp.name]: typesProp.codec.encode(['property-schema']),
        [propertyNameProp.name]: propertyNameProp.codec.encode(args.name),
        [presetIdProp.name]: presetIdProp.codec.encode(args.presetId),
        [presetConfigProp.name]: presetConfigProp.codec.encode(args.config ?? {}),
      },
    })
  }, {scope: ChangeScope.BlockDefault, description: `addSchema ${args.name}`})
}
```

The subscription handles the rest. Removal: `repo.removeBlock(schemaBlockId)` — same path. Editing: change the property-schema block's `presetConfigProp` (e.g., add a target type to a ref). The subscription rebuilds the facet contribution and the schema's codec changes — which **is** a §7-bis ref-codec set change, so reprojection runs over rows carrying the property name. This is correct behavior and requires no special path.

### 8. Roam importer — schema reconciliation

Schemaless properties go away as a steady-state design. Every imported `key:: value` attribute resolves to a registered schema. The importer's plan phase grows a reconciliation step:

1. **Collect.** Walk the parsed dump, build the set of unique property names appearing across all blocks.
2. **Resolve against current registry.** For each name, if a schema is already in `repo.propertySchemas` (kernel, plugin, or pre-existing user schema) → use it as-is; record the binding for the apply phase.
3. **Classify unregistered names.** For each remaining name, sample values across the dump:
   - All values are `[[…]]` page references → `refList` preset, no `targetTypes` constraint (we don't know what types the targets should be).
   - All values are valid numbers → `number` preset.
   - All values are `true` / `false` → `boolean` preset.
   - Otherwise → `string` preset.
   The defaults are deliberately conservative — `refList` for the common Roam-attribute case, fall through to `string` for anything ambiguous. Users can edit the resulting property-schema blocks to narrow (e.g., `refList` → single `ref`, add `targetTypes`).
4. **Plan schema blocks.** For each newly-classified name, emit a property-schema block into the deterministic-id plan. Schema block id is `hash(workspaceId, propertyName)` so re-importing the same dump doesn't duplicate. Parent is the Properties page.
5. **Apply order.** Phase the apply pipeline so schema blocks land **before** any block carrying their properties. The simplest reliable shape: schema blocks form a first apply chunk; subscribers (`UserSchemasService`) fire and `setRuntimeContributions` runs synchronously; subsequent chunks write content + properties against an already-registered registry. If synchronous re-resolution proves brittle, the importer can call `setRuntimeContributions` directly inside the same tx after writing the schema blocks.

#### One-shot migration for existing imported data

There's already Roam-imported data in user databases without property-schema blocks. A one-shot kernel migration runs once, gated by a `user_property_schemas_migration_v1` marker (same pattern as existing local-schema backfills):

1. Scan `properties_json` across all blocks for property names not already registered.
2. Classify each via the same logic as the importer (sample values, pick a preset).
3. Create property-schema blocks under the Properties page.
4. Mark complete.

This brings existing data up to the "every property has a schema" invariant without requiring a re-import.

### 9. `adhocSchema` becomes a degraded read fallback

After this lands, the `adhocSchema` / `inferShapeFromValue` path in [src/components/propertyEditors/defaults.tsx](src/components/propertyEditors/defaults.tsx) is no longer the primary route for ad-hoc properties — it's a graceful-degradation read path for transient missing-schema states:

- **Sync race**: a row arrives carrying property values whose property-schema block hasn't synced yet. The fallback renders the value via the inferred-shape primitive editor; once the schema block syncs, the merged map updates and the row re-renders with the proper editor.
- **Plugin not loaded**: a kernel/plugin schema's plugin is disabled. Same shape — primitive fallback until the plugin loads.
- **Never-registered legacy**: a property that pre-dates this change and somehow escapes the migration. The fallback keeps the panel from crashing, but a "no schema registered for this property" hint in the panel surfaces it for user action.

The fallback's *write* path (the form's `addProperty` calling `adhocSchema(name, shape)` and `block.set(adhocSchema, ...)`) goes away. The form always either adopts a registered schema or creates a new one before writing — no in-memory ad-hoc schemas at write time.

## Phasing

Each phase is independently shippable and testable.

### Phase 1 — runtime contribution mechanism

1. Extend the facet runtime to support `setRuntimeContributions(facet, sourceId, contributions)`. Per-facet `Map<sourceId, contributions[]>` plumbing; `runtime.read(facet)` combines static + runtime; per-facet change notifications.
2. Refactor `setFacetRuntime` into named `RebuildStep`s with declared `inputs`. Today's logic decomposes into ~5 steps; the only structural change is making the inputs explicit. Outputs stay the same `Repo` fields.
3. Wire `setRuntimeContributions` to fire only the dependent steps. Notification surface fans out per output.
4. Tests: a runtime contribution change to one facet re-runs only the dependent step; unrelated steps' outputs keep object identity; subscribers for unaffected outputs don't re-render.

No user-visible change yet. This is pure infrastructure.

### Phase 2 — `ValuePreset` + value preset facet

1. Add `ValuePreset` type and `valuePresetsFacet` ([src/data/api/valuePresets.ts](src/data/api/valuePresets.ts) new).
2. Register kernel presets (string, number, boolean, list, date, url, ref, refList).
3. Add `urlCodec` with `format: 'url'` discriminator + `kernel.url` fallback editor in `propertyEditorFallbackFacet` (priority above `kernel.string`).
4. Replace `AddablePropertyShape` in `AddPropertyForm` and `FieldConfigSheet` with preset selection. Form's default preset is `ref`.
5. Extend `FieldConfigSheet` to render a preset's optional `ConfigEditor`.
6. Tests: preset list resolves, configEditor renders for ref, glyph + label propagate.

After this phase, the form lets users pick rich presets but still synthesizes in-memory `adhocSchema`s — choices don't persist yet. Stepping stone.

### Phase 3 — property-schema as block + `UserSchemasService`

1. Add `'property-schema'` type contribution and the three kernel schemas (`propertyNameProp`, `presetIdProp`, `presetConfigProp`).
2. Workspace bootstrap creates the Properties page if it doesn't exist (deterministic id, idempotent).
3. Implement `UserSchemasService` with the `subscribeBlocks` subscription. (Requires [type-system.md §8](type-system.md)'s typed-query primitive — phase order this one after.)
4. Wire `AddPropertyForm`'s submit path: collision preflight → either adopt existing schema or call `userSchemasService.addSchema`.
5. Add name autocomplete to `AddPropertyForm` keyed off `repo.propertySchemas`.
6. Tests: creating a schema via the form persists as a block, survives reload, fires the subscription, updates the merged map, makes the schema visible to `BlockProperties`. Edit + delete of schema blocks reactively updates.

After this phase, user-created schemas with full preset semantics persist across reloads and sync.

### Phase 4 — Roam importer schema reconciliation + migration

1. Add the schema-reconciliation step to the Roam importer plan phase ([src/utils/roamImport/plan.ts](src/utils/roamImport/plan.ts)). Sample-and-classify, plan deterministic-id schema blocks, sequence apply chunks so schemas land first.
2. Add the one-shot existing-data migration (`user_property_schemas_migration_v1` marker), classifying property names already on disk.
3. Demote `adhocSchema` to degraded-read-only — remove the form's write-time use of it; keep the fallback for sync-race and plugin-not-loaded cases.
4. Add a "no schema registered" hint in `BlockProperties` for properties that fall through to the degraded path, with a one-click "register a schema for this" action that opens `AddPropertyForm` pre-filled with the property name.
5. Tests: import a Roam dump with a few attribute kinds, verify schema blocks emitted, verify reapply on the same dump is idempotent. Run migration against a fixture pre-this-change, verify schemas created and properties readable.

After this phase, schemaless properties are gone from the steady-state shape.

## Decisions deferred / out of scope

- **Schema editing UI beyond raw block editing.** v1 has no dedicated "edit schema" form. Users edit the property-schema block's properties directly (or via the standard property panel). A dedicated form is fine to add later but not load-bearing.
- **Per-block schema overrides.** The §3 hybrid rule says distinct semantics → distinct schema names. No per-block override mechanism in v1.
- **Cross-workspace schema sharing.** Schemas are workspace-scoped (Properties page is per workspace). Sharing a schema definition across workspaces would need a separate import / link mechanism; not v1.
- **Validation rules on schemas.** A schema's codec defines storage shape; it doesn't validate semantic constraints (URL format beyond what `urlCodec` enforces, ref target-type intersection, value ranges on numbers). Validation is the deferred follow-up from [type-system.md §3b](type-system.md).
- **Top-level reconfigure granularity beyond per-facet.** CodeMirror-style compartments wrapping arbitrary extension subtrees are out of scope; the per-facet runtime-source granularity covers the projected use cases (user schemas, future user types, future user keymap overrides) without dependency tracking inside facet `combine`.
