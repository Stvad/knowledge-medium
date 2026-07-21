import type { ComponentType, JSX } from 'react'
import type { Codec } from './codecs'
import type { ChangeScope } from './changeScope'

/** Data-layer schema. Pure data — usable from non-React surfaces (server,
 *  CLI, headless tests, future non-React UIs). React presentation lives
 *  separately: most properties pick up an editor from a future
 *  ValuePreset (codec-type → editor) and never need anything more.
 *  Per-definition *outlier* overrides — type-aware autocompletes, singleton
 *  config editors, hidden kernel-internal state — go on
 *  `PropertyEditorOverride<T>` (joined to definitions by seed identity).
 *  See spec §5.6, §8. */
export interface PropertySchemaEntry<T> {
  readonly name: string
  /** Storage codec; runs at the four boundary call sites only. */
  readonly codec: Codec<T>
  readonly defaultValue: T
  readonly changeScope: ChangeScope
}

/** Static, workspace-agnostic handle returned by seeded code declarations.
 * The stable seed key can be resolved to a definition id only for a concrete
 * workspace; handles therefore never carry `fieldId` or `workspaceId`.
 *
 * `seedProperty` returns this type. Existing `defineProperty` declarations
 * remain behavioral entries until their Slice-B conversion. */
export interface PropertyHandle<T> extends PropertySchemaEntry<T> {
  readonly seedKey: string
}

/** Nominal marker: a resolved schema may only be obtained through Repo's
 * workspace-bound resolution primitive. Callers cannot accidentally satisfy
 * this contract with an ambient registry entry that has no durable identity. */
declare const resolvedPropertySchemaBrand: unique symbol

export type PropertySchemaOrigin = 'kernel' | `plugin:${string}` | 'user'

export interface ResolvedPropertySchema<T> extends PropertySchemaEntry<T> {
  readonly fieldId: string
  readonly workspaceId: string
  readonly hidden: boolean
  readonly origin: PropertySchemaOrigin
  readonly [resolvedPropertySchemaBrand]: true
}

export type PropertySchemaIdentityUnavailableReason =
  | 'registry-not-workspace-keyed'
  | 'definition-unavailable'
  | 'shadowed'
  | 'ambiguous'

/** Result of the workspace-bound identity resolver. Unbound/stage-0 callers
 * and definitions without locally-buildable behavior report identity as
 * unavailable; no synthetic ambient-workspace fallback is permitted. */
export type PropertySchemaResolution<T> =
  | {readonly status: 'resolved'; readonly schema: ResolvedPropertySchema<T>}
  | {
      readonly status: 'identity-unavailable'
      readonly reason: PropertySchemaIdentityUnavailableReason
    }

/** Compatibility interface for existing call sites and external declaration
 * merging. Slice B narrows seeded code declarations to `PropertyHandle` while
 * the ambient registry continues to consume the behavioral entry shape. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PropertySchema<T> extends PropertySchemaEntry<T> {}

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
  /** The `seedKey` of the definition this override presents. The join
   *  resolves seedKey → the workspace's winning definition at render time,
   *  so it is immune to display-name changes. Multiple overrides for the same
   *  seedKey log a warning and last-wins (facet convention). B′ replaced the
   *  former name key with this. */
  readonly seedKey: string
  /** Display name (defaults to the definition name when absent). */
  readonly label?: string
  /** Hide from the normal property panel. Hidden rows can still be
   *  revealed in the debug/metadata section; this affects placement and
   *  destructive capabilities, not value editability. */
  readonly hidden?: boolean
  readonly Editor?: PropertyEditor<T>
  /** Optional glyph override. Defaults to the matching `ValuePreset.Glyph`
   *  when absent. Use sparingly — most properties pick up the codec-type-keyed
   *  glyph from the preset and don't need a per-definition shape.
   *  See user-defined-properties §1-ui. */
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

/** Canonical narrowing of `PropertyEditorProps.block` (an opaque `unknown`)
 *  to "is this block's repo read-only?". Several config editors otherwise
 *  re-derive this identical guard. */
export const isReadOnlyBlock = (block: unknown): boolean => {
  if (!block || typeof block !== 'object') return false
  const repo = (block as { repo?: { isReadOnly?: unknown } }).repo
  return repo?.isReadOnly === true
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

/** One `(schema, value)` pair for `tx.setProperties`. Build these with
 *  `propertyValue` so `value` is type-checked against `schema` at the call
 *  site; the batch list itself is variance-erased (`AnyPropertyAssignment`),
 *  the same escape `AnyPropertySchema` uses for heterogeneous storage. */
export interface PropertyAssignment<T> {
  readonly schema: PropertySchema<T>
  readonly value: T
}

/** Pair a schema with a value for a `tx.setProperties` batch, enforcing
 *  `value: T` matches `schema: PropertySchema<T>` at the call site. */
export const propertyValue = <T>(
  schema: PropertySchema<T>,
  value: T,
): PropertyAssignment<T> => ({ schema, value })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPropertyAssignment = PropertyAssignment<any>

/** Helper for the rare property that needs a per-definition editor override.
 *  Pass the seed handle the override presents; its `seedKey` is the join key
 *  (name-independent, immune to renames). Most plugins should NOT reach for
 *  this — registering an override is the outlier path. The common path is a
 *  codec-type-based ValuePreset. */
export const definePropertyEditorOverride = <T>(
  handle: PropertyHandle<T>,
  override: Omit<PropertyEditorOverride<T>, 'seedKey'>,
): PropertyEditorOverride<T> => {
  // Fail loud on a stale caller passing the pre-B′ `{name, …}` object shape:
  // without a seed handle there is no identity to join on.
  if (typeof handle?.seedKey !== 'string') {
    throw new Error(
      '[definePropertyEditorOverride] first argument must be a seed handle ' +
      '(from seedProperty); the name-keyed override shape was removed in B′',
    )
  }
  // The handle's seedKey is authoritative: spread the body first so a stray
  // `seedKey` from a types-stripped dynamic extension can't clobber it.
  return {...override, seedKey: handle.seedKey}
}

/** Runtime guard for dynamic-extension override contributions (the loader
 *  binds their seedKey to the owning block before registration). Rejects a
 *  seed declaration mis-contributed to the override facet — it also carries a
 *  string `seedKey`, but only seeds carry `revision`/`presetId`. */
export const isPropertyEditorOverride = (
  value: unknown,
): value is AnyPropertyEditorOverride => {
  if (typeof value !== 'object' || value === null) return false
  const v = value as {seedKey?: unknown; revision?: unknown; presetId?: unknown}
  return typeof v.seedKey === 'string' && v.seedKey.length > 0 &&
    v.revision === undefined && v.presetId === undefined
}

/** Variance-erased schema type for storage in heterogeneous collections
 *  (the merged registry, type-lifted `TypeContribution.properties`, etc.).
 *  `PropertySchema<T>` is invariant in `T` through `defaultValue` and
 *  `codec`, so typed plugin schemas can't widen to `PropertySchema<unknown>`.
 *  The `any` escape mirrors `AnyMutator` / `AnyPostCommitProcessor`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPropertySchema = PropertySchema<any>

/** Variance-erased editor-override type for storage in
 *  `propertyEditorOverridesFacet`'s contributions. `PropertyEditor<T>` is
 *  contravariant in `T` (it accepts `value: T`), so typed plugin
 *  overrides can't widen to `PropertyEditorOverride<unknown>`. Same
 *  `any`-escape pattern. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPropertyEditorOverride = PropertyEditorOverride<any>
