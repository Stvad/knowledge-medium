import type { JSX } from 'react'
import type { Codec } from './codecs'
import type { ChangeScope } from './changeScope'

export type PropertyKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'list'
  | 'object'
  | 'date'
  | 'ref'
  | 'refList'

/** Data-layer schema. Pure data — usable from non-React surfaces (server,
 *  CLI, headless tests, future non-React UIs). React presentation lives on
 *  `PropertyUiContribution<T>` (joined to schemas by `name`). See spec §5.6. */
export interface PropertySchema<T> {
  readonly name: string
  /** Storage codec; runs at the four boundary call sites only. */
  readonly codec: Codec<T>
  readonly defaultValue: T
  readonly changeScope: ChangeScope
  /** Drives the unknown-schema fallback (§5.6.1) — when a plugin's schema
   *  is absent, the property panel infers a kind from JSON shape and
   *  renders via the default editor for that kind. */
  readonly kind: PropertyKind
}

/** React UI contribution. Joined to a registered `PropertySchema` by
 *  `name` at render time. Optional — primitive-typed properties render
 *  via the kernel's default editor for their `kind` if no contribution
 *  is present. See spec §5.6 + §6. */
export interface PropertyUiContribution<T = unknown> {
  /** Must match a registered `PropertySchema.name`. Multiple contributions
   *  for the same name log a warning and last-wins (facet convention). */
  readonly name: string
  /** Display name (defaults to `name` when absent). */
  readonly label?: string
  /** Property-editor grouping. */
  readonly category?: string
  /** Hide from the normal property panel. Hidden rows can still be
   *  revealed in the debug/metadata section, but the panel treats them
   *  as read-only internal fields. */
  readonly hidden?: boolean
  readonly Editor?: PropertyEditor<T>
  readonly Renderer?: PropertyRenderer<T>
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

export interface PropertyRendererProps<T> {
  value: T
  block: unknown
}

export type PropertyRenderer<T> = (props: PropertyRendererProps<T>) => JSX.Element

/** Plugin-augmentable type registry for property schemas — mirrors
 *  `MutatorRegistry` and `QueryRegistry`. Static plugins augment via
 *  `declare module '@/data/api'`; dynamic plugins use string-keyed access. */
/** Plugin-augmentable type registry. Empty body is intentional —
 *  declaration merging requires interface. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PropertySchemaRegistry { /* augmented per plugin */ }

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PropertyUiRegistry { /* augmented per plugin */ }

/** Helper for plugin authors to define a schema with full type inference
 *  on `defaultValue`. */
export const defineProperty = <T>(
  name: string,
  schema: Omit<PropertySchema<T>, 'name'>,
): PropertySchema<T> => ({ name, ...schema })

export const definePropertyUi = <T>(
  contribution: PropertyUiContribution<T>,
): PropertyUiContribution<T> => contribution

/** Variance-erased schema type for storage in heterogeneous collections
 *  (`propertySchemasFacet`'s contributions, etc.). `PropertySchema<T>`
 *  is invariant in `T` through `defaultValue` and `codec`, so typed
 *  plugin schemas can't widen to `PropertySchema<unknown>`. The `any`
 *  escape mirrors `AnyMutator` / `AnyPostCommitProcessor`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPropertySchema = PropertySchema<any>

/** Variance-erased UI-contribution type for storage in
 *  `propertyUiFacet`'s contributions. `PropertyEditor<T>` /
 *  `PropertyRenderer<T>` are contravariant in `T` (they accept
 *  `value: T`), so typed plugin contributions can't widen to
 *  `PropertyUiContribution<unknown>`. Same `any`-escape pattern. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPropertyUiContribution = PropertyUiContribution<any>
