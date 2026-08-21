/**
 * Live health of the contributed search sources, as a diagnostics snapshot.
 *
 * The failure this exists for is silent: when one `searchSourcesFacet` source
 * throws and another succeeds, `searchBlocksAcrossSources` logs, drops that
 * source's results and returns the rest — so search quietly gets worse and
 * nothing tells the user. (A TOTAL failure is different: the merge point
 * rethrows, and the caller surfaces it already.) Core emits
 * `SearchSourceHealthEvent`s and this plugin decides what a human sees.
 *
 * `core.content` is deliberately not special-cased. It reports through the
 * same seam as any plugin source, so if it ever starts failing alongside a
 * working plugin source, that shows up here too.
 */
import { CallbackSet } from '@/utils/callbackSet.js'
import type { SearchSourceHealthReport, SearchSourceOutcome } from '@/data/facets.js'
import type { DiagnosticSnapshot } from '@/plugins/diagnostics/facet.js'

let snapshot: DiagnosticSnapshot | null = null
let latestGeneration = 0
const listeners = new CallbackSet('search-health')

const describe = (outcome: SearchSourceOutcome): string =>
  outcome.kind === 'threw'
    ? `"${outcome.sourceId}" failed`
    : `"${outcome.sourceId}" returned a malformed result`

/** Derive the chip snapshot from every source's last outcome.
 *
 *  Severity is `warning`, never `error`: results are degraded, not wrong, and
 *  the user's own writes are unaffected. Reserving `error` for the states that
 *  redden the whole chip (sync broken, data inconsistent) keeps this from
 *  crying wolf over a flaky third-party index. */
const computeSnapshot = (outcomes: readonly SearchSourceOutcome[]): DiagnosticSnapshot | null => {
  const unhealthy = outcomes.filter(o => o.kind !== 'ok')
  if (unhealthy.length === 0) return null

  const summary = unhealthy.length === 1
    ? `Search source ${describe(unhealthy[0])}`
    : `${unhealthy.length} search sources are failing`
  const detail = unhealthy
    .map(o => (o.detail ? `${o.sourceId}: ${o.detail}` : `${o.sourceId}: search threw`))
    .join(' · ')
  return {
    severity: 'warning',
    summary: `${summary} — results may be incomplete`,
    detail,
    nudge: true,
  }
}

const sameSnapshot = (a: DiagnosticSnapshot | null, b: DiagnosticSnapshot | null): boolean => {
  if (a === b) return true
  if (!a || !b) return false
  return a.severity === b.severity && a.summary === b.summary && a.detail === b.detail
}

/** Replace the health state from one search's report.
 *
 *  Whole-set replace, not a merge: a source that has left the runtime is
 *  absent from `outcomes` and must stop being named, and it can never emit an
 *  `ok` of its own to say so. Reports older than the newest seen are dropped —
 *  overlapping searches settle out of order (a slow source under fast typing),
 *  and without this an older `threw` could land after a newer `ok` and leave a
 *  warning up once the user stops typing.
 *
 *  Runs on every search, so the unchanged case must not wake a subscriber or
 *  hand `useSyncExternalStore` a new reference. */
export const recordSearchSourceHealth = (report: SearchSourceHealthReport): void => {
  if (report.generation <= latestGeneration) return
  latestGeneration = report.generation
  const next = computeSnapshot(report.outcomes)
  if (sameSnapshot(snapshot, next)) return
  snapshot = next
  listeners.notify()
}

export const subscribeSearchSourceHealth = (listener: () => void): (() => void) =>
  listeners.add(listener)

export const searchSourceHealthSnapshot = (): DiagnosticSnapshot | null => snapshot

/** Test-only reset of the module store (mirrors `resetPersistenceStatus`). */
export const resetSearchSourceHealth = (): void => {
  snapshot = null
  latestGeneration = 0
  listeners.clear()
}
