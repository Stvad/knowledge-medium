import type { ComponentType, JSX } from 'react'
import type { Codec } from './codecs'
import type { ChangeScope } from './changeScope'

/** Data-layer schema. Pure data — usable from non-React surfaces (server,
 *  CLI, headless tests, future non-React UIs). React presentation lives
 *  separately: most properties pick up an editor from a future
 *  ValuePreset (codec-type → editor) and never need anything more.
 *  Per-name *outlier* overrides — type-aware autocompletes, singleton
 *  config editors, hidden kernel-internal state — go on
 *  `PropertyEditorOverride<T>` (joined to schemas by `name`). See spec §5.6. */
export interface PropertySchema<T> {
  readonly name: string
  /** Storage codec; runs at the four boundary call sites only. */
  readonly codec: Codec<T>
  readonly defaultValue: T
  readonly changeScope: ChangeScope
}

/** Per-name override for the rare property whose presentation can't be
 *  derived from its codec type plus a ValuePreset. Joined to a registered
 *  `PropertySchema` by `name` at render time.
 *
 *  Reach for this only when one of:
 *    - the property needs a type-aware editor that isn't a value-type
 *      concept (e.g. block-types autocomplete on `types`),
 *    - the property is a singleton with its own config editor,
 *    - the property is internal kernel state and should be `hidden`.
 *
 *  Most properties don't need an override — leave them alone and the
 *  codec/preset chain renders them. See spec §5.6 + §6. */
export interface PropertyEditorOverride<T = unknown> {
  /** Must match a registered `PropertySchema.name`. Multiple overrides
   *  for the same name log a warning and last-wins (facet convention). */
  readonly name: string
  /** Display name (defaults to `name` when absent). */
  readonly label?: string
  /** Hide from the normal property panel. Hidden rows can still be
   *  revealed in the debug/metadata section; this affects placement and
   *  destructive capabilities, not value editability. */
  readonly hidden?: boolean
  readonly Editor?: PropertyEditor<T>
  /** Optional per-name glyph override. Defaults to the matching
   *  `ValuePreset.Glyph` when absent. Use sparingly — most properties
   *  pick up the codec-type-keyed glyph from the preset and don't
   *  need a per-name shape. See user-defined-properties §1-ui. */
  readonly Glyph?: ComponentType<{className?: string}>
}

export interface PropertyEditorProps<T> {
  value: T
  onChange: (next: T) => void
  /** Schema being edited. Present for schema-backed property panel
   *  renderers; optional so older UI contributions that only need
   *  value/onChange/block keep their existing shape. */
  schema?: PropertySchema<T>
  /** The block being edited. Type kept loose here so the data-layer api
   *  module doesn't need to import the `Block` facade (defined in
   *  `src/data/block.ts`). UI consumers narrow at the call site. */
  block: unknown
}

export type PropertyEditor<T> = (props: PropertyEditorProps<T>) => JSX.Element

/** Plugin-augmentable type registry for property schemas — mirrors
 *  `MutatorRegistry` and `QueryRegistry`. Static plugins augment via
 *  `declare module '@/data/api'`; dynamic plugins use string-keyed access. */
/** Plugin-augmentable type registry. Empty body is intentional —
 *  declaration merging requires interface. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PropertySchemaRegistry { /* augmented per plugin */ }

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PropertyEditorOverrideRegistry { /* augmented per plugin */ }

/** Helper for plugin authors to define a schema with full type inference
 *  on `defaultValue`. */
export const defineProperty = <T>(
  name: string,
  schema: Omit<PropertySchema<T>, 'name'>,
): PropertySchema<T> => ({ name, ...schema })

/** Helper for the rare property that needs a per-name editor override.
 *  Most plugins should NOT reach for this — registering an override is
 *  the outlier path. The common path is a codec-type-based ValuePreset. */
export const definePropertyEditorOverride = <T>(
  override: PropertyEditorOverride<T>,
): PropertyEditorOverride<T> => override

/** Variance-erased schema type for storage in heterogeneous collections
 *  (`propertySchemasFacet`'s contributions, etc.). `PropertySchema<T>`
 *  is invariant in `T` through `defaultValue` and `codec`, so typed
 *  plugin schemas can't widen to `PropertySchema<unknown>`. The `any`
 *  escape mirrors `AnyMutator` / `AnyPostCommitProcessor`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPropertySchema = PropertySchema<any>

/** Variance-erased editor-override type for storage in
 *  `propertyEditorOverridesFacet`'s contributions. `PropertyEditor<T>` is
 *  contravariant in `T` (it accepts `value: T`), so typed plugin
 *  overrides can't widen to `PropertyEditorOverride<unknown>`. Same
 *  `any`-escape pattern. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPropertyEditorOverride = PropertyEditorOverride<any>
