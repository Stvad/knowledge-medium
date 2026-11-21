import { defineFacet, type FacetRuntime } from '@/facets/facet.js'
import { DEFAULT_NON_NAVIGABLE_SURFACES } from './walker.ts'

/** Contribute the `surfaceName` set in the block context.
 *  The shell decorator tags the block and the walker skips matching rows.
 *  Use {@link resolveSpatialNavExclusions} to read the effective exclusions. */
export const spatialNavExclusionsFacet = defineFacet<string, ReadonlySet<string>>({
  id: 'spatial-navigation.non-navigable-surfaces',
  combine: values => new Set(values),
  empty: () => new Set(),
  validate: (value): value is string => typeof value === 'string',
})

/**
 * Resolve the live excluded-surface set for walker calls. `runtime` is
 * `Block['repo']['facetRuntime']` — nullable at early-boot / in a minimal
 * test harness (mirrors `pickBlockDateAdapter`'s caller-supplied-runtime
 * shape, see `facetBridge.ts`'s doc comment on `facetRuntime`).
 *
 * Falls back to the walker's own default (`DEFAULT_NON_NAVIGABLE_SURFACES`)
 * both when `runtime` is null AND when the resolved set is empty. The empty
 * case matters because `Repo` installs a KERNEL-ONLY facet runtime by
 * default (`installKernelRuntime`, see `repo.ts`) — a non-null runtime that
 * simply doesn't carry the spatial-navigation plugin's contributions, e.g.
 * `createTestRepo()` harnesses or any tool wired to a partial runtime.
 * Without this fallback such a runtime would silently resolve to "exclude
 * nothing" — a behavior change from the pre-facet hardcoded Set.
 *
 * This treats an empty resolution as synonymous with "the spatial-navigation
 * plugin's boundary isn't loaded in this runtime" rather than "a
 * deliberately-empty exclusion set": the plugin contributes 'breadcrumb'
 * unconditionally whenever its actions are active (`index.ts`), so empty
 * only happens on a partial runtime — a real app runtime (or any runtime
 * where the walker's actual consumers, `actions.ts` / `PanelFocusRecovery.tsx`,
 * run) always carries at least that contribution. The tradeoff: a
 * hypothetical caller that wants a genuinely empty exclusion set can't
 * express that through this seam. Acceptable — no runtime the walker's
 * consumers execute in is ever both facet-backed by this plugin AND
 * legitimately empty.
 */
export const resolveSpatialNavExclusions = (
  runtime: FacetRuntime | null,
): ReadonlySet<string> => {
  if (!runtime) return DEFAULT_NON_NAVIGABLE_SURFACES
  const resolved = runtime.read(spatialNavExclusionsFacet)
  return resolved.size > 0 ? resolved : DEFAULT_NON_NAVIGABLE_SURFACES
}
