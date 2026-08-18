import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  recordSearchSourceHealth,
  resetSearchSourceHealth,
  searchSourceHealthSnapshot,
  subscribeSearchSourceHealth,
} from '../store.js'

describe('search-source health store', () => {
  beforeEach(() => {
    resetSearchSourceHealth()
  })

  it('reports nothing while every source is healthy', () => {
    recordSearchSourceHealth({sourceId: 'core.content', kind: 'ok'})
    recordSearchSourceHealth({sourceId: 'semantic', kind: 'ok'})
    expect(searchSourceHealthSnapshot()).toBeNull()
  })

  it('warns, naming the source, once one starts failing', () => {
    recordSearchSourceHealth({sourceId: 'core.content', kind: 'ok'})
    recordSearchSourceHealth({sourceId: 'semantic', kind: 'threw'})
    const snapshot = searchSourceHealthSnapshot()
    expect(snapshot?.severity).toBe('warning')
    expect(snapshot?.summary).toContain('semantic')
    expect(snapshot?.summary).toContain('results may be incomplete')
  })

  // The whole point of emitting 'ok' from the merge point: a health surface
  // that latches on the first transient failure is worse than none, because
  // the user learns to ignore it.
  it('clears once the failing source recovers', () => {
    recordSearchSourceHealth({sourceId: 'semantic', kind: 'threw'})
    expect(searchSourceHealthSnapshot()).not.toBeNull()
    recordSearchSourceHealth({sourceId: 'semantic', kind: 'ok'})
    expect(searchSourceHealthSnapshot()).toBeNull()
  })

  it('carries the malformed-candidate detail through to the dropdown line', () => {
    recordSearchSourceHealth({
      sourceId: 'legacy-index',
      kind: 'malformed-candidate',
      detail: 'returned block abc with a non-finite userUpdatedAt (undefined).',
    })
    expect(searchSourceHealthSnapshot()?.detail).toContain('legacy-index')
    expect(searchSourceHealthSnapshot()?.detail).toContain('non-finite userUpdatedAt')
  })

  it('summarises rather than enumerates when several sources are down', () => {
    recordSearchSourceHealth({sourceId: 'a', kind: 'threw'})
    recordSearchSourceHealth({sourceId: 'b', kind: 'threw'})
    expect(searchSourceHealthSnapshot()?.summary).toContain('2 search sources')
  })

  // Search runs per keystroke, so an unchanged outcome must not wake
  // `useSyncExternalStore` — and the snapshot must stay referentially stable,
  // which the diagnostics contract requires.
  it('does not notify or re-allocate while a source keeps reporting the same outcome', () => {
    const listener = vi.fn()
    subscribeSearchSourceHealth(listener)

    recordSearchSourceHealth({sourceId: 'semantic', kind: 'threw'})
    const first = searchSourceHealthSnapshot()
    expect(listener).toHaveBeenCalledTimes(1)

    recordSearchSourceHealth({sourceId: 'semantic', kind: 'threw'})
    recordSearchSourceHealth({sourceId: 'semantic', kind: 'threw'})
    expect(listener).toHaveBeenCalledTimes(1)
    expect(searchSourceHealthSnapshot()).toBe(first)
  })
})
