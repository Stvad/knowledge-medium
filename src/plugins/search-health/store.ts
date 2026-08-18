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
import type { SearchSourceHealthEvent } from '@/data/facets.js'
import type { DiagnosticSnapshot } from '@/plugins/diagnostics/facet.js'

interface SourceState {
  kind: SearchSourceHealthEvent['kind']
  detail?: string
}

const states = new Map<string, SourceState>()
let snapshot: DiagnosticSnapshot | null = null
const listeners = new CallbackSet('search-health')

const describe = (sourceId: string, state: SourceState): string =>
  state.kind === 'threw'
    ? `"${sourceId}" failed`
    : `"${sourceId}" returned a malformed result`

/** Derive the chip snapshot from every source's last outcome.
 *
 *  Severity is `warning`, never `error`: results are degraded, not wrong, and
 *  the user's own writes are unaffected. Reserving `error` for the states that
 *  redden the whole chip (sync broken, data inconsistent) keeps this from
 *  crying wolf over a flaky third-party index. */
const computeSnapshot = (): DiagnosticSnapshot | null => {
  const unhealthy = [...states.entries()].filter(([, s]) => s.kind !== 'ok')
  if (unhealthy.length === 0) return null

  const [firstId, firstState] = unhealthy[0]
  const summary = unhealthy.length === 1
    ? `Search source ${describe(firstId, firstState)}`
    : `${unhealthy.length} search sources are failing`
  const detail = unhealthy
    .map(([id, s]) => (s.detail ? `${id}: ${s.detail}` : `${id}: search threw`))
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

/** Record one source's outcome. Called on EVERY search (so, every keystroke),
 *  hence the early return: the common path is an unchanged `ok` and must not
 *  allocate a snapshot or wake a subscriber. */
export const recordSearchSourceHealth = (event: SearchSourceHealthEvent): void => {
  const previous = states.get(event.sourceId)
  if (previous?.kind === event.kind && previous.detail === event.detail) return
  states.set(event.sourceId, {kind: event.kind, detail: event.detail})
  const next = computeSnapshot()
  if (sameSnapshot(snapshot, next)) return
  snapshot = next
  listeners.notify()
}

export const subscribeSearchSourceHealth = (listener: () => void): (() => void) =>
  listeners.add(listener)

export const searchSourceHealthSnapshot = (): DiagnosticSnapshot | null => snapshot

/** Test-only reset of the module store (mirrors `resetPersistenceStatus`). */
export const resetSearchSourceHealth = (): void => {
  states.clear()
  snapshot = null
  listeners.clear()
}
