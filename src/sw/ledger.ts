/**
 * Pure decisions over the generation ledger — an install-ordered list of
 * BUILD_IDs (newest last). The worker (src/sw/worker.ts) owns the impure I/O
 * (reading/writing the ledger Response in the meta cache); the retention math
 * lives here so it unit-tests without a cache.
 *
 * Each deploy is an immutable generation with its own km-shell-<id> /
 * km-assets-<id> caches. On activate we keep the most recent `keep`
 * generations (so a tab still on a prior build has a consistent cache to read
 * from) and GC the rest.
 */
import {PREVIEW_SUBTREE} from './preview'

/** The ids to KEEP: the most recent `keep`, newest-last order preserved. */
export const computeKeepIds = (ledger: string[], keep: number): string[] =>
  ledger.slice(Math.max(0, ledger.length - keep))

/**
 * The ids that have aged out of the keep-window and whose caches should be
 * GC'd. Disjoint from computeKeepIds; empty when the ledger fits the window.
 */
export const computeExpiredIds = (ledger: string[], keep: number): string[] =>
  ledger.slice(0, Math.max(0, ledger.length - keep))

export interface LedgerEntry {
  ids: string[]
  /** epoch ms of the last write; undefined for a legacy bare-array ledger. */
  updatedAt: number | undefined
  /**
   * Legacy preview DB filenames from an earlier PR implementation. New preview
   * DB records are independent meta-cache keys so generation-ledger writes can't
   * clobber them, but normalization keeps this readable until old local state is
   * swept.
   */
  databaseNames: string[]
}

/**
 * Normalize a stored ledger value into {ids, updatedAt}. Tolerates the two
 * on-disk shapes: the current {ids, updatedAt} object and the LEGACY bare array
 * (written before timestamps existed) — the latter has no timestamp, which the
 * sweeper reads as "staleness unprovable → never reap". Anything else (null,
 * garbage, non-array ids) degrades to an empty ledger.
 */
export const normalizeLedger = (raw: unknown): LedgerEntry => {
  if (Array.isArray(raw)) return {ids: raw, updatedAt: undefined, databaseNames: []}
  if (raw && typeof raw === 'object' && Array.isArray((raw as {ids?: unknown}).ids)) {
    const {ids, updatedAt, databaseNames} = raw as {
      ids: string[]
      updatedAt?: unknown
      databaseNames?: unknown
    }
    return {
      ids,
      updatedAt: typeof updatedAt === 'number' ? updatedAt : undefined,
      databaseNames: Array.isArray(databaseNames)
        ? databaseNames.filter((name): name is string => typeof name === 'string')
        : [],
    }
  }
  return {ids: [], updatedAt: undefined, databaseNames: []}
}

/** One scope's ledger, tagged with the ledger-entry key URL it was read from. */
export interface ScopeLedger extends LedgerEntry {
  /** The meta-cache key the entry lives under (…/<scope>/__km_generations__). */
  scopeUrl: string
}

export interface ReapPlan {
  /** km-shell-<id> / km-assets-<id> cache names to delete. */
  cacheNames: string[]
  /** meta-cache ledger keys (scopeUrl) to delete. */
  ledgerScopeUrls: string[]
}

/**
 * Decide which OTHER-scope generation caches a sweep should reclaim. Cache
 * Storage is shared per-origin, so a client accumulates the caches of every PR
 * preview it ever visited; once a PR is merged/closed its preview SW never runs
 * again to GC them, so they leak forever. This sweep (run from any active SW's
 * activate) reclaims them — but ONLY:
 *   - preview scopes (PREVIEW_SUBTREE matches the ledger key's path). Production
 *     is NEVER a preview scope, so it can never be reaped here — the sweep is
 *     structurally incapable of touching prod caches.
 *   - that are STALE: a numeric updatedAt older than staleMs. A legacy
 *     untimestamped ledger (updatedAt undefined) is never reaped — we can't
 *     prove it's abandoned. The current scope's own ledger was just re-stamped
 *     on install, so it's fresh and self-excluded.
 * A generation id still referenced by any KEPT (non-reaped) ledger is spared —
 * two deploys can in principle share a build sha, and we must not delete a cache
 * a live scope depends on. The stale ledger ENTRY is removed regardless (the
 * scope is gone), even when its cache was shared-protected.
 */
export const computeReapableCaches = ({
  ledgers,
  now,
  staleMs,
  cachePrefix,
  selfScopeUrl,
}: {
  ledgers: ScopeLedger[]
  now: number
  staleMs: number
  cachePrefix: string
  /**
   * The sweeping SW's OWN ledger key — never reaped (defensive: at runtime its
   * ledger was just re-stamped on install so it can't be stale, but excluding
   * it explicitly means the sweep can never delete the caches out from under
   * the page that's running it). Its ids still count as "kept".
   */
  selfScopeUrl?: string
}): ReapPlan => {
  const isPreviewScope = (scopeUrl: string) => {
    try {
      return PREVIEW_SUBTREE.test(new URL(scopeUrl).pathname)
    } catch {
      return false
    }
  }
  const isStale = (l: ScopeLedger) =>
    typeof l.updatedAt === 'number' && now - l.updatedAt > staleMs

  const reapable = ledgers.filter(
    (l) => l.scopeUrl !== selfScopeUrl && isPreviewScope(l.scopeUrl) && isStale(l),
  )
  const reapableSet = new Set(reapable)
  // Ids any surviving scope still depends on — never delete their caches.
  const keptIds = new Set(ledgers.filter((l) => !reapableSet.has(l)).flatMap((l) => l.ids))

  const reapIds = new Set<string>()
  for (const l of reapable) {
    for (const id of l.ids) if (!keptIds.has(id)) reapIds.add(id)
  }

  return {
    cacheNames: [...reapIds].flatMap((id) => [`${cachePrefix}shell-${id}`, `${cachePrefix}assets-${id}`]),
    ledgerScopeUrls: reapable.map((l) => l.scopeUrl),
  }
}
