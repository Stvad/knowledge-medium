import {
  compileExtensionModule,
  type CompileCache,
} from '@/extensions/compileExtensionModule.ts'
import {
  AppExtension,
  FacetContribution,
} from '@/extensions/facet.ts'
import {
  attachBoundary,
  getAuthorHints,
  getBoundary,
  isEnabled,
  unwrapAuthorHints,
  userExtensionShellToggle,
  userExtensionToggle,
  type Overrides,
} from '@/extensions/togglable.ts'
import { Repo } from '../data/repo'
import { BlockData } from '@/types.ts'

export interface ExtensionLoadErrorReporter {
  (blockId: string, error: Error): void
}

export interface DynamicExtensionsOptions {
  repo: Repo
  workspaceId: string
  safeMode: boolean
  /** Runtime-toggle overrides. The loader uses this to skip disabled
   *  blocks *before* compiling (so a disabled extension's top-level
   *  module code never runs) and to tag enabled extensions with the
   *  right togglable boundary so the resolver can flip them at runtime
   *  without rebuilding the dynamic subtree. Defaults to an empty
   *  map — every block resolves to "enabled" (since
   *  `userExtensionToggle` forces `defaultEnabled: true`). */
  overrides?: Overrides
  errorReporter?: ExtensionLoadErrorReporter
  // Optional override for tests. Production uses the module-wide
  // singleton in compileExtensionModule.ts.
  cache?: CompileCache
}

/**
 * Walks the workspace for blocks of `type: 'extension'`, compiles each,
 * and returns their default exports as a single AppExtension subtree.
 *
 * Block-author authorship contract:
 *   - The block is TS/JSX. It runs through Babel (react + typescript
 *     presets) and is loaded as an ESM module via blob URL.
 *   - `module.default` must be a valid AppExtension:
 *     a FacetContribution, an array of AppExtension, an async/sync
 *     function returning AppExtension, or nullish/false.
 *   - Imports work through the page-global importmap. `import { x }
 *     from '@/extensions/api.js'` returns the *same* module instance
 *     the running app uses, so contribution facets match by identity.
 *   - Optional `authorHints({name, description}, ext)` wrapper provides
 *     a display name + description for the toggle row in settings.
 *     Platform-owned identity (block.id, defaultEnabled) is forced by
 *     the loader and cannot be overridden by the author.
 *
 * Provenance: every contribution emitted from a block has its `source`
 * field force-prefixed with `block:<id>`. If the author supplied a
 * source, it becomes `block:<id>/<author-source>`. This makes the
 * agent-bridge `describeRuntime` payload show contribution origin
 * unambiguously.
 *
 * Toggle integration: each enabled extension is wrapped in a
 * `userExtensionToggle(block, hints)` boundary so the runtime resolver
 * can disable it without re-loading. Disabled blocks are NOT compiled
 * (their top-level module code never runs) — instead the loader emits
 * a `userExtensionShellToggle(block).of([])` so the row still appears
 * in the settings tree. Compile / hint-unwrap / validate failures
 * also emit a shell so a broken extension stays user-recoverable.
 *
 * Failure isolation: a block whose source fails to compile or whose
 * default export is shaped wrong is reported via `errorReporter` and
 * replaced with a shell — other extensions still load.
 */
export const dynamicExtensionsExtension = (
  options: DynamicExtensionsOptions,
): AppExtension => async () => {
  const {repo, workspaceId, safeMode, overrides, errorReporter, cache} = options
  const effectiveOverrides: Overrides = overrides ?? new Map()

  let extensionBlocks: BlockData[]
  try {
    extensionBlocks = await repo.query.findExtensionBlocks({workspaceId}).load()
  } catch (error) {
    console.error('Failed to query extension blocks', error)
    return []
  }

  const collected: AppExtension[] = []

  for (const block of extensionBlocks) {
    // Pre-compile skip — `userExtensionToggle.id` is always `block.id`
    // and `defaultEnabled` is always true, so a disabled state requires
    // an explicit `false` in the overrides map. This check is what
    // makes the toggle meaningful: if we didn't skip here, the block's
    // top-level module code would still execute every reload.
    //
    // Safe mode skips the compile for every block, regardless of the
    // override state. Why this matters: the user typically lands in
    // `?safeMode` to recover from a broken extension, and the System
    // plugins settings UI is the recovery surface. Returning [] here
    // (the pre-fix behavior) would hide every extension row from the
    // toggle tree, leaving the broken extension unreachable for
    // disabling. Emitting shells makes the rows appear without running
    // any extension's top-level module code.
    const shell = userExtensionShellToggle(block)
    if (safeMode || !isEnabled(shell, effectiveOverrides)) {
      collected.push(shell.of([]))
      continue
    }

    // Compile + hint unwrap + validate are all per-block-fallible; any
    // failure should still emit a shell so the row appears in settings
    // and the user can disable the broken extension. Errors continue
    // to flow through ExtensionLoadErrorStore for status-icon
    // rendering at the row.
    try {
      const {module} = await compileExtensionModule(block.content, block.id, cache)
      const exported = module.default as AppExtension
      const hints = getAuthorHints(exported)
      const inner = hints ? unwrapAuthorHints(exported) : exported
      const handle = userExtensionToggle(block, hints)
      const wrapped = handle.of(inner)
      const validated = validateAndPrefix(wrapped, block.id)
      if (validated !== null) {
        collected.push(validated)
      } else {
        collected.push(shell.of([]))
      }
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error))
      errorReporter?.(block.id, wrapped)
      console.error(`Failed to load extension block ${block.id}`, wrapped)
      collected.push(shell.of([]))
    }
  }

  return collected
}

const isFacetContribution = (value: unknown): value is FacetContribution<unknown> =>
  typeof value === 'object' &&
  value !== null &&
  (value as {type?: unknown}).type === 'facet-contribution'

/**
 * Walks an AppExtension tree, validates shape, and force-prefixes every
 * FacetContribution's `source`.
 *
 * Returns a normalized AppExtension on success; throws on shape errors so
 * the caller can attribute them to the offending block.
 *
 * **Boundary preservation:** when the input array carries a togglable
 * BOUNDARY symbol (attached by `userExtensionToggle(block).of(...)`),
 * the freshly-mapped array also gets the symbol. Without this,
 * `.map()` would drop the marker, leaving the dynamic subtree
 * untoggleable by the resolver — every disable would no-op.
 */
const validateAndPrefix = (
  extension: AppExtension,
  blockId: string,
): AppExtension => {
  if (extension === null || extension === undefined || extension === false) {
    return null
  }

  if (Array.isArray(extension)) {
    const mapped = extension.map((child) => validateAndPrefix(child, blockId))
    const boundary = getBoundary(extension)
    if (boundary) attachBoundary(mapped, boundary)
    return mapped
  }

  if (typeof extension === 'function') {
    // Wrap so the function's return value also gets prefixed.
    return async (context) => {
      const inner = await (extension as (
        ctx: typeof context,
      ) => AppExtension | Promise<AppExtension>)(context)
      return validateAndPrefix(inner, blockId)
    }
  }

  if (isFacetContribution(extension)) {
    return prefixContributionSource(extension, blockId)
  }

  throw new Error(
    `Extension default export has invalid shape: ${describeShape(extension)}. ` +
    `Expected a FacetContribution, an array of AppExtension, a function returning AppExtension, ` +
    `or null/undefined/false.`,
  )
}

const prefixContributionSource = (
  contribution: FacetContribution<unknown>,
  blockId: string,
): FacetContribution<unknown> => {
  const blockSource = `block:${blockId}`
  const composed = contribution.source
    ? `${blockSource}/${contribution.source}`
    : blockSource
  return {...contribution, source: composed}
}

const describeShape = (value: unknown): string => {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}
