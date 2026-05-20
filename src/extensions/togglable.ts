/**
 * Togglable primitives — the runtime enable/disable surface.
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
 *       systemToggle({...})        — full surface
 *       userExtensionToggle(block) — id locked to block.id,
 *                                    defaultEnabled forced to true
 *     The asymmetry is type-enforced: user extensions are loaded by
 *     compiling a module, which we *skip* when an override is `false`,
 *     so we can't honour any author-supplied id or defaultEnabled
 *     (we'd need to compile to read them, defeating the skip).
 *
 *   - `authorHints({name?, description?}, ext)` is the only API a
 *     user-extension module can call. It doesn't take an id or
 *     defaultEnabled, so the asymmetry is unrepresentable at the type
 *     level.
 */

import type {AppExtension} from '@/extensions/facet.ts'
import type {BlockData} from '@/data/api'
import {aliasesProp} from '@/data/internals/coreProperties.ts'

// ──────────────────────────────────────────────────────────────────────
// Handle + boundary marker
// ──────────────────────────────────────────────────────────────────────

export interface Togglable {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly essential?: boolean
  /** undefined ≡ true. Honoured for system plugins; forced true for
   *  user extensions (see `userExtensionToggle`). */
  readonly defaultEnabled?: boolean
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
    of: (ext) => markBoundary(handle, ext),
  }
  return handle
}

export interface UserExtensionAuthorHints {
  readonly name?: string
  readonly description?: string
}

/** Resolve a display name from block-level data only — no module
 *  compilation. Used as the disabled-shell name AND as the fallback
 *  when an enabled extension didn't wrap its export with authorHints. */
function blockOnlyName(block: BlockData): string {
  const encoded = block.properties[aliasesProp.name]
  if (encoded !== undefined) {
    try {
      const aliases = aliasesProp.codec.decode(encoded)
      if (aliases.length > 0) return aliases[0]
    } catch {
      // Malformed alias data — fall through to the block-id fallback.
    }
  }
  // Settings UI renders this string as a link to the block.
  return `Extension ${block.id.slice(0, 8)}`
}

export function userExtensionToggle(
  block: BlockData,
  authoredHints?: UserExtensionAuthorHints,
): Togglable {
  const handle: Togglable = {
    id: block.id,
    name: authoredHints?.name ?? blockOnlyName(block),
    description: authoredHints?.description,
    essential: false,
    defaultEnabled: true,
    of: (ext) => markBoundary(handle, ext),
  }
  return handle
}

/** Disabled-shell variant. Same factory, no author hints — they're
 *  unavailable because the module is intentionally not compiled. */
export function userExtensionShellToggle(block: BlockData): Togglable {
  return userExtensionToggle(block)
}

// ──────────────────────────────────────────────────────────────────────
// Author-facing metadata wrapper
// ──────────────────────────────────────────────────────────────────────

const AUTHOR_HINTS = Symbol('togglable.author-hints')

interface AuthorHintsArray extends Array<AppExtension> {
  [AUTHOR_HINTS]?: UserExtensionAuthorHints
}

/** Wraps an AppExtension with non-enumerable display-name +
 *  description hints. The loader unwraps this layer and threads the
 *  hints into `userExtensionToggle`. */
export function authorHints(
  hints: UserExtensionAuthorHints,
  ext: AppExtension,
): AppExtension {
  const wrapped: AuthorHintsArray = [ext]
  Object.defineProperty(wrapped, AUTHOR_HINTS, {
    value: hints,
    enumerable: false,
  })
  return wrapped
}

export function getAuthorHints(
  node: unknown,
): UserExtensionAuthorHints | undefined {
  if (!node || typeof node !== 'object') return undefined
  return (node as AuthorHintsArray)[AUTHOR_HINTS]
}

/** Peel a one-element authorHints wrapper. Idempotent for non-wrappers. */
export function unwrapAuthorHints(node: AppExtension): AppExtension {
  if (Array.isArray(node) && node.length === 1) return node[0] as AppExtension
  return node
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
