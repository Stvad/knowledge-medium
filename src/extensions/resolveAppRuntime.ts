/**
 * Boundary-aware FacetRuntime resolver.
 *
 * Wraps the existing facet collector pattern (see `facet.ts:259/287`)
 * with two behaviours the bare collectors don't have:
 *
 *   1. `getBoundary(node)` on an array → look up `isEnabled(handle,
 *      overrides)`; skip the whole subtree when the toggle resolves
 *      to off. Essentials are forced on; non-essentials honour the
 *      overrides map, falling back to `defaultEnabled ?? true`.
 *
 *   2. Recurse into `FacetContribution.enables` (a slice-7 field on
 *      `FacetContributionOptions`) only when the parent contribution
 *      itself passed validation — dragged-along extensions exist to
 *      support their parent and are dropped when the parent is.
 *
 * Both behaviours apply identically across the sync and async walks
 * (mirroring the facet.ts pair). The async walk additionally awaits
 * function-valued AppExtensions; the sync walk throws on them, matching
 * the existing `collectContributionsSync` policy.
 *
 * facet.ts has no awareness of `@/extensions/togglable.ts`; this module
 * is the only place the two meet. Anyone calling `resolveFacetRuntime`
 * directly still gets the bare behaviour — which is fine for the unit
 * tests that don't care about toggle semantics. Production wiring goes
 * through `resolveAppRuntime` / `resolveAppRuntimeSync` here.
 */

import {
  FacetRuntime,
  type AppExtension,
  type FacetContribution,
  type FacetResolveContext,
} from '@/extensions/facet.ts'
import {
  getBoundary,
  isEnabled,
  type Overrides,
} from '@/extensions/togglable.ts'

export interface ResolveAppRuntimeOptions {
  overrides: Overrides
  context?: FacetResolveContext
}

/** Build a FacetRuntime from an AppExtension tree, evaluating toggle
 *  boundaries with the supplied overrides. Async — awaits any
 *  function-valued nodes (e.g. `dynamicExtensionsExtension`). */
export async function resolveAppRuntime(
  extensions: AppExtension | readonly AppExtension[],
  options: ResolveAppRuntimeOptions,
): Promise<FacetRuntime> {
  const context = options.context ?? {}
  const collected: FacetContribution<unknown>[] = []
  const seen = new Set<FacetContribution<unknown>>()
  await walk(extensions, options.overrides, context, collected, seen)
  return new FacetRuntime(context, collected)
}

/** Sync variant. Throws if a function-valued AppExtension is reached,
 *  matching `collectContributionsSync` in facet.ts:300. The static
 *  extension tree contains no functions today; `AppRuntimeProvider`
 *  relies on that for first-paint resolution before React can await. */
export function resolveAppRuntimeSync(
  extensions: AppExtension | readonly AppExtension[],
  options: ResolveAppRuntimeOptions,
): FacetRuntime {
  const context = options.context ?? {}
  const collected: FacetContribution<unknown>[] = []
  const seen = new Set<FacetContribution<unknown>>()
  walkSync(extensions, options.overrides, collected, seen)
  return new FacetRuntime(context, collected)
}

// ──────────────────────────────────────────────────────────────────────
// Walk implementations
// ──────────────────────────────────────────────────────────────────────

/** Validation step mirrors `pushValidatedContribution` in facet.ts:243.
 *  Returns whether the contribution was accepted so the walk knows
 *  whether to recurse into its `enables`. */
function pushValidatedContribution(
  contribution: FacetContribution<unknown>,
  output: FacetContribution<unknown>[],
): boolean {
  const validate = contribution.facet.validate
  if (validate && !validate(contribution.value)) {
    console.error(
      `Dropping invalid contribution for facet "${contribution.facet.id}"`,
      {source: contribution.source, value: contribution.value},
    )
    return false
  }
  output.push(contribution)
  return true
}

type FacetContributionWithEnables = FacetContribution<unknown> & {
  enables?: AppExtension | readonly AppExtension[]
}

const isFacetContribution = (
  value: unknown,
): value is FacetContributionWithEnables =>
  typeof value === 'object' &&
  value !== null &&
  (value as {type?: unknown}).type === 'facet-contribution'

async function walk(
  node: AppExtension | readonly AppExtension[],
  overrides: Overrides,
  context: FacetResolveContext,
  output: FacetContribution<unknown>[],
  seen: Set<FacetContribution<unknown>>,
): Promise<void> {
  if (!node) return

  if (typeof node === 'function') {
    try {
      await walk(await node(context), overrides, context, output, seen)
    } catch (error) {
      console.error('Failed to resolve app extension', error)
    }
    return
  }

  if (Array.isArray(node)) {
    const handle = getBoundary(node)
    if (handle && !isEnabled(handle, overrides)) return
    for (const child of node) {
      await walk(child as AppExtension, overrides, context, output, seen)
    }
    return
  }

  if (isFacetContribution(node)) {
    if (seen.has(node)) return
    seen.add(node)
    const accepted = pushValidatedContribution(node, output)
    if (accepted && node.enables) {
      await walk(node.enables, overrides, context, output, seen)
    }
  }
}

function walkSync(
  node: AppExtension | readonly AppExtension[],
  overrides: Overrides,
  output: FacetContribution<unknown>[],
  seen: Set<FacetContribution<unknown>>,
): void {
  if (!node) return

  if (typeof node === 'function') {
    throw new Error(
      'resolveAppRuntimeSync: cannot resolve function-valued AppExtension. ' +
      'Use resolveAppRuntime (async) for trees that contain dynamic extensions.',
    )
  }

  if (Array.isArray(node)) {
    const handle = getBoundary(node)
    if (handle && !isEnabled(handle, overrides)) return
    for (const child of node) {
      walkSync(child as AppExtension, overrides, output, seen)
    }
    return
  }

  if (isFacetContribution(node)) {
    if (seen.has(node)) return
    seen.add(node)
    const accepted = pushValidatedContribution(node, output)
    if (accepted && node.enables) walkSync(node.enables, overrides, output, seen)
  }
}
