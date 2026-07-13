import { describe, it, expect, beforeEach } from 'vitest'
import { PanelHistoryStore, type HistoryEntry } from '@/utils/panelHistory'

const e = (blockId: string, state?: HistoryEntry['state']): HistoryEntry =>
  state ? {blockId, state} : {blockId}

const l = (blockId: string) => ({blockId, renderScopeId: `scope:${blockId}`})

describe('PanelHistoryStore', () => {
  let store: PanelHistoryStore

  beforeEach(() => {
    store = new PanelHistoryStore()
  })

  describe('push / back / forward', () => {
    it('starts empty and reports no back/forward available', () => {
      const snap = store.getSnapshot('p1')
      expect(snap.back).toEqual([])
      expect(snap.forward).toEqual([])
      expect(store.back('p1', e('b-current'))).toBeNull()
      expect(store.forward('p1', e('b-current'))).toBeNull()
    })

    it('pushes onto back and pops on back()', () => {
      store.push('p1', e('b-prev'))
      expect(store.getSnapshot('p1').back).toEqual([e('b-prev')])
      const dest = store.back('p1', e('b-current'))
      expect(dest).toEqual(e('b-prev'))
      expect(store.getSnapshot('p1')).toEqual({back: [], forward: [e('b-current')]})
    })

    it('forward returns to the popped entry and replays', () => {
      store.push('p1', e('b-a'))
      store.back('p1', e('b-b')) // back: [], forward: [e('b-b')]
      const dest = store.forward('p1', e('b-a'))
      expect(dest).toEqual(e('b-b'))
      expect(store.getSnapshot('p1')).toEqual({back: [e('b-a')], forward: []})
    })

    it('push() clears the forward stack (browser-tab semantics)', () => {
      store.push('p1', e('b-a'))
      store.back('p1', e('b-b')) // forward: [e('b-b')]
      store.push('p1', e('b-c'))
      expect(store.getSnapshot('p1')).toEqual({back: [e('b-c')], forward: []})
    })

    it('coalesces consecutive identical pushes (no-op when last back === prev)', () => {
      store.push('p1', e('b-a'))
      store.push('p1', e('b-a'))
      expect(store.getSnapshot('p1').back).toEqual([e('b-a')])
    })

    it("doesn't coalesce when forward stack is non-empty", () => {
      store.push('p1', e('b-a'))
      store.back('p1', e('b-b')) // forward: [e('b-b')]
      store.push('p1', e('b-a'))
      expect(store.getSnapshot('p1')).toEqual({back: [e('b-a')], forward: []})
    })

    it('isolates state per panel id', () => {
      store.push('p1', e('b-a'))
      store.push('p2', e('b-x'))
      expect(store.getSnapshot('p1').back).toEqual([e('b-a')])
      expect(store.getSnapshot('p2').back).toEqual([e('b-x')])
      expect(store.back('p2', e('b-y'))).toEqual(e('b-x'))
      expect(store.getSnapshot('p1').back).toEqual([e('b-a')])
    })
  })

  describe('VisitState round-trips on history entries', () => {
    it('preserves state attached to push() through back()/forward()', () => {
      const stateA = {focusedLocation: l('fa'), scrollTop: 100}
      const stateB = {focusedLocation: l('fb'), scrollTop: 200}
      store.push('p1', e('b-a', stateA))
      const back = store.back('p1', e('b-b', stateB))
      expect(back).toEqual({blockId: 'b-a', state: stateA})
      const forward = store.forward('p1', e('b-a', stateA))
      expect(forward).toEqual({blockId: 'b-b', state: stateB})
    })

    it('coalesces by blockId regardless of state difference', () => {
      // Pushing the same block twice with different snapshots — the
      // second is treated as a no-op (we never moved away). Keeps the
      // back stack from filling with redundant captures of the same
      // block.
      store.push('p1', e('b-a', {scrollTop: 10}))
      store.push('p1', e('b-a', {scrollTop: 50}))
      expect(store.getSnapshot('p1').back).toEqual([e('b-a', {scrollTop: 10})])
    })
  })

  describe('viewModeEnter rides the entry pair', () => {
    it('survives a back/forward round trip (and a second one)', () => {
      // Enter gesture from A: the entry it left FROM is stamped.
      store.push('p1', {blockId: 'b-A', viewModeEnter: 'm'})

      // Chevron back (currently on B): the stamp carries onto the entry
      // pushed to the forward stack…
      const backDest = store.back('p1', e('b-B'))
      expect(backDest?.viewModeEnter).toBe('m')
      expect(store.getSnapshot('p1').forward.at(-1)).toStrictEqual({blockId: 'b-B', viewModeEnter: 'm'})

      // …and chevron forward re-stamps the entry pushed back onto back.
      const forwardDest = store.forward('p1', e('b-A'))
      expect(forwardDest?.viewModeEnter).toBe('m')
      expect(store.getSnapshot('p1').back.at(-1)).toStrictEqual({blockId: 'b-A', viewModeEnter: 'm'})

      // Second round trip: still stamped on both sides.
      store.back('p1', e('b-B'))
      expect(store.getSnapshot('p1').forward.at(-1)).toStrictEqual({blockId: 'b-B', viewModeEnter: 'm'})
      store.forward('p1', e('b-A'))
      expect(store.getSnapshot('p1').back.at(-1)).toStrictEqual({blockId: 'b-A', viewModeEnter: 'm'})
    })

    it('unstamped entries stay unstamped through round trips', () => {
      store.push('p1', e('b-A'))
      store.back('p1', e('b-B'))
      expect(store.getSnapshot('p1').forward.at(-1)).toStrictEqual({blockId: 'b-B'})
      store.forward('p1', e('b-A'))
      expect(store.getSnapshot('p1').back.at(-1)).toStrictEqual({blockId: 'b-A'})
    })

    it('survives browser-driven (reconcileUrlNavigation) round trips too', () => {
      store.push('p1', {blockId: 'b-A', viewModeEnter: 'm'})

      // Browser Back (on B, URL says A): pops the stamped entry, stamp
      // carries onto the forward reconstruction.
      const back = store.reconcileUrlNavigation('p1', e('b-B'), 'b-A')
      expect(back?.viewModeEnter).toBe('m')
      expect(store.getSnapshot('p1').forward.at(-1)).toStrictEqual({blockId: 'b-B', viewModeEnter: 'm'})

      // Browser Forward (on A, URL says B): re-stamps the back entry.
      const forward = store.reconcileUrlNavigation('p1', e('b-A'), 'b-B')
      expect(forward?.viewModeEnter).toBe('m')
      expect(store.getSnapshot('p1').back.at(-1)).toStrictEqual({blockId: 'b-A', viewModeEnter: 'm'})
    })
  })

  describe('snapshotter', () => {
    it('snapshot() returns undefined when no snapshotter is registered', () => {
      expect(store.snapshot('p1')).toBeUndefined()
    })

    it('snapshot() invokes the registered function and returns its result', () => {
      const state = {focusedLocation: l('foo'), scrollTop: 42}
      store.registerSnapshotter('p1', () => state)
      expect(store.snapshot('p1')).toEqual(state)
    })

    it('unsubscribe removes the snapshotter', () => {
      const fn = () => ({focusedLocation: l('foo')})
      const unsub = store.registerSnapshotter('p1', fn)
      expect(store.snapshot('p1')).toEqual({focusedLocation: l('foo')})
      unsub()
      expect(store.snapshot('p1')).toBeUndefined()
    })

    it('unsubscribe is a no-op if a remount has replaced the snapshotter', () => {
      const fnA = () => ({focusedLocation: l('a')})
      const fnB = () => ({focusedLocation: l('b')})
      const unsubA = store.registerSnapshotter('p1', fnA)
      store.registerSnapshotter('p1', fnB) // remount replaces fnA
      unsubA() // should NOT clear fnB
      expect(store.snapshot('p1')).toEqual({focusedLocation: l('b')})
    })

    it('isolates snapshotters per panel id', () => {
      store.registerSnapshotter('p1', () => ({focusedLocation: l('p1-focus')}))
      store.registerSnapshotter('p2', () => ({focusedLocation: l('p2-focus')}))
      expect(store.snapshot('p1')).toEqual({focusedLocation: l('p1-focus')})
      expect(store.snapshot('p2')).toEqual({focusedLocation: l('p2-focus')})
    })
  })

  describe('pending-restore queue', () => {
    it('enqueueRestore + consumeRestore round-trips a state', () => {
      const state = {focusedLocation: l('foo'), scrollTop: 99}
      store.enqueueRestore('p1', state)
      expect(store.consumeRestore('p1')).toEqual(state)
    })

    it('consumeRestore drains the queue (only fires once)', () => {
      store.enqueueRestore('p1', {scrollTop: 10})
      expect(store.consumeRestore('p1')).toEqual({scrollTop: 10})
      expect(store.consumeRestore('p1')).toBeUndefined()
    })

    it('enqueueRestore(undefined) clears any pending restore', () => {
      store.enqueueRestore('p1', {scrollTop: 10})
      store.enqueueRestore('p1', undefined)
      expect(store.consumeRestore('p1')).toBeUndefined()
    })

    it('per-panel isolation', () => {
      store.enqueueRestore('p1', {scrollTop: 10})
      expect(store.consumeRestore('p2')).toBeUndefined()
      expect(store.consumeRestore('p1')).toEqual({scrollTop: 10})
    })
  })

  describe('clear', () => {
    it('drops both stacks and any pending restore for the panel', () => {
      store.push('p1', e('b-a'))
      store.back('p1', e('b-b'))
      store.enqueueRestore('p1', {scrollTop: 10})
      store.clear('p1')
      expect(store.getSnapshot('p1')).toEqual({back: [], forward: []})
      expect(store.consumeRestore('p1')).toBeUndefined()
    })

    it('is a no-op for an unknown panel id', () => {
      const listener = () => { throw new Error('should not fire') }
      store.subscribe('p1', listener)
      expect(() => store.clear('never-touched')).not.toThrow()
    })
  })

  describe('subscribe', () => {
    it('fires the listener on push / back / forward / clear', () => {
      let n = 0
      const unsub = store.subscribe('p1', () => { n += 1 })
      store.push('p1', e('b-a'))
      expect(n).toBe(1)
      store.back('p1', e('b-b'))
      expect(n).toBe(2)
      store.forward('p1', e('b-a'))
      expect(n).toBe(3)
      store.clear('p1')
      expect(n).toBe(4)
      unsub()
      store.push('p1', e('b-c'))
      expect(n).toBe(4) // unsubscribed
    })

    it("doesn't notify listeners for unrelated panels", () => {
      let n = 0
      store.subscribe('p1', () => { n += 1 })
      store.push('p2', e('b-a'))
      expect(n).toBe(0)
    })

    it('does not fire for a coalesced no-op push', () => {
      store.push('p1', e('b-a'))
      let n = 0
      store.subscribe('p1', () => { n += 1 })
      store.push('p1', e('b-a'))
      expect(n).toBe(0)
    })

    it('idempotent unsubscribe does not detach a fresh re-subscribe', () => {
      let stale = 0
      const unsubA = store.subscribe('p1', () => { stale += 1 })
      unsubA()
      let fresh = 0
      store.subscribe('p1', () => { fresh += 1 })
      unsubA() // second call must not evict the new bucket
      store.push('p1', e('b-a'))
      expect(fresh).toBe(1)
      expect(stale).toBe(0)
    })
  })

  describe('getSnapshot identity', () => {
    it('returns a stable EMPTY reference for unknown panels (useSyncExternalStore contract)', () => {
      const a = store.getSnapshot('p1')
      const b = store.getSnapshot('p1')
      expect(a).toBe(b)
    })
  })
})
