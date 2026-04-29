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
  readonly Editor?: PropertyEditor<T>
  readonly Renderer?: PropertyRenderer<T>
}

export interface PropertyEditorProps<T> {
  value: T
  onChange: (next: T) => void
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
