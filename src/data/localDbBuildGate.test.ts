import { describe, expect, it, vi } from 'vitest'
import { createLocalDbBuildGate, localDbBuildLockName, type GateLocks } from './localDbBuildGate'

/** Web Locks' grant rules, in memory: per name, requests are granted in
 *  order, shared with shared, exclusive alone; a lock is held until the
 *  callback's promise settles, and released before `request` resolves.
 *  Requests belong to a tab; unloading a tab drops all of its requests. */
const fakeLocks = () => {
  type Entry = {name: string, mode: LockMode, tab: number, run: () => void, granted: boolean}
  let entries: Entry[] = []
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
  let tabs = 0
  const tab = () => {
    const id = tabs++
    const locks: GateLocks = {
      request: (name, options, callback) => new Promise((resolve, reject) => {
        const release = () => {
          entries.splice(entries.indexOf(entry), 1)
          pump()
        }
        const entry: Entry = {name, mode: options.mode ?? 'exclusive', tab: id, granted: false, run: () => {
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
    const unload = () => {
      entries = entries.filter(e => e.tab !== id)
      pump()
    }
    return {locks, unload}
  }
  const {locks} = tab()
  /** Another tab holding `name` until the returned close() runs. */
  const otherTab = (name: string) => {
    const other = tab()
    void other.locks.request(name, {mode: 'shared'}, () => new Promise<void>(() => {}))
    return other.unload
  }
  const heldNames = () => entries.filter(e => e.granted).map(e => e.name)
  return {locks, tab, otherTab, heldNames}
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

  it('admits tabs of two builds starting together one build at a time', async () => {
    const {tab} = fakeLocks()
    const older = tab()
    const newer = tab()
    const olderGate = createLocalDbBuildGate(older.locks)
    const newerGate = createLocalDbBuildGate(newer.locks)

    const olderEntered = olderGate.enter('a.db', 'build-1')
    let newerOpened = false
    const newerEntered = newerGate.enter('a.db', 'build-2').then(() => { newerOpened = true })
    await olderEntered
    await settle()
    expect(newerOpened).toBe(false)
    expect(newerGate.isWaiting()).toBe(true)

    older.unload()
    await newerEntered
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
