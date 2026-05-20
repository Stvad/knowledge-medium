// Design sketch for the runtime plugin enable/disable system.
//
// Companion to design.html. The prose describes; this file specifies.
// The intent is that the typechecker — not a human reviewer — rejects
// drift between the design pieces.
//
// Not a build artifact. Function bodies are skeletons; types reference
// real codebase paths so renames in src/ break this file too.
//
// Typecheck with:
//   yarn tsc --noEmit --project docs/plugin-runtime-toggle/tsconfig.json

import type {AppExtension, FacetContribution} from '@/extensions/facet'
import type {BlockData} from '@/data/api/blockData'
import {aliasesProp} from '@/data/internals/coreProperties'

// ──────────────────────────────────────────────────────────────────────
// 1. The Togglable primitive
//
//   Identity for a user-visible toggle. Carrying the handle on the
//   boundary (rather than only an id) is what lets the filter/discovery
//   walks evaluate `isEnabled(handle, overrides)` without a parallel
//   registry of handles.
// ──────────────────────────────────────────────────────────────────────

export interface Togglable {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly essential?: boolean
  /** undefined ≡ true. Honoured for system plugins; forced true for
   *  user extensions (see UserExtensionToggle).  */
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

export function getBoundary(node: unknown): Togglable | undefined {
  if (!node || typeof node !== 'object') return undefined
  return (node as BoundaryArray)[BOUNDARY]
}

function unwrapBoundary(node: AppExtension): AppExtension {
  // markBoundary always produces [inner]. Defensive: if the shape has
  // drifted we return as-is rather than corrupt the contribution tree.
  if (Array.isArray(node) && node.length === 1) return node[0] as AppExtension
  return node
}

// ──────────────────────────────────────────────────────────────────────
// 2. Constrained factories
//
//   Two factories, deliberately not one. System plugins live in code
//   and can express any field. User extensions live in blocks: their
//   id is forced to block.id (so the pre-compile skip is consistent
//   with post-compile identity), and their defaultEnabled is forced to
//   true (we cannot honour `false` without compiling, which defeats
//   the pre-compile skip). Authors get name + description hints only.
//
//   The asymmetry lives in the type system here, not in prose rules.
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
    ...opts,
    of: (ext) => markBoundary(handle, ext),
  }
  return handle
}

export interface UserExtensionAuthorHints {
  /** Display name. Used post-compile only — never available at
   *  pre-compile shell time, since reading it requires running the
   *  module. */
  readonly name?: string
  readonly description?: string
}

/** Resolve a name from block-level data only (no module compilation).
 *  Used for the disabled-shell case AND as the fallback when an
 *  enabled extension didn't wrap its export. */
function blockOnlyName(block: BlockData): string {
  const encoded = block.properties[aliasesProp.name]
  if (encoded !== undefined) {
    const aliases = aliasesProp.codec.decode(encoded)
    if (aliases.length > 0) return aliases[0]
  }
  // The settings UI renders this string as a link to the block.
  return `Extension ${block.id.slice(0, 8)}`
}

export function userExtensionToggle(
  block: BlockData,
  authoredHints?: UserExtensionAuthorHints,
): Togglable {
  const handle: Togglable = {
    id: block.id,                                // canonical, always
    name: authoredHints?.name ?? blockOnlyName(block),
    description: authoredHints?.description,
    essential: false,
    defaultEnabled: true,                        // see Togglable doc
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
// 3. Overrides & the enabled-state computation
// ──────────────────────────────────────────────────────────────────────

export type Overrides = ReadonlyMap<string, boolean>

export function isEnabled(handle: Togglable, overrides: Overrides): boolean {
  if (handle.essential) return true
  const override = overrides.get(handle.id)
  if (override !== undefined) return override
  return handle.defaultEnabled ?? true
}

/** UI-side toggle convention. Returns the new overrides map after the
 *  click. Comparing against `defaultEnabled ?? true` keeps overrides
 *  free of entries that match the manifest default. */
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

// ──────────────────────────────────────────────────────────────────────
// 4. Collector — shared by sync and async resolution paths
//
//   `collectContributions` is the single piece both
//   resolveFacetRuntimeSync (AppRuntimeProvider.tsx:52) and the async
//   resolveFacetRuntime path (AppRuntimeProvider.tsx:92) call. Putting
//   the filter only in one path would diverge as soon as dynamic
//   extensions arrive — which is exactly when user-extension boundaries
//   start mattering.
// ──────────────────────────────────────────────────────────────────────

/** FacetContribution as it appears in the public type, plus an
 *  optional `enables` payload contributed by §4 of the design. */
type FacetContributionWithEnables = FacetContribution<unknown> & {
  enables?: AppExtension
}

function isFacetContribution(
  node: unknown,
): node is FacetContributionWithEnables {
  return (
    typeof node === 'object' &&
    node !== null &&
    (node as {type?: unknown}).type === 'facet-contribution'
  )
}

export function collectContributions(
  tree: AppExtension,
  options: {overrides: Overrides},
): readonly FacetContribution<unknown>[] {
  const seen = new Set<FacetContribution<unknown>>()
  const out: FacetContribution<unknown>[] = []
  walk(tree)
  return out

  function walk(node: AppExtension): void {
    if (!node) return
    if (typeof node === 'function') {
      // Dynamic resolvers should already be resolved upstream. If we
      // ever encounter one here, that's a contract violation worth
      // surfacing rather than silently flattening.
      throw new Error('collectContributions: unresolved function in tree')
    }
    if (Array.isArray(node)) {
      const handle = getBoundary(node)
      if (handle && !isEnabled(handle, options.overrides)) return
      for (const inner of node) walk(inner)
      return
    }
    if (isFacetContribution(node)) {
      if (!seen.has(node)) {
        seen.add(node)
        out.push(node)
      }
      if (node.enables) walk(node.enables)
      return
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// 5. Tree discovery for the settings UI
//
//   Same shape as the collector walk minus the filter. Crucially,
//   recurses into FacetContribution.enables — without that branch a
//   nested togglable introduced via `enables` would never show up in
//   the settings tree.
// ──────────────────────────────────────────────────────────────────────

export interface ToggleNode {
  handle: Togglable
  children: ToggleNode[]
}

export function discoverToggleTree(tree: AppExtension): ToggleNode[] {
  const roots: ToggleNode[] = []
  walk(tree, roots)
  return roots

  function walk(node: AppExtension, sink: ToggleNode[]): void {
    if (!node) return
    if (typeof node === 'function') return
    if (Array.isArray(node)) {
      const handle = getBoundary(node)
      if (handle) {
        const child: ToggleNode = {handle, children: []}
        sink.push(child)
        for (const inner of node) walk(inner, child.children)
      } else {
        for (const inner of node) walk(inner, sink)
      }
      return
    }
    if (isFacetContribution(node) && node.enables) walk(node.enables, sink)
  }
}

// ──────────────────────────────────────────────────────────────────────
// 6. Dynamic extension loader (the shape, not the implementation)
//
//   Demonstrates the integration with compileExtensionModule + the
//   pre-compile skip. The author's wrapping (if any) is unwrapped for
//   name/description hints; the platform always re-wraps with a
//   userExtensionToggle whose identity is block.id.
// ──────────────────────────────────────────────────────────────────────

interface CompiledModule {
  module: {default: AppExtension}
}

declare function compileExtensionModule(
  content: string,
  blockId: string,
): Promise<CompiledModule>

declare function validateAndPrefix(
  ext: AppExtension,
  blockId: string,
): AppExtension | null

export async function loadDynamicExtensions(
  blocks: readonly BlockData[],
  overrides: Overrides,
): Promise<AppExtension[]> {
  const collected: AppExtension[] = []

  for (const block of blocks) {
    // Pre-compile skip — possible because user-extension identity is
    // forced to block.id. An author-chosen id would not work here.
    if (overrides.get(block.id) === false) {
      collected.push(userExtensionShellToggle(block).of([]))
      continue
    }

    let exported: AppExtension
    try {
      const compiled = await compileExtensionModule(block.content, block.id)
      exported = compiled.module.default
    } catch {
      continue
    }

    // Take name/description hints from any author togglable; discard
    // their id/defaultEnabled/essential. unwrapBoundary peels one layer.
    const authoredBoundary = getBoundary(exported)
    const inner = authoredBoundary ? unwrapBoundary(exported) : exported
    const authoredHints: UserExtensionAuthorHints | undefined =
      authoredBoundary
        ? {
            name: authoredBoundary.name,
            description: authoredBoundary.description,
          }
        : undefined

    const handle = userExtensionToggle(block, authoredHints)
    const wrapped = handle.of(inner)
    const validated = validateAndPrefix(wrapped, block.id)
    if (validated) collected.push(validated)
  }

  return collected
}

// ──────────────────────────────────────────────────────────────────────
// 7. validateAndPrefix — BOUNDARY-preservation fix
//
//   The existing implementation at dynamicExtensions.ts:111 calls
//   extension.map(...) for arrays, which builds a fresh array — the
//   non-enumerable BOUNDARY symbol on the togglable wrapper is silently
//   dropped. Without this fix, dynamic extension toggles disappear
//   after normalisation. The sketch shape:
// ──────────────────────────────────────────────────────────────────────

export function validateAndPrefixSketch(
  ext: AppExtension,
  blockId: string,
): AppExtension {
  if (ext === null || ext === undefined || ext === false) return null as never
  if (Array.isArray(ext)) {
    const mapped = ext.map((child) => validateAndPrefixSketch(child, blockId))
    const boundary = getBoundary(ext)
    if (boundary) {
      Object.defineProperty(mapped, BOUNDARY, {
        value: boundary,
        enumerable: false,
      })
    }
    return mapped
  }
  // Function and FacetContribution branches — omitted in sketch; the
  // shipping implementation also needs to recurse into
  // contribution.enables, see §4 of the design doc.
  return ext
}
