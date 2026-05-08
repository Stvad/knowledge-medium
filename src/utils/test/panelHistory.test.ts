import { describe, it, expect, beforeEach } from 'vitest'
import { PanelHistoryStore } from '@/utils/panelHistory'

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
      expect(store.back('p1', 'b-current')).toBeNull()
      expect(store.forward('p1', 'b-current')).toBeNull()
    })

    it('pushes onto back and pops on back()', () => {
      store.push('p1', 'b-prev')
      expect(store.getSnapshot('p1').back).toEqual(['b-prev'])
      const dest = store.back('p1', 'b-current')
      expect(dest).toBe('b-prev')
      // back stack drained, current pushed onto forward
      expect(store.getSnapshot('p1')).toEqual({back: [], forward: ['b-current']})
    })

    it('forward returns to the popped entry and replays', () => {
      store.push('p1', 'b-a')
      store.back('p1', 'b-b') // back: [], forward: ['b-b']
      const dest = store.forward('p1', 'b-a')
      expect(dest).toBe('b-b')
      expect(store.getSnapshot('p1')).toEqual({back: ['b-a'], forward: []})
    })

    it('push() clears the forward stack (browser-tab semantics)', () => {
      store.push('p1', 'b-a')
      store.back('p1', 'b-b') // back: [], forward: ['b-b']
      store.push('p1', 'b-c') // a navigation away; forward should be wiped
      expect(store.getSnapshot('p1')).toEqual({back: ['b-c'], forward: []})
    })

    it('coalesces consecutive identical pushes (no-op when last back === prev)', () => {
      store.push('p1', 'b-a')
      store.push('p1', 'b-a')
      expect(store.getSnapshot('p1').back).toEqual(['b-a'])
    })

    it("doesn't coalesce when forward stack is non-empty", () => {
      // Repeated push of the same id while forward is set has to land,
      // because it represents a real navigation that should clear forward.
      store.push('p1', 'b-a')
      store.back('p1', 'b-b') // forward: ['b-b']
      store.push('p1', 'b-a') // same id but forward must clear
      expect(store.getSnapshot('p1')).toEqual({back: ['b-a'], forward: []})
    })

    it('isolates state per panel id', () => {
      store.push('p1', 'b-a')
      store.push('p2', 'b-x')
      expect(store.getSnapshot('p1').back).toEqual(['b-a'])
      expect(store.getSnapshot('p2').back).toEqual(['b-x'])
      expect(store.back('p2', 'b-y')).toBe('b-x')
      expect(store.getSnapshot('p1').back).toEqual(['b-a']) // unaffected
    })
  })

  describe('clear', () => {
    it('drops both stacks for the panel', () => {
      store.push('p1', 'b-a')
      store.back('p1', 'b-b') // forward populated
      store.clear('p1')
      expect(store.getSnapshot('p1')).toEqual({back: [], forward: []})
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
      store.push('p1', 'b-a')
      expect(n).toBe(1)
      store.back('p1', 'b-b')
      expect(n).toBe(2)
      store.forward('p1', 'b-a')
      expect(n).toBe(3)
      store.clear('p1')
      expect(n).toBe(4)
      unsub()
      store.push('p1', 'b-c')
      expect(n).toBe(4) // unsubscribed
    })

    it("doesn't notify listeners for unrelated panels", () => {
      let n = 0
      store.subscribe('p1', () => { n += 1 })
      store.push('p2', 'b-a')
      expect(n).toBe(0)
    })

    it('does not fire for a coalesced no-op push', () => {
      store.push('p1', 'b-a')
      let n = 0
      store.subscribe('p1', () => { n += 1 })
      store.push('p1', 'b-a') // same id, forward empty → coalesces
      expect(n).toBe(0)
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
