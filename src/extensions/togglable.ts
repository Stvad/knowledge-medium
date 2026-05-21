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
 *                                    defaultEnabled forced to false
 *     The asymmetry is type-enforced: user extensions are loaded by
 *     compiling a module, which we *skip* unless an override is `true`,
 *     so display metadata must come from block properties that can be
 *     read without compiling executable code.
 */

import type {AppExtension} from '@/extensions/facet.ts'
import type {BlockData} from '@/data/api'
import {aliasesProp} from '@/data/internals/coreProperties.ts'
import {
  extensionDescriptionProp,
  extensionNameProp,
} from '@/data/properties.ts'

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
   *  user extensions (see `userExtensionToggle`). */
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

/** Resolve a display name from block-level data only — no module
 *  compilation. Used as the disabled-shell name AND as the fallback
 *  for enabled extension boundaries. */
function blockStringProperty(
  block: BlockData,
  schema: typeof extensionNameProp | typeof extensionDescriptionProp,
): string | undefined {
  const encoded = block.properties[schema.name]
  if (encoded === undefined) return undefined
  try {
    const value = schema.codec.decode(encoded).trim()
    return value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

function blockOnlyName(block: BlockData): string {
  const extensionName = blockStringProperty(block, extensionNameProp)
  if (extensionName) return extensionName

  const encoded = block.properties[aliasesProp.name]
  if (encoded !== undefined) {
    try {
      const aliases = aliasesProp.codec.decode(encoded)
      const firstAlias = aliases.find(alias => alias.trim().length > 0)
      if (firstAlias) return firstAlias
    } catch {
      // Malformed alias data — fall through to the block-id fallback.
    }
  }
  // Settings UI renders this string as a link to the block.
  return `Extension ${block.id.slice(0, 8)}`
}

export function userExtensionToggle(
  block: BlockData,
): Togglable {
  const handle: Togglable = {
    id: block.id,
    name: blockOnlyName(block),
    description: blockStringProperty(block, extensionDescriptionProp),
    essential: false,
    defaultEnabled: false,
    kind: 'user',
    of: (ext) => markBoundary(handle, ext),
  }
  return handle
}

/** Disabled-shell variant. Same factory: all metadata is block-local,
 *  so no module compilation is needed. */
export function userExtensionShellToggle(block: BlockData): Togglable {
  return userExtensionToggle(block)
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
