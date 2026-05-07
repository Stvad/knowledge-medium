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
   *  in `config` and only run on validated config (see configCodec). */
  readonly build: (config: TConfig) => Codec<TValue>
  /** Default value used when the schema is registered and the property
   *  is first materialised. Lives on the resulting `PropertySchema`. */
  readonly defaultValue: TValue
  /** Default config used when the preset is registered through
   *  `AddPropertyForm` without user-supplied config. Required when
   *  `TConfig` is non-void; void presets omit it (and `configCodec`). */
  readonly defaultConfig?: TConfig
  /** Validates and parses raw JSON read from `presetConfigProp` into
   *  `TConfig`. Required when `TConfig` is non-void. Throws on
   *  malformed input — `UserSchemasService` catches, logs, and skips
   *  schemas with invalid config rather than passing untyped JSON to
   *  `build`. The encoding side is used when persisting config from
   *  `AddPropertyForm` and from the property-schema block renderer:
   *  `presetConfigProp.codec.encode(preset.configCodec.encode(cfg))`. */
  readonly configCodec?: Codec<TConfig>
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
  /** Optional config UI rendered inside `FieldConfigSheet` and the
   *  property-schema block renderer (§4a). Only meaningful when
   *  `TConfig` is non-void; primitive presets (`TConfig = void`) have
   *  nothing to configure and omit it. */
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

**Config-validation contract.** `presetConfigProp` stores arbitrary JSON, including JSON written by hand-edits in the property-schema block renderer or by import code. Passing that JSON straight to `build` means malformed config either crashes synthesis or produces a subtly-wrong codec (e.g. ref with a non-string `targetTypes`). The contract: every non-void preset declares a `configCodec` whose `decode` is the validated parse boundary. `UserSchemasService` runs raw JSON through the codec; on throw, it logs a diagnostic naming the schema and skips the contribution (the schema temporarily falls into the unknown-schema fallback path until config is fixed). Void presets have no config to validate and skip the codec.

Kernel preset set, registered via a new `valuePresetsFacet`:

```ts
// Codec for ref/refList config — validates targetTypes is string[]
// when present, rejects anything else.
const refConfigCodec: Codec<RefCodecOptions> = {
  type: 'object',
  encode: cfg => cfg as unknown,
  decode: json => {
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
      throw new CodecError('ref config object', json)
    }
    const obj = json as Record<string, unknown>
    if (obj.targetTypes !== undefined) {
      if (!Array.isArray(obj.targetTypes) || !obj.targetTypes.every(t => typeof t === 'string')) {
        throw new CodecError('ref config targetTypes (string[])', obj.targetTypes)
      }
    }
    return {targetTypes: obj.targetTypes as readonly string[] | undefined}
  },
}

const kernelValuePresets: readonly AnyValuePreset[] = [
  definePreset({id: 'string',  label: 'Plain text', Glyph: TypeIcon,    build: () => codecs.string,             defaultValue: '',         Editor: StringPropertyEditor}),
  definePreset({id: 'number',  label: 'Number',     Glyph: Hash,        build: () => codecs.number,             defaultValue: 0,          Editor: NumberPropertyEditor}),
  definePreset({id: 'boolean', label: 'Checkbox',   Glyph: CheckSquare, build: () => codecs.boolean,            defaultValue: false,      Editor: BooleanPropertyEditor}),
  definePreset({id: 'list',    label: 'Options',    Glyph: List,        build: () => codecs.list(codecs.string), defaultValue: [],         Editor: ListPropertyEditor}),
  definePreset<Date | undefined>({id: 'date', label: 'Date', Glyph: Calendar, build: () => codecs.optional(codecs.date), defaultValue: undefined, Editor: DatePropertyEditor}),
  definePreset({id: 'url',     label: 'URL',        Glyph: LinkIcon,    build: () => urlCodec,                  defaultValue: '',         Editor: UrlPropertyEditor}),
  definePreset<string, RefCodecOptions>({
    id: 'ref',     label: 'Reference',  Glyph: AtSign,
    build: cfg => codecs.ref(cfg),
    defaultValue: '',
    defaultConfig: {},
    configCodec: refConfigCodec,
    Editor: RefPropertyEditor,
    ConfigEditor: RefTargetTypePicker,
  }),
  definePreset<readonly string[], RefCodecOptions>({
    id: 'refList', label: 'References', Glyph: AtSignList,
    build: cfg => codecs.refList(cfg),
    defaultValue: [],
    defaultConfig: {},
    configCodec: refConfigCodec,
    Editor: RefListPropertyEditor,
    ConfigEditor: RefTargetTypePicker,
  }),
]
```

`unsafeIdentity('object')` and similar internal-use codecs intentionally have no preset — they're used on kernel-internal hidden properties (e.g. `presetConfigProp`) that opt out of the property panel via `PropertyUiContribution.hidden`. The schema's config isn't edited through the *property panel* — it's edited via a dedicated **property-schema block renderer** that owns the schema-editing UI for blocks of type `'property-schema'` (see §4). The renderer reads the schema's preset, dispatches to `preset.ConfigEditor`, and writes back to `presetConfigProp` directly. The property panel never sees presetConfigProp because it's hidden — correct, that's not where schema editing happens.

Plugins contribute presets the same way — `valuePresetsFacet.of(preset, {source: 'plugin'})`. No imperative API.

#### 1-edit. Editor lookup goes through the preset, not a fallback facet

The pre-this-design `propertyEditorFallbackFacet` ([typesPropertyUi.ts:68](src/components/propertyEditors/typesPropertyUi.ts:68)) is a parallel registry of `(predicate, Editor, priority)` triples that the panel walks to find an editor matching a schema's codec. With every codec now carrying `type: string` and every preset carrying its own `Editor`, the predicate-and-priority machinery is redundant: the codec's `type` is exactly the preset's `id`, the preset's `Editor` is exactly the editor to use. **Drop `propertyEditorFallbackFacet` entirely.**

`resolvePropertyDisplay` ([defaults.tsx:281](src/components/propertyEditors/defaults.tsx:281)) is the **single point** at which `ValuePreset` and `PropertyUiContribution` are merged. Every consumer (panel rows, autocomplete, `BlockProperties` model builder) goes through it; nowhere should inline the `ui?.X ?? preset?.X` pattern. This is the load-bearing reuse — neither a shared base interface nor a merged facet — between the two registries:

```ts
export interface ResolvedPropertyDisplay {
  schema: AnyPropertySchema
  type: string                    // codec.type
  Editor?: PropertyEditor<unknown>
  Renderer?: PropertyRenderer<unknown>
  Glyph?: ComponentType<{className?: string}>
  /** Row display name in the property panel. Comes from
   *  PropertyUiContribution.label, falls back to schema.name. NOT
   *  the preset's label (that one is the picker entry, only used
   *  in AddPropertyForm). */
  rowLabel: string
  hidden: boolean
  category?: string
  isKnown: boolean
}

export const resolvePropertyDisplay = (args: {
  name: string
  encodedValue: unknown
  schemas: ReadonlyMap<string, AnyPropertySchema>
  uis: ReadonlyMap<string, AnyPropertyUiContribution>
  presets: ReadonlyMap<string, AnyValuePreset>
}): ResolvedPropertyDisplay => {
  const known = args.schemas.get(args.name)
  const schema = known ?? adhocSchema(args.name, inferTypeFromValue(args.encodedValue))
  const ui = args.uis.get(args.name)
  const preset = args.presets.get(schema.codec.type)
  return {
    schema,
    type: schema.codec.type,
    // Per §1-ui: name overrides type for Editor / Renderer / Glyph.
    // Preset's editor is the universal fallback when no exact-name
    // contribution exists; preset's glyph is the type-default icon.
    Editor: ui?.Editor ?? preset?.Editor,
    Renderer: ui?.Renderer,
    Glyph: ui?.Glyph ?? preset?.Glyph,
    rowLabel: ui?.label ?? schema.name,
    hidden: ui?.hidden ?? false,
    category: ui?.category,
    isKnown: known !== undefined,
  }
}
```

Two registries, one resolver. Adding a new shared field (e.g., a per-property tooltip later) means one signature change in `ResolvedPropertyDisplay` plus one new line in the resolver. Type-level "extract a shared base interface" looks tempting but doesn't add to that — the override merge is the place inconsistency would arise, and that's already a function.

Three properties this gives:

- **Editor + codec + preset travel together.** Adding an `email` preset means shipping the codec factory, default, and editor as one unit in one facet contribution — not a preset *and* a separate fallback editor in a parallel facet.
- **No priority concept.** Today's `priority: 100` for `kernel.ref` (so it beats `kernel.string` despite both technically matching a string-shaped ref codec) only existed because shape conflated storage primitive with semantic flavor. With open `type`, a codec has exactly one type and exactly one matching preset — no overlap, no ordering.
- **Override path stays uniform.** A plugin overrides the kernel's `'ref'` editor by contributing a preset with the same `id`; `valuePresetsFacet`'s last-wins-on-source convention picks the plugin's. Same mechanism as kernel-vs-user-data resolution for schemas.

Loss to flag: the predicate-based facet allowed weirder match shapes (e.g., "match any string-shaped codec including unrecognized plugin types"). Open `type` doesn't have a wildcard; an unknown plugin codec type with no registered preset has no editor. Two ways out:

- **Conservative.** Accept that schemas whose codec type has no registered preset render via the unknown-schema fallback path (whose primitive type comes from JSON inference, not from `codec.type`). This is the same degraded path used for sync-race / plugin-not-loaded cases.
- **Permissive.** A "default" preset registered against a wildcard / known-primitive type list, picked when the codec type doesn't match any registered preset id. Ugly; not worth it.

Conservative is the call — degraded fallback for un-presented codec types matches the rest of the design.

#### 1-ui. `ValuePreset` vs. `PropertyUiContribution` — type-level vs. name-level

Both `ValuePreset` and `PropertyUiContribution` carry display concerns (Editor, Glyph, label) and the overlap could read as redundant. It isn't — they're at different scopes, and the layering is the design:

- **`ValuePreset`** is keyed by codec `type` (`'ref'`, `'url'`, `'string'`). It declares defaults for *every* property whose codec was built by this preset. "How does the system render any URL property?"
- **`PropertyUiContribution`** is keyed by property `name` (`'status'`, `'video:playerView'`). It declares specialization for one specific property. "How do we render the `status` property in particular, given its codec?"

Per-field resolution at the property panel:

| Concern | `ValuePreset` (type) | `PropertyUiContribution` (name) | Resolution |
|---|---|---|---|
| Editor | required, type default | optional, per-name override | `ui?.Editor ?? preset?.Editor` |
| Renderer | (none) | optional, per-name read-only renderer | `ui?.Renderer` |
| Glyph | optional, type-level icon | optional, per-name override | `ui?.Glyph ?? preset?.Glyph` |
| `label` | picker entry ("Reference") | per-row display name ("Assignee") | independent — different audiences |
| `ConfigEditor` | optional, type-level config UI | (none) | preset only |
| `defaultValue` / `build` | required (codec construction) | (none) | preset only |
| `hidden` | (none) | per-name opt-out from panel | ui only |
| `category` | (none) | per-name section grouping | ui only |

The `label` row is the one that benefits from being explicit: preset's `label` is the picker entry shown in `AddPropertyForm` ("Plain text", "URL"); ui's `label` is the row display name in the property panel ("Status", "Due date"). Different audiences, no override relationship — both exist independently.

`PropertyUiContribution` gains an optional `Glyph?: ComponentType<{className?: string}>` for symmetry with the per-name override pattern. Most contributions won't set it; the few that do (a `priority` property wanting a flag icon instead of the codec's default text glyph) get a one-line override path.

**Why not fold them into one thing.** Fields that should specialize per-property (label, hidden, category, optional Editor override) are decisively name-keyed. Fields that should default for a whole codec type (default Editor, default Glyph, picker entry, codec factory) are decisively type-keyed. Merging them would either force every property name to declare its codec-type defaults (impossible — many properties don't ship a UI contribution at all) or force every preset to enumerate the property names it covers (broken — the open codec-type → editor mapping is the whole point). The two registries with name-overrides-type semantics is the right shape.

**`PropertyUiContribution.Editor`'s relationship to preset's Editor stays unchanged from §1-edit.** Exact-name editor wins first; preset's editor is the universal fallback. The above table just generalizes that pattern to glyph and renderer too.

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

A canonical Properties page exists per workspace, created at workspace bootstrap. Property-schema blocks live as its children. Convention: one Properties page per workspace, identified by a stable id or a `panel:properties` type tag. The page is a normal navigable block — users can open it to see the list of schemas, click into one, and edit it.

#### 4a. Dedicated block renderer for property-schema blocks

Editing a schema isn't a property-panel concern. The property-schema block has its own **block renderer** registered via `blockRenderersFacet` ([type-system.md §4b](type-system.md)), with `canRender: block => block.hasType('property-schema')`. The renderer owns the schema-editing UI:

```
┌───────────────────────────────────────────────┐
│  [Glyph]  homepage                            │  ← propertyName field, inline-editable
│                                               │
│  Type:  [URL ▾]                               │  ← preset picker; reads valuePresetsFacet
│                                               │
│  ┌─────────────────────────────────────────┐  │
│  │ <preset.ConfigEditor for current preset>│  │  ← reuses the same component the
│  └─────────────────────────────────────────┘  │     AddPropertyForm shows in
│                                               │     FieldConfigSheet
└───────────────────────────────────────────────┘
```

The renderer reads `presetIdProp` to find the current preset, dispatches to `preset.ConfigEditor` for the config field, and writes back to `presetConfigProp` directly through the existing `block.set` path. No property panel involvement; `presetConfigProp` stays hidden from the panel.

This solves three things at once:

- **Schema editing has a real surface.** Not "navigate to the Properties page and edit raw JSON in some dev-tool path" — a normal in-app UI.
- **`ConfigEditor` is reused.** The same component the AddPropertyForm renders inside `FieldConfigSheet` is the one the schema-block renderer dispatches to. One implementation, two callsites. A `'ref'` preset shipping `RefTargetTypePicker` covers both creation-time configuration and after-the-fact editing.
- **Changing presets is a real operation.** The picker lets users swap the preset (e.g., `string` → `url`) — writing the new preset id to `presetIdProp`, the subscription re-runs, the schema's codec changes, and §7-bis reprojection fires for ref-codec changes if applicable. Same path as a write through `addSchema`.

For schemas whose preset has no `ConfigEditor` (primitive presets — `string`, `number`, etc.), the renderer just shows the name and preset picker. The config editor area is empty.

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
        const built = this.tryBuildSchema(block, presets)
        if (built) contributions.push(built)
      }
      this.repo.setRuntimeContributions(propertySchemasFacet, 'user-data', contributions)
    })
  }

  /** Validates a schema block against the current presets and returns
   *  the schema if it parses, or null with a logged diagnostic if not.
   *  Three skip paths: (1) preset not loaded, (2) name empty,
   *  (3) configCodec.decode throws. The block stays in the database
   *  untouched; a fix to the block re-runs this on the next
   *  subscription tick. */
  private tryBuildSchema(
    block: Block,
    presets: ReadonlyMap<string, AnyValuePreset>,
  ): AnyPropertySchema | null {
    const presetId = block.get(presetIdProp)
    const preset = presets.get(presetId)
    if (!preset) {
      console.warn(`[UserSchemasService] schema block ${block.id} references unknown preset ${JSON.stringify(presetId)}; preset's plugin may not be loaded`)
      return null
    }
    const name = block.get(propertyNameProp)
    if (!name) {
      console.warn(`[UserSchemasService] schema block ${block.id} has empty propertyName`)
      return null
    }
    let config: unknown
    try {
      const raw = block.get(presetConfigProp)
      config = preset.configCodec ? preset.configCodec.decode(raw) : preset.defaultConfig
    } catch (err) {
      console.warn(`[UserSchemasService] schema "${name}" has invalid config: ${(err as Error).message}; skipping until fixed`)
      return null
    }
    return {
      name,
      codec: preset.build(config),
      defaultValue: preset.defaultValue,
      changeScope: ChangeScope.BlockDefault,
    }
  }

  has(name: string): boolean {
    // Used by AddPropertyForm's collision preflight. Reads the most
    // recently emitted contribution list (kept on the service in the
    // implementation; omitted from this sketch for brevity).
    return this.contributions.some(s => s.name === name)
  }

  appendUserSchema(schema: AnyPropertySchema): void {
    // Synchronous slot-update primitive used by addSchema (§7).
    this.contributions = [...this.contributions.filter(s => s.name !== schema.name), schema]
    this.repo.setRuntimeContributions(propertySchemasFacet, 'user-data', this.contributions)
  }
}
```

Behavior:

- Every time a property-schema block is created, edited, or deleted, the subscription fires and the service rebuilds the user-data contribution list. Each block goes through `tryBuildSchema`, which validates preset existence + name presence + config decode through the preset's `configCodec`. Failures log a diagnostic and skip the contribution; the block stays in the database for the user to fix.
- Preset-not-loaded entries are skipped with a logged warning. They reappear on the next subscription fire after the plugin lands (the subscription doesn't refire on plugin load alone — see "preset facet changes" below).
- Invalid config entries are skipped with a logged warning. The schema-block renderer (§4a) surfaces the same status visually so the user sees what's wrong without checking the console.
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
- **User types a fresh name and submits without picking** → form `await`s `userSchemasService.addSchema({name, presetId, config})`. The service creates the property-schema block **and** synchronously updates the user-data facet bucket inside the same step (per §7's "synchronous registration" subsection), so by the time the promise resolves, `repo.propertySchemas.get(name)` returns the new schema. The form then writes the initial value through the now-registered schema. **The form must not write the property value before `addSchema` resolves** — the subscription path is async and racing with it leads to a fall-through to the unknown-schema fallback.

The adoption-cheap path reinforces the §3 hybrid rule (shared vocabulary stays shared) by making "use the existing one" the default outcome.

#### Collision preflight

The rule is simpler than user-data-vs-direct source attribution: **any visible registered schema is adoptable; hidden/reserved names are refused.** The §3 hybrid rule in [type-system.md](type-system.md) explicitly wants users to share vocabulary — adopting kernel's `status` for a block is a feature, not a bug. There's no reason to refuse based on whose source registered the schema.

```ts
const existing = repo.propertySchemas.get(name)
if (!existing) return 'create-new'         // miss → addSchema with current preset
const ui = repo.propertyUis.get(name)
if (ui?.hidden) return 'refused-reserved'  // kernel-internal slot (editorFocusRequest, etc.)
return 'adopt'                             // shared vocabulary or user's own — same path
```

`PropertyUiContribution.hidden` (or `PropertyEditorOverride.hidden` after the rename — see the spawned cleanup task) is the existing flag the kernel uses on its ~13 internal state schemas. The form reads it for the refusal case; no schema-source-provenance metadata is threaded through the merged map. The merged-map shape stays `ReadonlyMap<string, AnyPropertySchema>` with no provenance value.

This drops the prior "user-data → adopt; kernel/plugin → refuse" distinction. Adopting `status` from a kernel/plugin source is exactly what the §3 hybrid rule wants. The only refusal case is "this name is a reserved slot, not a property" — which the hidden flag already encodes.

### 7. `addSchema` — create the schema block AND register synchronously

```ts
// On UserSchemasService
async addSchema(args: {
  name: string
  presetId: string
  config?: unknown
}): Promise<AnyPropertySchema> {
  const presets = this.repo.read(valuePresetsFacet)
  const preset = presets.get(args.presetId)
  if (!preset) throw new Error(`[addSchema] no preset registered for id ${args.presetId}`)

  // Build the schema up-front so it's ready to register synchronously.
  const newSchema: AnyPropertySchema = {
    name: args.name,
    codec: preset.build(args.config),
    defaultValue: preset.defaultValue,
    changeScope: ChangeScope.BlockDefault,
  }

  const propertiesPageId = this.repo.propertiesPageId
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

  // Register the schema synchronously, before returning. The
  // subscription will fire later (the block write triggers it) but
  // arrive at an idempotent state — same name, same preset, same
  // config decoded back into the same codec.
  this.appendUserSchema(newSchema)
  return newSchema
}

// On UserSchemasService — synchronous slot update
private appendUserSchema(schema: AnyPropertySchema): void {
  this.userSchemas = [...this.userSchemas.filter(s => s.name !== schema.name), schema]
  this.repo.setRuntimeContributions(propertySchemasFacet, 'user-data', this.userSchemas)
}
```

**Why synchronous registration is load-bearing.** The form's flow is "addSchema, then write the property's initial value." If we leaned on the subscription to update the user-data bucket, the next write could race the subscription tick and `repo.propertySchemas.get(name)` would return undefined — the unknown-schema fallback path takes over and we end up with an ad-hoc string property instead of a properly-typed one. The same shape applies to the Roam importer (§8): planned schema objects are registered synchronously via `appendUserSchema` during apply, before any content write that depends on them. Both call sites take the registration into the **command path** rather than waiting for the reactive subscription. The subscription is steady-state for *external* changes (sync from another device, hand-edit of a property-schema block, undo/redo) where there's no caller waiting for the next write.

**Removal and edit.** `repo.removeBlock(schemaBlockId)` — the subscription fires, `appendUserSchema`'s symmetric removal counterpart updates the slot. Editing config (e.g., adding `targetTypes` to a ref): change the property-schema block's `presetConfigProp` value, subscription fires, schema gets rebuilt with the new codec. A ref-codec set change triggers §7-bis reprojection over rows carrying the property name. No special path needed; the subscription is sufficient because edits aren't followed by an immediate dependent write.

### 8. Roam importer — schema reconciliation

Schemaless properties go away as a steady-state design. Every imported `key:: value` attribute resolves to a registered schema. The importer's plan phase grows a reconciliation step that produces *both* the planned property-schema blocks *and* the corresponding `PropertySchema` objects, threaded into the apply phase as a single bundle. Apply registers schemas synchronously — never relies on the subscription to deliver schemas in time for downstream property writes.

#### Plan phase

1. **Collect.** Walk the parsed dump, build the set of unique property names appearing across all blocks.
2. **Resolve against current registry.** For each name, if a schema is already in `repo.propertySchemas` (kernel, plugin, or pre-existing user schema) → record the binding (schema object → name) and skip classification.
3. **Classify unregistered names.** For each remaining name, sample values across the dump:
   - All values are `[[…]]` page references → `refList` preset, no `targetTypes` constraint (we don't know what types the targets should be).
   - All values are valid numbers → `number` preset.
   - All values are `true` / `false` → `boolean` preset.
   - Otherwise → `string` preset.
   The defaults are deliberately conservative — `refList` for the common Roam-attribute case, fall through to `string` for anything ambiguous. Users can edit the resulting property-schema blocks via §4a to narrow (`refList` → single `ref`, add `targetTypes`, etc).
4. **Build schema objects up-front.** For each newly-classified name, build the `PropertySchema` immediately by running the chosen preset's `build` against `defaultConfig`. The plan now carries `{schemaBlock: BlockData, schema: PropertySchema}` pairs — the block plus the runtime registration object, decided at plan time.
5. **Plan schema blocks.** For each newly-classified name, emit a property-schema block into the deterministic-id plan. Schema block id is `hash(workspaceId, propertyName)` so re-importing the same dump doesn't duplicate. Parent is the Properties page. The block's `presetConfigProp` value is encoded via the preset's `configCodec` (so it round-trips through validation when the subscription later picks it up).

#### Apply phase

6. **Register schemas synchronously, then write blocks, then write content.** The apply phase iterates the planned schemas and:
   - Calls `userSchemasService.appendUserSchema(schema)` for each planned schema *before any property write that depends on it*. This updates the user-data facet bucket in the same tick, before the importer continues. The schemas are now in `repo.propertySchemas` and visible to all subsequent writes.
   - Writes the property-schema blocks (their persistence). The subscription will fire later, walk the schema blocks, and arrive at an idempotent state (same name + presetId + decoded config = same schema object structurally, modulo the function-identity of the codec; the slot's last-wins-on-source means the later subscription-emitted contribution replaces the earlier-appended one with no observable change).
   - Writes the content blocks and their properties, encoded against the now-registered schemas.

   The subscription is **not in the critical path** for the importer. Schema visibility is established by the synchronous `appendUserSchema` calls, not by waiting for a subscription tick.

7. **Normalize ref values to ids before writing.** A Roam `Status:: [[Project]]` parsed value is the *token* `[[Project]]`, not a block id — but the `refList` codec decodes string arrays of *ids*, not tokens. The importer's existing reference-resolution layer (the same code that resolves `[[Project]]` in block content to a target block id) must run on attribute values before they're written to a refList property; otherwise decode throws and `references_json` projection emits bogus target ids. Concretely: when classifying a property value as `refList`, transform the parsed value through the existing token→id resolver, write the array of resolved ids to the property, and only then commit. Ambiguous tokens (page that doesn't exist in the dump, multiple matches, etc.) follow the importer's existing not-found policy — typically create the target page if it's a `[[…]]` reference, or fall back to a string preset for that property if resolution is ambiguous across the dump.

#### Why plan-time schema objects matter

Carrying schema *objects* (not just block plans) through plan→apply means the importer never has a window where it has written content but not yet registered the schema. The previous "schema chunk first, content chunks second; rely on subscription tick between chunks" shape was fragile precisely because it crossed the boundary between writes and reactivity. With schemas-as-data threaded through the plan, registration is deterministic and synchronous; the schema-block writes are still part of the plan (they're how the registration *persists*), but they aren't on the critical path for in-tick visibility.

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

1. Add `'property-schema'` type contribution and the three kernel schemas (`propertyNameProp`, `presetIdProp`, `presetConfigProp`). `presetConfigProp` is hidden via `PropertyUiContribution.hidden = true`.
2. Workspace bootstrap creates the Properties page if it doesn't exist (deterministic id, idempotent).
3. Register a `blockRenderersFacet` contribution for blocks of type `'property-schema'` per §4a — preset picker + dispatched `ConfigEditor`. Reuses the same `preset.ConfigEditor` component the AddPropertyForm renders inside `FieldConfigSheet`.
4. Implement `UserSchemasService` with the `subscribeBlocks` subscription **and** the synchronous `appendUserSchema` slot-update path used by `addSchema` (per §7). (Requires [type-system.md §8](type-system.md)'s typed-query primitive — phase order this one after.)
5. Wire `AddPropertyForm`'s submit path: collision preflight via `userSchemasService.has(name)` → either adopt existing schema or `await userSchemasService.addSchema(...)` and only then write the property's initial value.
6. Add name autocomplete to `AddPropertyForm` keyed off `repo.propertySchemas`.
7. Tests: creating a schema via the form persists as a block, survives reload, fires the subscription, updates the merged map, makes the schema visible to `BlockProperties` synchronously after `addSchema` resolves (no race with subscription tick). Edit + delete of schema blocks reactively updates.

After this phase, user-created schemas with full preset semantics persist across reloads and sync.

### Phase 4 — Roam importer schema reconciliation

1. Add the schema-reconciliation step to the Roam importer plan phase ([src/utils/roamImport/plan.ts](src/utils/roamImport/plan.ts)). Sample-and-classify, plan deterministic-id schema blocks, sequence apply chunks so schemas land first.
2. Demote `adhocSchema` to degraded-read-only — remove the form's write-time use of it; keep the fallback for sync-race and plugin-not-loaded cases.
3. Add a "no schema registered" hint in `BlockProperties` for properties that fall through to the degraded path, with a one-click "register a schema for this" action that opens `AddPropertyForm` pre-filled with the property name.
4. Tests: import a Roam dump with a few attribute kinds, verify schema blocks emitted, verify reapply on the same dump is idempotent.

Existing alpha local databases are wiped (per the no-back-compat rule); users reimport their dumps under the new importer. After this phase, schemaless properties are gone from the steady-state shape.

## Decisions deferred / out of scope

- **Schema editing surfaces beyond the property-schema renderer.** §4a's dedicated renderer covers the per-schema editing UI. v1 doesn't ship a bulk-rename / bulk-config-update path or schema-search beyond what navigating to the Properties page provides. Fine to add later if needed.
- **Per-block schema overrides.** The §3 hybrid rule says distinct semantics → distinct schema names. No per-block override mechanism in v1.
- **Cross-workspace schema sharing.** Schemas are workspace-scoped (Properties page is per workspace). Sharing a schema definition across workspaces would need a separate import / link mechanism; not v1.
- **Validation rules on schemas.** A schema's codec defines storage shape; it doesn't validate semantic constraints (URL format beyond what `urlCodec` enforces, ref target-type intersection, value ranges on numbers). Validation is the deferred follow-up from [type-system.md §3b](type-system.md).
- **Top-level reconfigure granularity beyond per-facet.** CodeMirror-style compartments wrapping arbitrary extension subtrees are out of scope; the per-facet runtime-source granularity covers the projected use cases (user schemas, future user types, future user keymap overrides) without dependency tracking inside facet `combine`.
