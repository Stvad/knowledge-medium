/**
 * Togglable primitives — the runtime enable/disable surface.
 *
 * Part of the zero-data facet kernel (`src/facets/`): this file depends
 * only on `facet.ts` and imports nothing from `@/data`. Building a
 * toggle from an extension *block* means reading block properties to
 * resolve a display name — that decode lives one layer up, in
 * `@/extensions/extensionToggles.ts`, which resolves the labels and
 * passes plain strings into `userToggle` here. Keeping the block-decode
 * out of the kernel is what lets `@/data` import these primitives
 * without a data↔facets cycle.
 *
 * The shipping shapes match docs/plugin-runtime-toggle/design.ts. The
 * design file is a typechecked sketch (`yarn tsc --noEmit -p
 * docs/tsconfig.json`); this file is the real implementation. Anything
 * that drifts between the two — field names, factory signatures,
 * boundary semantics — is a correctness bug, not a stylistic one.
 *
 * Highlights:
 *
 *   - `Togglable` is the user-visible identity for a toggle. Its
 *     `of(ext)` wraps an AppExtension array with a non-enumerable
 *     BOUNDARY symbol carrying the handle, so the collector + discovery
 *     walks can evaluate `isEnabled(handle, overrides)` without a side
 *     registry of handles.
 *
 *   - Two factories, deliberately not one:
 *       systemToggle({...})    — full surface, app-supplied metadata
 *       userToggle({id, name}) — id + display metadata supplied by the
 *                                caller; defaultEnabled forced to false
 *     The asymmetry is type-enforced: user extensions are loaded by
 *     compiling a module, which we *skip* unless an override is `true`,
 *     so display metadata must be resolvable without compiling
 *     executable code. The `@/extensions/extensionToggles.ts` wrappers
 *     produce that metadata from block properties.
 */

import type {AppExtension} from '@/facets/facet.js'

// ──────────────────────────────────────────────────────────────────────
// Handle + boundary marker
// ──────────────────────────────────────────────────────────────────────

/** Where a togglable came from. The settings UI uses this to bucket
 *  toggles into "Built-in extensions" vs "User extensions" sections, since
 *  the two have different ergonomics (built-in extensions ship with the
 *  app; user extensions can be added/removed/reloaded by the user).
 *  Set by the factory and not user-settable. */
export type TogglableKind = 'system' | 'user'

export interface Togglable {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly essential?: boolean
  /** undefined ≡ true. Honoured for built-in extensions; forced false for
   *  user extensions (see `userToggle`). */
  readonly defaultEnabled?: boolean
  readonly kind: TogglableKind
  of(ext: AppExtension): AppExtension
}

const BOUNDARY = Symbol('togglable.boundary')

type BoundaryArray = AppExtension[] & {[BOUNDARY]?: Togglable}

function markBoundary(handle: Togglable, ext: AppExtension): AppExtension {
  const wrapped: BoundaryArray = [ext]
  Object.defineProperty(wrapped, BOUNDARY, {
    value: handle,
    enumerable: false,
  })
  return wrapped
}

/** Read the boundary handle stored on an array, or undefined if the
 *  node isn't a togglable boundary. */
export function getBoundary(node: unknown): Togglable | undefined {
  if (!node || typeof node !== 'object') return undefined
  return (node as BoundaryArray)[BOUNDARY]
}

/** Restore the boundary marker on an array produced by `.map()` or
 *  similar (which always returns a fresh array, dropping non-enumerable
 *  symbols). Used by `validateAndPrefix` so user-extension boundaries
 *  survive normalisation. Exported as the canonical way to attach a
 *  boundary to an existing array; do not redefine the symbol externally. */
export function attachBoundary(
  target: AppExtension[],
  handle: Togglable,
): void {
  Object.defineProperty(target, BOUNDARY, {
    value: handle,
    enumerable: false,
    configurable: true,
  })
}

// ──────────────────────────────────────────────────────────────────────
// Factories
// ──────────────────────────────────────────────────────────────────────

export interface SystemToggleOptions {
  id: string
  name: string
  description?: string
  essential?: boolean
  defaultEnabled?: boolean
}

export function systemToggle(opts: SystemToggleOptions): Togglable {
  const handle: Togglable = {
    id: opts.id,
    name: opts.name,
    description: opts.description,
    essential: opts.essential,
    defaultEnabled: opts.defaultEnabled,
    kind: 'system',
    of: (ext) => markBoundary(handle, ext),
  }
  return handle
}

/** Display metadata for a user toggle. The caller (today,
 *  `@/extensions/extensionToggles.ts`) resolves these from extension
 *  block properties — without compiling the block — and passes them in,
 *  so this kernel stays free of any `@/data` dependency. */
export interface UserToggleOptions {
  /** Locked to the extension block id by the caller. */
  id: string
  /** Pre-resolved display name (already falls back to alias / id snippet
   *  upstream). */
  name: string
  /** Pre-resolved description, if the block carries one. */
  description?: string
}

/** User-extension toggle: `essential` and `kind` are fixed, and
 *  `defaultEnabled` is forced to `false` so an extension's module code
 *  never runs until an explicit `true` override opts it in. Unlike
 *  `systemToggle`, the display metadata is supplied by the caller rather
 *  than read here — see `UserToggleOptions`. */
export function userToggle(opts: UserToggleOptions): Togglable {
  const handle: Togglable = {
    id: opts.id,
    name: opts.name,
    description: opts.description,
    essential: false,
    defaultEnabled: false,
    kind: 'user',
    of: (ext) => markBoundary(handle, ext),
  }
  return handle
}

// ──────────────────────────────────────────────────────────────────────
// Overrides + enabled-state computation
// ──────────────────────────────────────────────────────────────────────

export type Overrides = ReadonlyMap<string, boolean>

export function isEnabled(handle: Togglable, overrides: Overrides): boolean {
  if (handle.essential) return true
  const override = overrides.get(handle.id)
  if (override !== undefined) return override
  return handle.defaultEnabled ?? true
}

/** UI toggle convention. Returns a new overrides map; comparing
 *  against `defaultEnabled ?? true` keeps the map free of entries that
 *  match the manifest default. */
export function applyToggle(
  overrides: Overrides,
  handle: Togglable,
  nextState: boolean,
): Overrides {
  const next = new Map(overrides)
  const defaultState = handle.defaultEnabled ?? true
  if (nextState === defaultState) next.delete(handle.id)
  else next.set(handle.id, nextState)
  return next
}
