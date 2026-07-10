import {
  compileForVerification,
  hashExtensionSource,
  loadApprovedExtension,
  readApproval,
  type CompileCache,
  type ExtensionModule,
} from '@/extensions/compileExtensionModule.js'
import type {CompiledModuleCache} from '@/extensions/compiledModuleCache.js'
import {
  AppExtension,
  FacetContribution,
  isFacetContribution,
} from '@/facets/facet.js'
import {
  attachBoundary,
  getBoundary,
  isEnabled,
  type Overrides,
} from '@/facets/togglable.js'
import {
  extensionDisplayName,
  userExtensionShellToggle,
  userExtensionToggle,
} from '@/extensions/extensionToggles.js'
import { Repo } from '../data/repo'
import { BlockData } from '@/types.js'

export interface ExtensionLoadErrorReporter {
  (blockId: string, error: Error): void
}

/** Device-local trust status for a block the user has enabled (intent =
 *  true) whose code is NOT currently running as-authored. Surfaced to the
 *  settings UI AND the global prompt surface (toast + status chip) so the
 *  user can act:
 *    - `needs-approval`: enabled (here or on another device) but never
 *      approved on THIS device → "Enable here" reviews + approves the live
 *      source. Nothing runs until then.
 *    - `update-available`: approved, but the live source has drifted from
 *      the approved pin → the pinned version keeps running; "Update"
 *      re-approves the live source.
 *
 *  `name` is the block's display label (from block properties, no compile) —
 *  carried on the status so a surface that only has the blockId (the global
 *  toast) can name the extension without re-walking the toggle tree. */
export type ExtensionApprovalStatus =
  | {kind: 'needs-approval'; name: string; liveHash: string}
  | {kind: 'update-available'; name: string; liveHash: string; approvedHash: string}

export interface ExtensionApprovalStatusReporter {
  (blockId: string, status: ExtensionApprovalStatus): void
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
  /** Reports the device-local trust status of enabled blocks that aren't
   *  running as-authored (needs-approval / update-available) so the
   *  settings UI can offer the right action. */
  approvalStatusReporter?: ExtensionApprovalStatusReporter
  // Optional in-memory cache override for tests. Production uses the
  // module-wide singleton in compileExtensionModule.ts.
  cache?: CompileCache
  /** Device-local approval store (the trust gate). Defaults to the process
   *  singleton; tests inject an in-memory instance they pre-seed. */
  persistent?: CompiledModuleCache
  /** Verification mode (agent install `--verify`): compile the LIVE source
   *  directly and SKIP the device-local approval gate, so a brand-new
   *  block can be resolved in isolation before any approval exists. Never
   *  set on the user-facing load path. */
  verifyLiveSource?: boolean
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
   *   - Display metadata comes from extension block properties, not
   *     executable module code. That keeps settings rows descriptive
   *     even when a block is disabled and intentionally not compiled.
 *
 * Provenance: every contribution emitted from a block has its `source`
 * field force-prefixed with `block:<id>`. If the author supplied a
 * source, it becomes `block:<id>/<author-source>`. This makes the
 * agent-bridge `describeRuntime` payload show contribution origin
 * unambiguously.
 *
 * Two-gate enable model (issue #67):
 *   - Gate 1 — intent: the synced `overrides` map. A block the user hasn't
 *     enabled (or any block in safe mode) is skipped without compiling, so
 *     its top-level module code never runs.
 *   - Gate 2 — device-local trust: even when intent is true, a block runs
 *     only if THIS device holds an approval record, and it runs the
 *     approval's PINNED output — never the live `block.content`. So a
 *     source change synced from elsewhere can't silently execute new code:
 *       · no approval here → emit a shell + report `needs-approval`
 *         ("Enable here" reviews + approves the live source).
 *       · live source drifted from the pin → keep running the pinned
 *         version + report `update-available` ("Update" re-approves).
 *
 * Toggle integration: each running extension is wrapped in a
 * `userExtensionToggle(block)` boundary so the runtime resolver can
 * disable it without re-loading. Skipped / not-approved / broken blocks
 * emit `userExtensionShellToggle(block).of([])` so the row still appears
 * in the settings tree and stays user-recoverable.
 *
 * Failure isolation: a block whose source fails to compile or whose
 * default export is shaped wrong is reported via `errorReporter` and
 * replaced with a shell — other extensions still load.
 */
export const dynamicExtensionsExtension = (
  options: DynamicExtensionsOptions,
): AppExtension => async () => {
  const {
    repo,
    workspaceId,
    safeMode,
    overrides,
    errorReporter,
    approvalStatusReporter,
    cache,
    persistent,
    verifyLiveSource,
  } = options
  const effectiveOverrides: Overrides = overrides ?? new Map()

  // Gate 2 — device-local trust. Returns the runnable module, or null when
  // the block is enabled-by-intent but not currently runnable on this
  // device (no approval). Reports the status so the settings UI can offer
  // "Enable here" / "Update". In verify mode the approval gate is bypassed
  // and the LIVE source is compiled directly (isolated verification only).
  const resolveBlockModule = async (
    block: BlockData,
  ): Promise<ExtensionModule | null> => {
    if (verifyLiveSource) {
      return (await compileForVerification(block.content, block.id, cache)).module
    }
    const approval = await readApproval(block.id, persistent)
    if (!approval) {
      approvalStatusReporter?.(block.id, {
        kind: 'needs-approval',
        name: extensionDisplayName(block),
        liveHash: await hashExtensionSource(block.content),
      })
      return null
    }
    const liveHash = await hashExtensionSource(block.content)
    if (liveHash !== approval.sourceHash) {
      approvalStatusReporter?.(block.id, {
        kind: 'update-available',
        name: extensionDisplayName(block),
        liveHash,
        approvedHash: approval.sourceHash,
      })
    }
    // Run the PINNED approved output — never the (possibly drifted) live
    // content. This is the #67 guarantee: a synced source change can't
    // execute here until it's explicitly re-approved on this device.
    return (await loadApprovedExtension(block.id, approval, cache, persistent)).module
  }

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
    // and `defaultEnabled` is always false, so an enabled state requires
    // an explicit `true` in the overrides map. This check is what makes
    // the toggle meaningful: if we didn't skip here, the block's
    // top-level module code would still execute before the user opted in.
    //
    // Safe mode skips the compile for every block, regardless of the
    // override state. Why this matters: the user typically lands in
    // `?safeMode` to recover from a broken extension, and the Extensions
    // settings UI is the recovery surface. Returning [] here
    // (the pre-fix behavior) would hide every extension row from the
    // toggle tree, leaving the broken extension unreachable for
    // disabling. Emitting shells makes the rows appear without running
    // any extension's top-level module code.
    const shell = userExtensionShellToggle(block)
    // Gate 1 — intent: skip blocks the user hasn't asked to enable (and
    // every block in safe mode). Their top-level module code never runs.
    if (safeMode || !isEnabled(shell, effectiveOverrides)) {
      collected.push(shell.of([]))
      continue
    }

    // Gate 2 + compile + validate are per-block-fallible; any failure (and
    // the not-approved-here case) should still emit a shell so the row
    // appears in settings and the user can act. Errors continue to flow
    // through ExtensionLoadErrorStore for status-icon rendering at the row.
    try {
      const module = await resolveBlockModule(block)
      if (module === null) {
        // Enabled by intent but not approved-and-runnable here — the status
        // reporter has the detail (needs-approval). Emit a shell so the row
        // still appears with its "Enable here" affordance.
        collected.push(shell.of([]))
        continue
      }
      const exported = module.default as AppExtension
      const handle = userExtensionToggle(block)
      const validated = validateAndPrefix(handle.of(exported), block.id)
      collected.push(validated ?? shell.of([]))
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error))
      errorReporter?.(block.id, wrapped)
      console.error(`Failed to load extension block ${block.id}`, wrapped)
      collected.push(shell.of([]))
    }
  }

  return collected
}

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

/** Prefix the contribution's `source` with `block:<id>` (composing
 *  with any author-supplied source) AND recurse into `enables` so
 *  dragged-along contributions get the same provenance treatment as
 *  the top-level export. Without the `enables` recursion, a nested
 *  contribution would bypass validateAndPrefix entirely — keeping its
 *  original source string and skipping any per-contribution
 *  validation. The resolver itself walks `enables`, so production
 *  would happily register an attributed-to-nobody contribution. */
const prefixContributionSource = (
  contribution: FacetContribution<unknown>,
  blockId: string,
): FacetContribution<unknown> => {
  const blockSource = `block:${blockId}`
  const composed = contribution.source
    ? `${blockSource}/${contribution.source}`
    : blockSource
  const result: FacetContribution<unknown> = {...contribution, source: composed}
  if (contribution.enables !== undefined) {
    result.enables = validateAndPrefix(contribution.enables, blockId)
  }
  return result
}

const describeShape = (value: unknown): string => {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}
