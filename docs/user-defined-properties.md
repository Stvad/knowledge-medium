# User-defined property schemas

## Goal

Let users create ad-hoc properties on a block that carry richer value semantics than primitive JSON shapes — refs, URLs, dates, future presets like maps or emails — without writing code, with the choice surviving reload.

The first downstream consumer is the Roam importer: every imported `key:: value` attribute becomes a registered property schema (typically a `refList`) instead of an unschemaed string blob. After this lands, schemaless properties are a transient state, not a steady-state design choice.

## Background — what exists today

Load-bearing pieces this design composes:

- **`PropertySchema<T>`** ([src/data/api/propertySchema.ts:8](src/data/api/propertySchema.ts:8)) — name + codec + defaultValue + changeScope. The codec is the single source of truth for value semantics after the [db2a987](https://github.com/) refactor (`kind` removed; editor selection derives from codec via `propertyEditorFallbackFacet`, which this design replaces with editor-on-preset — see §1-edit).
- **`Codec<T>`** ([src/data/api/codecs.ts:9](src/data/api/codecs.ts:9)) — primitive encode/decode contract running at four boundary call sites. After this design lands, codec carries a single open-string `type: string` discriminator matching its preset id (see §1a — replaces both the closed `shape: CodecShape` enum and the ad-hoc `RefCodec.refKind` field).
- **`propertySchemasFacet` / `propertyUiFacet`** ([src/data/facets.ts](src/data/facets.ts)) — facet-resolved registries; today read once at `setFacetRuntime` and merged per [type-system.md §1a](type-system.md) into `repo.propertySchemas`. (`propertyEditorFallbackFacet` exists today but goes away under §1-edit — editor lookup folds into `valuePresetsFacet`.)
- **`AddPropertyForm`** ([src/components/propertyPanel/AddPropertyForm.tsx](src/components/propertyPanel/AddPropertyForm.tsx)) — the panel's "add field" UI. Currently picks an `AddablePropertyShape` (subset of `CodecShape`, excludes `date` and refs) and synthesizes an in-memory `adhocSchema`.
- **`adhocSchema` / `inferShapeFromValue`** ([src/components/propertyEditors/defaults.tsx:220](src/components/propertyEditors/defaults.tsx:220)) — the unknown-schema fallback path. Lossy by design: a stored ref looks like a string on read.
- **`subscribeBlocks`** (deferred — [type-system.md §8](type-system.md)) — typed-query primitive backing reactive subscriptions on type-tagged blocks.

The gap the refactor exposed: `CodecShape` is the wrong vocabulary for the user-facing picker. It's the JSON storage primitive, deliberately doesn't grow `'ref'` / `'url'` / etc. The user wants a richer menu of *value presets* — bundles of (codec factory, default, label, glyph, optional config) — that map down to codecs at registration time.

The codec refactor itself was the right move and stays. What's missing is the user-vocabulary layer above it, a runtime-mutable contribution path so schemas can be added without rebuilding the whole facet runtime, and a cleanup of the codec discriminator vocabulary so semantic and primitive codecs share one open identifier instead of two redundant ones.

## Design

### 1. `ValuePreset` — the user-facing value vocabulary

```ts
// src/data/api/valuePresets.ts (new)
export interface ValuePreset<TValue = unknown, TConfig = void> {
  /** Stable id; matches the codec's `type` for codecs built by this
   *  preset. Persisted on user-defined schema blocks. */
  readonly id: string
  /** Human label for the picker. */
  readonly label: string
  /** Build the codec from preset-specific config. Called at schema
   *  registration time and on runtime rebuild — must be deterministic
   *  in `config`. */
  readonly build: (config: TConfig) => Codec<TValue>
  /** Default value used when the schema is registered and the property
   *  is first materialised. Lives on the resulting `PropertySchema`. */
  readonly defaultValue: TValue
  /** Editor used for any property whose codec's `type` matches this
   *  preset's `id`. Required — every preset ships its own editor;
   *  there's no separate fallback facet. Exact-name
   *  `PropertyUiContribution.Editor` contributions still win first
   *  (per [defaults.tsx:294](src/components/propertyEditors/defaults.tsx:294)). */
  readonly Editor: PropertyEditor<TValue>
  /** Optional glyph for the property-row button, config sheet, and
   *  picker. Plugins without designed icons can omit; falls back to a
   *  generic icon (or text-styled label). */
  readonly Glyph?: ComponentType<{className?: string}>
  /** Optional config UI rendered inside `FieldConfigSheet`. Only
   *  presets with non-trivial config (refs, future enums) ship one. */
  readonly ConfigEditor?: ComponentType<ValuePresetConfigEditorProps<TConfig>>
}

export interface ValuePresetConfigEditorProps<TConfig> {
  value: TConfig
  onChange: (next: TConfig) => void
}

export const definePreset = <TValue, TConfig>(
  preset: ValuePreset<TValue, TConfig>,
): ValuePreset<TValue, TConfig> => preset
```

Kernel preset set, registered via a new `valuePresetsFacet`:

```ts
const kernelValuePresets: readonly AnyValuePreset[] = [
  definePreset({id: 'string',  label: 'Plain text', Glyph: TypeIcon,    build: () => codecs.string,             defaultValue: '',         Editor: StringPropertyEditor}),
  definePreset({id: 'number',  label: 'Number',     Glyph: Hash,        build: () => codecs.number,             defaultValue: 0,          Editor: NumberPropertyEditor}),
  definePreset({id: 'boolean', label: 'Checkbox',   Glyph: CheckSquare, build: () => codecs.boolean,            defaultValue: false,      Editor: BooleanPropertyEditor}),
  definePreset({id: 'list',    label: 'Options',    Glyph: List,        build: () => codecs.list(codecs.string), defaultValue: [],         Editor: ListPropertyEditor}),
  definePreset({id: 'date',    label: 'Date',       Glyph: Calendar,    build: () => codecs.date,               defaultValue: undefined,  Editor: DatePropertyEditor}),
  definePreset({id: 'url',     label: 'URL',        Glyph: LinkIcon,    build: () => urlCodec,                  defaultValue: '',         Editor: UrlPropertyEditor}),
  definePreset<string, RefCodecOptions>({
    id: 'ref',     label: 'Reference',  Glyph: AtSign,
    build: cfg => codecs.ref(cfg),
    defaultValue: '',
    Editor: RefPropertyEditor,
    ConfigEditor: RefTargetTypePicker,
  }),
  definePreset<readonly string[], RefCodecOptions>({
    id: 'refList', label: 'References', Glyph: AtSignList,
    build: cfg => codecs.refList(cfg),
    defaultValue: [],
    Editor: RefListPropertyEditor,
    ConfigEditor: RefTargetTypePicker,
  }),
]
```

`unsafeIdentity('object')` and similar internal-use codecs intentionally have no preset — they're used on kernel-internal hidden properties (e.g. `presetConfigProp`) that opt out of the panel via `PropertyUiContribution.hidden` and never need an editor. If a future visible property genuinely wants a JSON-object editor, it goes through the exact-name `PropertyUiContribution.Editor` path, not a preset.

Plugins contribute presets the same way — `valuePresetsFacet.of(preset, {source: 'plugin'})`. No imperative API.

#### 1-edit. Editor lookup goes through the preset, not a fallback facet

The pre-this-design `propertyEditorFallbackFacet` ([typesPropertyUi.ts:68](src/components/propertyEditors/typesPropertyUi.ts:68)) is a parallel registry of `(predicate, Editor, priority)` triples that the panel walks to find an editor matching a schema's codec. With every codec now carrying `type: string` and every preset carrying its own `Editor`, the predicate-and-priority machinery is redundant: the codec's `type` is exactly the preset's `id`, the preset's `Editor` is exactly the editor to use. **Drop `propertyEditorFallbackFacet` entirely.**

`resolvePropertyDisplay` ([defaults.tsx:281](src/components/propertyEditors/defaults.tsx:281)) becomes:

```ts
export const resolvePropertyDisplay = (args: {
  name: string
  encodedValue: unknown
  schemas: ReadonlyMap<string, AnyPropertySchema>
  uis: ReadonlyMap<string, AnyPropertyUiContribution>
  presets: ReadonlyMap<string, AnyValuePreset>
}): PropertyDisplayInfo => {
  const known = args.schemas.get(args.name)
  if (known) {
    const ui = args.uis.get(args.name)
    const preset = args.presets.get(known.codec.type)
    return {
      schema: known,
      type: known.codec.type,
      // Exact-name UI contribution wins first (unchanged); preset's
      // editor is the universal fallback for any registered schema.
      Editor: ui?.Editor ?? preset?.Editor,
      isKnown: true,
    }
  }
  // Unknown-schema fallback: infer a primitive type from JSON, build
  // an adhoc schema with that type, look up its preset's editor.
  const type = inferTypeFromValue(args.encodedValue)
  const schema = adhocSchema(args.name, type)
  return {
    schema,
    type,
    Editor: args.presets.get(type)?.Editor,
    isKnown: false,
  }
}
```

Three properties this gives:

- **Editor + codec + preset travel together.** Adding an `email` preset means shipping the codec factory, default, and editor as one unit in one facet contribution — not a preset *and* a separate fallback editor in a parallel facet.
- **No priority concept.** Today's `priority: 100` for `kernel.ref` (so it beats `kernel.string` despite both technically matching a string-shaped ref codec) only existed because shape conflated storage primitive with semantic flavor. With open `type`, a codec has exactly one type and exactly one matching preset — no overlap, no ordering.
- **Override path stays uniform.** A plugin overrides the kernel's `'ref'` editor by contributing a preset with the same `id`; `valuePresetsFacet`'s last-wins-on-source convention picks the plugin's. Same mechanism as kernel-vs-user-data resolution for schemas.

Loss to flag: the predicate-based facet allowed weirder match shapes (e.g., "match any string-shaped codec including unrecognized plugin types"). Open `type` doesn't have a wildcard; an unknown plugin codec type with no registered preset has no editor. Two ways out:

- **Conservative.** Accept that schemas whose codec type has no registered preset render via the unknown-schema fallback path (whose primitive type comes from JSON inference, not from `codec.type`). This is the same degraded path used for sync-race / plugin-not-loaded cases.
- **Permissive.** A "default" preset registered against a wildcard / known-primitive type list, picked when the codec type doesn't match any registered preset id. Ugly; not worth it.

Conservative is the call — degraded fallback for un-presented codec types matches the rest of the design.

#### 1a. Codec carries a single open `type` discriminator

Pre-this-design `Codec` carries two fields: `shape: CodecShape` (closed JSON-primitive enum) and — on `RefCodec` only — `refKind: 'ref' | 'refList'` (an ad-hoc discriminator). Every new semantic codec would either invent its own `refKind`-style field (`format: 'url'`, …) or sit awkwardly under the existing `shape` while needing predicate-based exclusion (the way `isRefCodec` is special-cased outside the shape check in [typedBlockQuery.ts:40](src/data/internals/typedBlockQuery.ts:40)).

Replace both with a **single open `type: string`** on every codec, whose value matches the preset id that built it:

```ts
// src/data/api/codecs.ts
export interface Codec<T> {
  readonly type: string            // stable preset id; e.g. 'string', 'ref', 'url'
  encode(value: T): unknown
  decode(json: unknown): T
}

export interface RefCodec extends Codec<string> {
  readonly type: 'ref'             // replaces refKind
  readonly targetTypes: readonly string[]
}

export interface RefListCodec extends Codec<readonly string[]> {
  readonly type: 'refList'
  readonly targetTypes: readonly string[]
}

// Kernel codecs declare their type:
const stringCodec:  Codec<string>  = { type: 'string',  encode, decode }
const numberCodec:  Codec<number>  = { type: 'number',  encode, decode }
const booleanCodec: Codec<boolean> = { type: 'boolean', encode, decode }
const dateCodec:    Codec<Date>    = { type: 'date',    encode, decode }
const listCodec    = <T>(inner: Codec<T>): Codec<T[]> => ({ type: 'list', encode, decode })
const objectCodec  = <T>(): Codec<T> => ({ type: 'object', encode, decode })
const ref     = (opts?) => ({ type: 'ref',     targetTypes: ..., encode, decode })
const refList = (opts?) => ({ type: 'refList', targetTypes: ..., encode, decode })
const url:          Codec<string>  = { type: 'url',     encode: validateUrl, decode: validateUrl }
```

Predicates collapse to one-liners on `type`:

```ts
export const isRefCodec     = (c: AnyCodec): c is RefCodec     => c.type === 'ref'
export const isRefListCodec = (c: AnyCodec): c is RefListCodec => c.type === 'refList'
export const isUrlCodec     = (c: AnyCodec): c is Codec<string> => c.type === 'url'
```

A new semantic codec is a `type` string plus a preset (carrying `Editor` and codec factory together; see §1-edit) plus optional `whereAllowedTypesFacet` opt-in.

Three properties this gives:

- **One vocabulary, two uses.** Preset id and codec type are the same string. A `'ref'` preset's `build()` returns a codec with `type: 'ref'`; the panel looks up the preset by `codec.type` and uses its `Editor`. No predicate matching, no translation layer.
- **The `where`-clause check becomes one read.** Today's [typedBlockQuery.ts:40](src/data/internals/typedBlockQuery.ts:40) is `SCALAR_WHERE_SHAPES.has(shape) && !isRefCodec && !isRefListCodec` — shape conflates JSON storage primitive with semantic flavor, so refs (string-shaped but semantically reference) need a special-case exclusion. With open `type`, ref is its own value, naturally excluded by curation: `WHERE_ALLOWED_TYPES = new Set(['string', 'number', 'boolean', 'date', 'url'])` and the check is just `!WHERE_ALLOWED_TYPES.has(codec.type)`. Refs → `referencedBy` (indexed via `block_references`), not where-clause; lists/objects → JSON-text `=`-comparison is unreliable; both excluded by not being in the kernel-curated set. The set is itself a facet (`whereAllowedTypesFacet`) so plugin codecs can opt in.
- **Plugin-defined codecs participate without core changes.** A plugin shipping an `email` preset picks `type: 'email'`, registers `(codec factory, Editor, defaultValue, glyph?, configEditor?)` in one preset contribution, and contributes `'email'` to `whereAllowedTypesFacet` if it should be query-able. No new ad-hoc fields per codec subtype, no parallel fallback-facet registration.

What we lose by dropping `shape`: the closed-enum reading of "this codec encodes to JSON shape X" goes away. Today's only data-layer consumer of that information is the where-clause check, which becomes the kernel-curated allowed-set. UI display (labels, glyphs, the `inferShapeFromValue` JSON-shape inference for the unknown-schema fallback) all switch onto `type` — same values as before for primitive codecs (`'string'`, `'list'`, …), open string for plugin-contributed types with a default-case fallback. If a future consumer needs to know "what JSON primitive does this encode to" separately from "what semantic flavor is it," we'd add that information back as either a metadata field or a kernel registry. Currently no such consumer exists.

The pre-existing `Codec.shape: CodecShape` field, the `CodecShape` type itself, and the `isStringCodec` / `isListCodec` / `isObjectCodec` / etc. shape-keyed predicates all go away. `inferShapeFromValue` becomes `inferTypeFromValue`, returns one of `'string' | 'number' | 'boolean' | 'list' | 'object'` (a known-primitive subset of the open string namespace).

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

#### Existing alpha data — drop and recreate

Per the project's no-back-compat-in-alpha rule, there's no migration of pre-this-design data. Existing local databases get wiped on first launch carrying this change; users re-import their Roam dumps under the schema-aware importer to repopulate. No one-shot scan-and-classify, no migration markers, no fallback for properties without schema blocks.

What this means concretely:

- The `'property-schema'` type contribution and the Properties page are kernel additions; first launch creates the page fresh.
- Anything that was in `properties_json` on existing rows is gone with the local DB wipe — there's nothing to classify.
- Users with sync state on a server: server data is part of the alpha-wipe scope too. Synced clients reimport.
- The first paragraph of the §9 "degraded read fallback" subsection (sync-race, plugin-not-loaded) still applies post-wipe — those are race-condition cases, not legacy-data cases.

### 9. `adhocSchema` becomes a degraded read fallback

After this lands, the `adhocSchema` / `inferShapeFromValue` path in [src/components/propertyEditors/defaults.tsx](src/components/propertyEditors/defaults.tsx) is no longer the primary route for ad-hoc properties — it's a graceful-degradation read path for transient missing-schema states:

- **Sync race**: a row arrives carrying property values whose property-schema block hasn't synced yet. The fallback renders the value via the inferred-shape primitive editor; once the schema block syncs, the merged map updates and the row re-renders with the proper editor.
- **Plugin not loaded**: a kernel/plugin schema's plugin is disabled. Same shape — primitive fallback until the plugin loads.
- **Property-schema block in malformed state**: a `'property-schema'` block exists but is missing `propertyName` or `presetId`. The service skips it, values for the intended name render via the fallback. Resolves when the schema block is fixed.
- **Direct raw writes that bypass the form**: any code path calling `tx.update(id, {properties: {someAdHocName: rawValue}})` without an associated registered schema. Should not exist for unregistered names after Phase 4; if a buggy plugin or future feature reintroduces one, the fallback keeps the panel rendering. Worth a runtime warn in the tx engine for "writing a property whose name has no registered schema."

The fallback's *write* path (the form's `addProperty` calling `adhocSchema(name, type)` and `block.set(adhocSchema, ...)`) goes away. The form always either adopts a registered schema or creates a new one before writing — no in-memory ad-hoc schemas at write time.

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
3. Replace `Codec.shape: CodecShape` and `RefCodec.refKind` with a single open-string `Codec.type` on every codec (per §1a). Drop the `CodecShape` type and `isStringCodec` / `isListCodec` / etc. shape-keyed predicates; replace `RefCodec` predicates with `c.type === 'ref'`. Update [typedBlockQuery.ts](src/data/internals/typedBlockQuery.ts) to check against a `whereAllowedTypesFacet`-resolved kernel set instead of `SCALAR_WHERE_SHAPES` plus ref special-case. Update UI display sites (`propertyShapeLabel`, `PropertyShapeGlyph`, `inferShapeFromValue`) to switch on `type` with a default case.
4. Drop `propertyEditorFallbackFacet` (per §1-edit). Move every editor onto its preset's `Editor` field. Update `resolvePropertyDisplay` to look up `valuePresets.get(codec.type)?.Editor` for the fallback editor; `PropertyUiContribution.Editor` exact-name path stays unchanged.
5. Add `urlCodec` with `type: 'url'` and a `'url'` preset wrapping `(urlCodec, UrlPropertyEditor, '', LinkIcon)`.
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

### Phase 4 — Roam importer schema reconciliation

1. Add the schema-reconciliation step to the Roam importer plan phase ([src/utils/roamImport/plan.ts](src/utils/roamImport/plan.ts)). Sample-and-classify, plan deterministic-id schema blocks, sequence apply chunks so schemas land first.
2. Demote `adhocSchema` to degraded-read-only — remove the form's write-time use of it; keep the fallback for sync-race and plugin-not-loaded cases.
3. Add a "no schema registered" hint in `BlockProperties` for properties that fall through to the degraded path, with a one-click "register a schema for this" action that opens `AddPropertyForm` pre-filled with the property name.
4. Tests: import a Roam dump with a few attribute kinds, verify schema blocks emitted, verify reapply on the same dump is idempotent.

Existing alpha local databases are wiped (per the no-back-compat rule); users reimport their dumps under the new importer. After this phase, schemaless properties are gone from the steady-state shape.

## Decisions deferred / out of scope

- **Schema editing UI beyond raw block editing.** v1 has no dedicated "edit schema" form. Users edit the property-schema block's properties directly (or via the standard property panel). A dedicated form is fine to add later but not load-bearing.
- **Per-block schema overrides.** The §3 hybrid rule says distinct semantics → distinct schema names. No per-block override mechanism in v1.
- **Cross-workspace schema sharing.** Schemas are workspace-scoped (Properties page is per workspace). Sharing a schema definition across workspaces would need a separate import / link mechanism; not v1.
- **Validation rules on schemas.** A schema's codec defines storage shape; it doesn't validate semantic constraints (URL format beyond what `urlCodec` enforces, ref target-type intersection, value ranges on numbers). Validation is the deferred follow-up from [type-system.md §3b](type-system.md).
- **Top-level reconfigure granularity beyond per-facet.** CodeMirror-style compartments wrapping arbitrary extension subtrees are out of scope; the per-facet runtime-source granularity covers the projected use cases (user schemas, future user types, future user keymap overrides) without dependency tracking inside facet `combine`.
