import { describe, expect, it, vi } from 'vitest'
import { createLocalDbBuildGate, localDbBuildLockName, type GateLocks } from './localDbBuildGate'

/** Web Locks' grant rules, in memory: per name, requests are granted in
 *  order, shared with shared, exclusive alone; a lock is held until the
 *  callback's promise settles, and released before `request` resolves. */
const fakeLocks = () => {
  type Entry = {name: string, mode: LockMode, run: () => void, granted: boolean}
  const entries: Entry[] = []
  const pump = () => {
    for (const entry of entries) {
      if (entry.granted) continue
      const sameName = entries.filter(e => e.name === entry.name)
      const ahead = sameName.slice(0, sameName.indexOf(entry))
      const compatible = ahead.every(e => e.granted && e.mode === 'shared' && entry.mode === 'shared')
      if (!compatible) continue
      entry.granted = true
      entry.run()
    }
  }
  const locks: GateLocks = {
    request: (name, options, callback) => new Promise((resolve, reject) => {
      const release = () => {
        entries.splice(entries.indexOf(entry), 1)
        pump()
      }
      const entry: Entry = {name, mode: options.mode ?? 'exclusive', granted: false, run: () => {
        Promise.resolve(callback(null)).then(
          value => { release(); resolve(value) },
          error => { release(); reject(error) },
        )
      }}
      entries.push(entry)
      pump()
    }),
    query: async () => ({
      held: entries.filter(e => e.granted).map(({name, mode}) => ({name, mode})),
      pending: entries.filter(e => !e.granted).map(({name, mode}) => ({name, mode})),
    }),
  }
  /** Another tab holding `name` until the returned close() runs. */
  const otherTab = (name: string) => {
    let close!: () => void
    void locks.request(name, {mode: 'shared'}, () => new Promise<void>(resolve => { close = resolve }))
    return () => close()
  }
  const heldNames = () => entries.filter(e => e.granted).map(e => e.name)
  return {locks, otherTab, heldNames}
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('localDbBuildGate', () => {
  it('opens at once and holds its own build for the page’s life', async () => {
    const {locks, heldNames} = fakeLocks()
    const gate = createLocalDbBuildGate(locks)
    await gate.enter('a.db', 'build-2')
    expect(heldNames()).toEqual([localDbBuildLockName('a.db', 'build-2')])
    expect(gate.isWaiting()).toBe(false)
  })

  it('waits until every tab of another build has closed', async () => {
    const {locks, otherTab} = fakeLocks()
    const closeFirst = otherTab(localDbBuildLockName('a.db', 'build-1'))
    const closeSecond = otherTab(localDbBuildLockName('a.db', 'build-1'))
    const gate = createLocalDbBuildGate(locks)
    const waits: boolean[] = []
    gate.subscribe(() => waits.push(gate.isWaiting()))

    let opened = false
    const entered = gate.enter('a.db', 'build-2').then(() => { opened = true })
    await settle()
    expect(opened).toBe(false)
    expect(gate.isWaiting()).toBe(true)

    closeFirst()
    await settle()
    expect(opened).toBe(false)

    closeSecond()
    await entered
    expect(waits).toEqual([true, false])
  })

  it('shares the database with tabs of the same build', async () => {
    const {locks, otherTab} = fakeLocks()
    otherTab(localDbBuildLockName('a.db', 'build-2'))
    const gate = createLocalDbBuildGate(locks)
    await gate.enter('a.db', 'build-2')
    expect(gate.isWaiting()).toBe(false)
  })

  it('ignores builds holding a different database', async () => {
    const {locks, otherTab} = fakeLocks()
    otherTab(localDbBuildLockName('b.db', 'build-1'))
    const gate = createLocalDbBuildGate(locks)
    await gate.enter('a.db', 'build-2')
    expect(gate.isWaiting()).toBe(false)
  })

  it('enters once per database', async () => {
    const {locks, heldNames} = fakeLocks()
    const gate = createLocalDbBuildGate(locks)
    await gate.enter('a.db', 'build-2')
    await gate.enter('a.db', 'build-2')
    expect(heldNames()).toHaveLength(1)
  })

  it('opens when the lock manager fails, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const gate = createLocalDbBuildGate({
        request: () => Promise.reject(new DOMException('opaque origin', 'SecurityError')),
        query: () => Promise.reject(new Error('unreachable')),
      })
      await gate.enter('a.db', 'build-2')
      expect(gate.isWaiting()).toBe(false)
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })

  it('opens without a lock manager', async () => {
    const gate = createLocalDbBuildGate(undefined)
    await gate.enter('a.db', 'build-2')
    expect(gate.isWaiting()).toBe(false)
  })
})
