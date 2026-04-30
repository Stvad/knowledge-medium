// @vitest-environment node
/**
 * HandleStore + LoaderHandle tests (spec §5.1, §9.1, §9.2, §9.4).
 *
 * Covers:
 *   - Identity stability: same key → same handle instance.
 *   - Lifecycle: load() resolves → status='ready' + listeners fire.
 *   - Suspense path: read() throws while loading; returns value when ready.
 *   - Structural diffing: lodash.isEqual default skips listener walk on
 *     no-op re-resolves; custom equality opt-in.
 *   - Ref-count GC: handle disposes after gcTimeMs of zero subscribers
 *     and zero inflight loads. Cancels GC if a subscriber returns.
 *   - Dependency declaration + matches:
 *       row, parent-edge, workspace, table.
 *   - invalidate(change): walks the dep index; matched handles re-resolve
 *     and notify.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HandleStore,
  LoaderHandle,
  handleKey,
  stableArgsKey,
  type Dependency,
} from './handleStore'

interface ManualScheduler {
  schedule: (cb: () => void, ms: number) => () => void
  flush: (ms?: number) => void
  pending(): number
}

const manualScheduler = (): ManualScheduler => {
  type Pending = { id: number; cb: () => void; due: number }
  let now = 0
  let nextId = 1
  const queue: Pending[] = []
  return {
    schedule(cb, ms) {
      const entry: Pending = { id: nextId++, cb, due: now + ms }
      queue.push(entry)
      return () => {
        const i = queue.findIndex((q) => q.id === entry.id)
        if (i >= 0) queue.splice(i, 1)
      }
    },
    flush(ms?: number) {
      if (ms !== undefined) now += ms
      else now = Number.POSITIVE_INFINITY
      // Run due callbacks in order; each callback may schedule more.
      while (true) {
        const i = queue.findIndex((q) => q.due <= now)
        if (i < 0) break
        const [{ cb }] = queue.splice(i, 1)
        cb()
      }
    },
    pending() { return queue.length },
  }
}

const collectingLoader = <T>(value: T, deps: Dependency[] = [], onCall?: () => void) => {
  let calls = 0
  const loader = async (ctx: { depend: (d: Dependency) => void }) => {
    calls++
    onCall?.()
    for (const d of deps) ctx.depend(d)
    return value
  }
  return { loader, calls: () => calls }
}

let stores: HandleStore[] = []
afterEach(() => {
  for (const s of stores) s.clear()
  stores = []
})
const makeStore = (gcTimeMs = 1000, sched?: ManualScheduler): HandleStore => {
  const s = new HandleStore({ gcTimeMs, schedule: sched?.schedule })
  stores.push(s)
  return s
}

describe('HandleStore identity', () => {
  it('same key → same handle instance (getOrCreate)', () => {
    const store = makeStore()
    const { loader } = collectingLoader([1, 2, 3])
    const h1 = store.getOrCreate('children:abc', () =>
      new LoaderHandle({ store, key: 'children:abc', loader }),
    )
    const h2 = store.getOrCreate('children:abc', () =>
      new LoaderHandle({ store, key: 'children:abc', loader }),
    )
    expect(h2).toBe(h1)
    expect(store.size()).toBe(1)
  })

  it('different keys → different instances', () => {
    const store = makeStore()
    const { loader } = collectingLoader([])
    const a = store.getOrCreate('a', () => new LoaderHandle({ store, key: 'a', loader }))
    const b = store.getOrCreate('b', () => new LoaderHandle({ store, key: 'b', loader }))
    expect(a).not.toBe(b)
    expect(store.size()).toBe(2)
  })

  it('handleKey() yields stable strings regardless of object key order', () => {
    expect(handleKey('children', { id: 'x', limit: 10 })).toBe(
      handleKey('children', { limit: 10, id: 'x' }),
    )
    expect(stableArgsKey({ a: 1, b: 2 })).toBe(stableArgsKey({ b: 2, a: 1 }))
  })
})

describe('LoaderHandle lifecycle', () => {
  it('load() resolves; status transitions idle → loading → ready', async () => {
    const store = makeStore()
    const { loader } = collectingLoader([1, 2])
    const h = store.getOrCreate('q', () =>
      new LoaderHandle<number[]>({ store, key: 'q', loader }),
    )
    expect(h.status()).toBe('idle')
    expect(h.peek()).toBeUndefined()

    const p = h.load()
    expect(h.status()).toBe('loading')
    const v = await p
    expect(v).toEqual([1, 2])
    expect(h.status()).toBe('ready')
    expect(h.peek()).toEqual([1, 2])
  })

  it('subscribe kicks off a load when idle and fires on completion', async () => {
    const store = makeStore()
    const { loader } = collectingLoader([42])
    const h = store.getOrCreate('q', () =>
      new LoaderHandle<number[]>({ store, key: 'q', loader }),
    )
    const fired: number[][] = []
    h.subscribe((v) => fired.push(v))
    // Listener does NOT fire synchronously with the current value;
    // it's a change-notification API. First fire is the load completion.
    expect(fired).toEqual([])
    await vi.waitFor(() => expect(fired.length).toBe(1))
    expect(fired[0]).toEqual([42])
  })

  it('parallel load() calls dedup to one loader invocation', async () => {
    const store = makeStore()
    const { loader, calls } = collectingLoader('x')
    const h = store.getOrCreate('q', () =>
      new LoaderHandle<string>({ store, key: 'q', loader }),
    )
    const [a, b] = await Promise.all([h.load(), h.load()])
    expect(a).toBe('x')
    expect(b).toBe('x')
    expect(calls()).toBe(1)
  })

  it('read() throws a Promise while loading; returns value when ready', async () => {
    const store = makeStore()
    const { loader } = collectingLoader('done')
    const h = store.getOrCreate('q', () =>
      new LoaderHandle<string>({ store, key: 'q', loader }),
    )
    let thrown: unknown
    try { h.read() } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(Promise)
    await thrown
    expect(h.read()).toBe('done')
  })

  it('read() throws stored error after a failed load', async () => {
    const store = makeStore()
    const boom = new Error('boom')
    const h = store.getOrCreate('q', () =>
      new LoaderHandle<number>({
        store,
        key: 'q',
        loader: async () => { throw boom },
      }),
    )
    await expect(h.load()).rejects.toBe(boom)
    expect(h.status()).toBe('error')
    expect(() => h.read()).toThrow(boom)
  })
})

describe('LoaderHandle structural diffing (§9.4)', () => {
  it('does not fire listeners on a re-resolve that returns an equal value', async () => {
    const store = makeStore()
    const { loader } = collectingLoader([1, 2, 3])
    const h = store.getOrCreate('q', () =>
      new LoaderHandle<number[]>({ store, key: 'q', loader }),
    )
    const fired: number[][] = []
    h.subscribe((v) => fired.push(v))
    await vi.waitFor(() => expect(fired.length).toBe(1))

    // Trigger a re-resolve via store.invalidate against a matching dep.
    // (No deps declared, so direct .invalidate() is the test path.)
    h.invalidate()
    // Allow the re-resolve microtask to settle.
    await Promise.resolve()
    await Promise.resolve()
    expect(fired.length).toBe(1) // unchanged — equal arrays don't fire
  })

  it('fires listeners when the resolved value changes', async () => {
    const store = makeStore()
    let n = 1
    const h = store.getOrCreate('q', () =>
      new LoaderHandle<number>({
        store,
        key: 'q',
        loader: async () => n,
      }),
    )
    const fired: number[] = []
    h.subscribe((v) => fired.push(v))
    await vi.waitFor(() => expect(fired.length).toBe(1))

    n = 2
    h.invalidate()
    await vi.waitFor(() => expect(fired.length).toBe(2))
    expect(fired).toEqual([1, 2])
  })

  it('honors a custom equality function', async () => {
    const store = makeStore()
    let n = 1
    const equality = (a: number, b: number) => Math.abs(a - b) < 0.5
    const h = store.getOrCreate('q', () =>
      new LoaderHandle<number>({
        store,
        key: 'q',
        loader: async () => n,
        equality,
      }),
    )
    const fired: number[] = []
    h.subscribe((v) => fired.push(v))
    await vi.waitFor(() => expect(fired.length).toBe(1))

    n = 1.2 // within tolerance — no fire
    h.invalidate()
    await Promise.resolve()
    await Promise.resolve()
    expect(fired.length).toBe(1)

    n = 5 // outside tolerance — fires
    h.invalidate()
    await vi.waitFor(() => expect(fired.length).toBe(2))
  })
})

describe('LoaderHandle GC', () => {
  it('disposes after gcTimeMs once subscribers drain', async () => {
    const sched = manualScheduler()
    const store = new HandleStore({ gcTimeMs: 100, schedule: sched.schedule })
    stores.push(store)
    const { loader } = collectingLoader('v')
    const h = store.getOrCreate('q', () =>
      new LoaderHandle<string>({ store, key: 'q', loader }),
    )
    const off = h.subscribe(() => {})
    await vi.waitFor(() => expect(h.status()).toBe('ready'))
    expect(store.size()).toBe(1)

    off() // last subscriber drops; GC scheduled
    expect(store.size()).toBe(1) // still alive — within gc window
    expect(sched.pending()).toBe(1)

    sched.flush(100) // advance timers past gcTimeMs
    expect(store.size()).toBe(0)
  })

  it('cancels GC when a new subscriber arrives in the gc window', async () => {
    const sched = manualScheduler()
    const store = new HandleStore({ gcTimeMs: 100, schedule: sched.schedule })
    stores.push(store)
    const { loader } = collectingLoader('v')
    const h = store.getOrCreate('q', () =>
      new LoaderHandle<string>({ store, key: 'q', loader }),
    )
    const off = h.subscribe(() => {})
    await vi.waitFor(() => expect(h.status()).toBe('ready'))

    off() // GC pending
    expect(sched.pending()).toBe(1)
    h.subscribe(() => {}) // re-subscribe within the window
    expect(sched.pending()).toBe(0) // GC cancelled
    sched.flush(100)
    expect(store.size()).toBe(1) // still alive
  })

  it('counts inflight loads against GC', async () => {
    const sched = manualScheduler()
    const store = new HandleStore({ gcTimeMs: 100, schedule: sched.schedule })
    stores.push(store)
    let resolveLoader!: (v: string) => void
    const h = store.getOrCreate('q', () =>
      new LoaderHandle<string>({
        store,
        key: 'q',
        loader: () => new Promise<string>((r) => { resolveLoader = r }),
      }),
    )
    const off = h.subscribe(() => {})
    off() // refCount → 1 (still the inflight load)
    expect(sched.pending()).toBe(0) // no GC scheduled — load still in flight
    resolveLoader('done')
    await vi.waitFor(() => expect(h.status()).toBe('ready'))
    // After load completes, refCount → 0; GC scheduled.
    expect(sched.pending()).toBe(1)
    sched.flush(100)
    expect(store.size()).toBe(0)
  })
})

describe('Dependencies + invalidate()', () => {
  it('row dep: invalidate({rowIds}) re-resolves matching handle only', async () => {
    const store = makeStore()
    let v = 1
    const matchingDep: Dependency = { kind: 'row', id: 'r1' }
    const h = store.getOrCreate('q', () =>
      new LoaderHandle<number>({
        store,
        key: 'q',
        loader: async (ctx) => { ctx.depend(matchingDep); return v },
      }),
    )
    const fired: number[] = []
    h.subscribe((x) => fired.push(x))
    await vi.waitFor(() => expect(fired).toEqual([1]))

    v = 2
    store.invalidate({ rowIds: ['r2'] }) // no match
    await Promise.resolve()
    expect(fired).toEqual([1])

    store.invalidate({ rowIds: ['r1'] }) // matches dep
    await vi.waitFor(() => expect(fired).toEqual([1, 2]))
  })

  it('parent-edge dep: invalidate({parentIds}) matches', async () => {
    const store = makeStore()
    let v = ['a']
    const h = store.getOrCreate('q', () =>
      new LoaderHandle<string[]>({
        store,
        key: 'q',
        loader: async (ctx) => {
          ctx.depend({ kind: 'parent-edge', parentId: 'p1' })
          return v
        },
      }),
    )
    const fired: string[][] = []
    h.subscribe((x) => fired.push(x))
    await vi.waitFor(() => expect(fired.length).toBe(1))

    v = ['a', 'b']
    store.invalidate({ parentIds: ['p2'] })
    await Promise.resolve()
    expect(fired.length).toBe(1)

    store.invalidate({ parentIds: ['p1'] })
    await vi.waitFor(() => expect(fired.length).toBe(2))
  })

  it('workspace dep: matches workspaceIds', async () => {
    const store = makeStore()
    let v = 'x'
    const h = store.getOrCreate('q', () =>
      new LoaderHandle<string>({
        store,
        key: 'q',
        loader: async (ctx) => {
          ctx.depend({ kind: 'workspace', workspaceId: 'w1' })
          return v
        },
      }),
    )
    const fired: string[] = []
    h.subscribe((x) => fired.push(x))
    await vi.waitFor(() => expect(fired.length).toBe(1))
    v = 'y'
    store.invalidate({ workspaceIds: ['w1'] })
    await vi.waitFor(() => expect(fired).toEqual(['x', 'y']))
  })

  it('table dep: matches tables', async () => {
    const store = makeStore()
    let v = 0
    const h = store.getOrCreate('q', () =>
      new LoaderHandle<number>({
        store,
        key: 'q',
        loader: async (ctx) => {
          ctx.depend({ kind: 'table', table: 'blocks' })
          return v
        },
      }),
    )
    const fired: number[] = []
    h.subscribe((x) => fired.push(x))
    await vi.waitFor(() => expect(fired.length).toBe(1))
    v = 1
    store.invalidate({ tables: ['blocks'] })
    await vi.waitFor(() => expect(fired).toEqual([0, 1]))
  })

  it('handles can declare multiple deps; any match triggers re-resolve', async () => {
    const store = makeStore()
    let v = 0
    const h = store.getOrCreate('q', () =>
      new LoaderHandle<number>({
        store,
        key: 'q',
        loader: async (ctx) => {
          ctx.depend({ kind: 'row', id: 'r1' })
          ctx.depend({ kind: 'parent-edge', parentId: 'p1' })
          return v
        },
      }),
    )
    const fired: number[] = []
    h.subscribe((x) => fired.push(x))
    await vi.waitFor(() => expect(fired.length).toBe(1))
    v = 1
    store.invalidate({ parentIds: ['p1'] })
    await vi.waitFor(() => expect(fired).toEqual([0, 1]))
  })

  it('invalidate() with no matching change is a no-op (no re-resolve)', async () => {
    const store = makeStore()
    const { loader, calls } = collectingLoader(1, [{ kind: 'row', id: 'r1' }])
    const h = store.getOrCreate('q', () =>
      new LoaderHandle<number>({ store, key: 'q', loader }),
    )
    h.subscribe(() => {})
    await vi.waitFor(() => expect(calls()).toBe(1))
    store.invalidate({ rowIds: ['nope'] })
    await Promise.resolve()
    expect(calls()).toBe(1)
  })

  it('a handle with no deps yet is not invalidated by anything', async () => {
    const store = makeStore()
    let resolve!: (v: number) => void
    const h = store.getOrCreate('q', () =>
      new LoaderHandle<number>({
        store,
        key: 'q',
        loader: () => new Promise<number>((r) => { resolve = r }),
      }),
    )
    const fired: number[] = []
    h.subscribe((x) => fired.push(x))
    // Loader hasn't completed → no deps captured yet.
    store.invalidate({ rowIds: ['anything'] })
    expect(fired).toEqual([])
    resolve(1)
    await vi.waitFor(() => expect(fired).toEqual([1]))
  })
})

describe('Mid-load invalidations are not dropped (reviewer P2)', () => {
  it('upfront-declared deps match a mid-load invalidate', async () => {
    // The loader declares its dep BEFORE awaiting — invalidate during
    // the load should match the declared dep, set pendingReinvalidate,
    // and force a rerun once the load settles.
    const store = makeStore()
    let releaseFirstLoad!: () => void
    let n = 1
    let runs = 0
    const calls: number[] = []
    const h = store.getOrCreate('q', () =>
      new LoaderHandle<number>({
        store,
        key: 'q',
        loader: async (ctx) => {
          runs++
          ctx.depend({ kind: 'row', id: 'r1' }) // upfront, sync
          if (runs === 1) {
            await new Promise<void>((r) => { releaseFirstLoad = r })
          }
          calls.push(n)
          return n
        },
      }),
    )
    h.subscribe(() => {})

    // Loader paused awaiting releaseFirstLoad; deps are live.
    await vi.waitFor(() => expect(h.status()).toBe('loading'))
    n = 2
    store.invalidate({ rowIds: ['r1'] }) // matches the upfront dep

    releaseFirstLoad()
    // First load settles → pendingReinvalidate triggers a rerun that
    // reads the fresh n=2 and re-publishes.
    await vi.waitFor(() => expect(runs).toBe(2))
    expect(calls).toEqual([2, 2])
  })

  it('coalesces multiple invalidations during one load into one rerun', async () => {
    const store = makeStore()
    let releaseLoad!: () => void
    let n = 1
    let runs = 0
    const h = store.getOrCreate('q', () =>
      new LoaderHandle<number>({
        store,
        key: 'q',
        loader: async (ctx) => {
          runs++
          ctx.depend({ kind: 'row', id: 'r1' })
          if (runs === 1) {
            await new Promise<void>((r) => { releaseLoad = r })
          }
          return n
        },
      }),
    )
    h.subscribe(() => {})
    await vi.waitFor(() => expect(h.status()).toBe('loading'))

    // Three invalidations during one load — should coalesce into one
    // rerun, not three.
    n = 2
    store.invalidate({ rowIds: ['r1'] })
    store.invalidate({ rowIds: ['r1'] })
    store.invalidate({ rowIds: ['r1'] })
    releaseLoad()

    await vi.waitFor(() => expect(runs).toBe(2))
    // Settle the microtask queue — confirm no further reruns fired.
    await Promise.resolve()
    await Promise.resolve()
    expect(runs).toBe(2)
  })

  it('failed load with mid-load invalidate reruns on next attempt', async () => {
    const store = makeStore()
    let runs = 0
    let nextResult: number | Error = new Error('boom')
    let release!: () => void
    const h = store.getOrCreate('q', () =>
      new LoaderHandle<number>({
        store,
        key: 'q',
        loader: async (ctx) => {
          runs++
          ctx.depend({ kind: 'row', id: 'r1' })
          if (runs === 1) {
            await new Promise<void>((r) => { release = r })
          }
          if (nextResult instanceof Error) throw nextResult
          return nextResult
        },
      }),
    )
    h.subscribe(() => {})
    await vi.waitFor(() => expect(h.status()).toBe('loading'))
    store.invalidate({ rowIds: ['r1'] }) // queue rerun
    nextResult = 7
    release()

    await vi.waitFor(() => expect(runs).toBe(2))
    await vi.waitFor(() => expect(h.status()).toBe('ready'))
    expect(h.peek()).toBe(7)
  })
})
