import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchSourceOutcome } from '@/data/facets.js'
import {
  recordSearchSourceHealth,
  resetSearchSourceHealth,
  searchSourceHealthSnapshot,
  subscribeSearchSourceHealth,
} from '../store.js'

let generation = 0
/** One search's report. Generation auto-increments, so a test only names it
 *  when it is deliberately exercising out-of-order delivery. */
const report = (outcomes: readonly SearchSourceOutcome[], at = ++generation) =>
  ({generation: at, outcomes})

describe('search-source health store', () => {
  beforeEach(() => {
    resetSearchSourceHealth()
    generation = 0
  })

  it('reports nothing while every source is healthy', () => {
    recordSearchSourceHealth(report([
      {sourceId: 'core.content', kind: 'ok'},
      {sourceId: 'semantic', kind: 'ok'},
    ]))
    expect(searchSourceHealthSnapshot()).toBeNull()
  })

  it('warns, naming the source, once one starts failing', () => {
    recordSearchSourceHealth(report([
      {sourceId: 'core.content', kind: 'ok'},
      {sourceId: 'semantic', kind: 'threw'},
    ]))
    const snapshot = searchSourceHealthSnapshot()
    expect(snapshot?.severity).toBe('warning')
    expect(snapshot?.summary).toContain('semantic')
    expect(snapshot?.summary).toContain('results may be incomplete')
  })

  // The two failures cost the user different things, so one fixed phrase is
  // wrong for one of them: a throwing source drops rows, while a malformed
  // candidate is still ranked and still shown — just with a payload whose age
  // nothing can establish.
  it('says stale, not incomplete, when nothing was dropped', () => {
    recordSearchSourceHealth(report([
      {sourceId: 'legacy-index', kind: 'malformed-candidate', detail: 'no userUpdatedAt'},
    ]))
    expect(searchSourceHealthSnapshot()?.summary).toContain('results may be stale')

    recordSearchSourceHealth(report([
      {sourceId: 'legacy-index', kind: 'malformed-candidate', detail: 'no userUpdatedAt'},
      {sourceId: 'semantic', kind: 'threw'},
    ]))
    expect(searchSourceHealthSnapshot()?.summary).toContain('results may be incomplete or stale')
  })

  it('clears once the failing source recovers', () => {
    recordSearchSourceHealth(report([{sourceId: 'semantic', kind: 'threw'}]))
    expect(searchSourceHealthSnapshot()).not.toBeNull()
    recordSearchSourceHealth(report([{sourceId: 'semantic', kind: 'ok'}]))
    expect(searchSourceHealthSnapshot()).toBeNull()
  })

  // A source that is disabled or lost to a runtime swap never gets to report
  // an `ok` retracting its failure, so anything that merged per-source signals
  // would name it forever. Absence from the next report is the retraction.
  it('stops naming a source that has left the runtime', () => {
    recordSearchSourceHealth(report([
      {sourceId: 'core.content', kind: 'ok'},
      {sourceId: 'semantic', kind: 'threw'},
    ]))
    expect(searchSourceHealthSnapshot()).not.toBeNull()

    recordSearchSourceHealth(report([{sourceId: 'core.content', kind: 'ok'}]))
    expect(searchSourceHealthSnapshot()).toBeNull()
  })

  // Fast typing overlaps searches, and a slow source can settle after a later
  // one. Without ordering, that older result publishes as current state and
  // the warning stays up after the user stops typing.
  it('ignores a report from a search that a later one has already superseded', () => {
    recordSearchSourceHealth(report([{sourceId: 'semantic', kind: 'ok'}], 2))
    expect(searchSourceHealthSnapshot()).toBeNull()

    recordSearchSourceHealth(report([{sourceId: 'semantic', kind: 'threw'}], 1))
    expect(searchSourceHealthSnapshot()).toBeNull()
  })

  it('carries the malformed-candidate detail through to the dropdown line', () => {
    recordSearchSourceHealth(report([{
      sourceId: 'legacy-index',
      kind: 'malformed-candidate',
      detail: 'returned block abc with a non-finite userUpdatedAt (undefined).',
    }]))
    expect(searchSourceHealthSnapshot()?.detail).toContain('legacy-index')
    expect(searchSourceHealthSnapshot()?.detail).toContain('non-finite userUpdatedAt')
  })

  it('summarises rather than enumerates when several sources are down', () => {
    recordSearchSourceHealth(report([
      {sourceId: 'a', kind: 'threw'},
      {sourceId: 'b', kind: 'threw'},
    ]))
    expect(searchSourceHealthSnapshot()?.summary).toContain('2 search sources')
  })

  // Search runs per keystroke, so an unchanged outcome must not wake
  // `useSyncExternalStore` — and the snapshot must stay referentially stable,
  // which the diagnostics contract requires.
  it('does not notify or re-allocate while a source keeps reporting the same outcome', () => {
    const listener = vi.fn()
    subscribeSearchSourceHealth(listener)

    recordSearchSourceHealth(report([{sourceId: 'semantic', kind: 'threw'}]))
    const first = searchSourceHealthSnapshot()
    expect(listener).toHaveBeenCalledTimes(1)

    recordSearchSourceHealth(report([{sourceId: 'semantic', kind: 'threw'}]))
    recordSearchSourceHealth(report([{sourceId: 'semantic', kind: 'threw'}]))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(searchSourceHealthSnapshot()).toBe(first)
  })
})
