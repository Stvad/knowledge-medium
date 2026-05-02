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

  it('a matching invalidate on a ready handle runs the loader exactly once (reviewer P2 #3)', async () => {
    // Pre-fix shape: invalidate() spun up a fresh load, then
    // observeDuringLoad recorded the same change because inflight was
    // now truthy. After settle, queue replay matched the freshly-
    // collected deps and scheduled ANOTHER load — caller saw two
    // listener notifications for one logical change.
    //
    // Post-fix: observeDuringLoad runs first; its inflight gate sees
    // the pre-invalidate state (false), skips the queue. invalidate
    // then kicks off exactly one load.
    const store = makeStore()
    let runs = 0
    const h = store.getOrCreate('q', () =>
      new LoaderHandle<number>({
        store,
        key: 'q',
        loader: async (ctx) => {
          runs++
          ctx.depend({ kind: 'row', id: 'r1' })
          return runs
        },
      }),
    )
    const fired: number[] = []
    h.subscribe((x) => fired.push(x))
    await vi.waitFor(() => expect(runs).toBe(1))
    store.invalidate({ rowIds: ['r1'] })
    await vi.waitFor(() => expect(fired).toEqual([1, 2]))
    // Settle microtasks — confirm no spurious third run scheduled.
    await Promise.resolve()
    await Promise.resolve()
    expect(runs).toBe(2)
    expect(fired).toEqual([1, 2])
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

describe('Dynamic deps declared after SQL — change-during-load queue', () => {
  // Reviewer P2: row-returning handles (`repo.children`, `repo.subtree`,
  // etc.) only know which row deps to declare AFTER the SQL returns. A
  // commit that lands between SQL read and per-row `ctx.depend(...)`
  // doesn't match the upfront `parent-edge` dep, so without a queue it
  // slips past `matches` entirely and the handle settles with stale
  // BlockData[] keyed off the pre-commit SQL snapshot.
  //
  // The fix has the store deliver every change to in-flight handles
  // via observeDuringLoad; on settle, the handle re-walks the queue
  // against the freshly-collected deps and reruns if any match.

  it('change matching a post-SQL row dep triggers a rerun even when no upfront dep matches', async () => {
    // The exact race: SQL reads at time T, returns pre-commit rows.
    // Commit at T+1 invalidates one of those rows. Per-row dep is
    // declared at T+2 — after the invalidation already passed through
    // matches(). Without the queue, the handle settles with the
    // stale T-time data.
    //
    // We model "SQL data captured at T" by reading `currentValue` into
    // a local BEFORE the await, then returning that local AFTER the
    // await. The loader's published value reflects the pre-await read.
    const store = makeStore()
    let releaseSql!: () => void
    let currentValue = 'v1'
    let runs = 0
    const h = store.getOrCreate('children:p', () =>
      new LoaderHandle<string>({
        store,
        key: 'children:p',
        loader: async (ctx) => {
          runs++
          ctx.depend({ kind: 'parent-edge', parentId: 'p' })
          // Simulate SQL: read the row's value into a local at this point.
          const captured = currentValue
          if (runs === 1) {
            await new Promise<void>((r) => { releaseSql = r })
          }
          // Per-row dep declared AFTER the await — same shape as
          // hydrateRows' `ctx.depend({kind:'row', id:childA})` after
          // CHILDREN_SQL returns.
          ctx.depend({ kind: 'row', id: 'childA' })
          return captured
        },
      }),
    )
    h.subscribe(() => {})
    await vi.waitFor(() => expect(h.status()).toBe('loading'))

    // Mid-load: invalidation hits for childA AFTER its SQL row was
    // captured but BEFORE its per-row dep was declared. Upfront deps
    // are just `parent-edge:p`, so `matches` returns false. Without
    // the queue, this change is dropped on the floor.
    currentValue = 'v2'
    store.invalidate({ rowIds: ['childA'] })

    releaseSql()
    // First run settles with stale 'v1' — the queue then triggers a
    // rerun that captures the post-commit 'v2'.
    await vi.waitFor(() => expect(runs).toBe(2))
    await vi.waitFor(() => expect(h.peek()).toBe('v2'))
  })

  it('change that does not match any post-load dep does NOT trigger a rerun', async () => {
    // Negative case: the queue must only fire reruns when a queued
    // change actually matches a dep the loader ended up declaring.
    // Otherwise every invalidation in the system would force every
    // in-flight handle to rerun.
    const store = makeStore()
    let releaseSql!: () => void
    let runs = 0
    const h = store.getOrCreate('children:p', () =>
      new LoaderHandle<string>({
        store,
        key: 'children:p',
        loader: async (ctx) => {
          runs++
          ctx.depend({ kind: 'parent-edge', parentId: 'p' })
          if (runs === 1) {
            await new Promise<void>((r) => { releaseSql = r })
          }
          ctx.depend({ kind: 'row', id: 'childA' })
          return 'v1'
        },
      }),
    )
    h.subscribe(() => {})
    await vi.waitFor(() => expect(h.status()).toBe('loading'))

    // Unrelated row change — neither parent-edge:p nor row:childA matches.
    store.invalidate({ rowIds: ['unrelated'] })

    releaseSql()
    await vi.waitFor(() => expect(h.status()).toBe('ready'))
    // Drain the microtask queue to confirm no second run was scheduled.
    await Promise.resolve()
    await Promise.resolve()
    expect(runs).toBe(1)
  })

  it('coalesces queued changes alongside upfront-matched changes (single rerun)', async () => {
    const store = makeStore()
    let releaseSql!: () => void
    let value = 1
    let runs = 0
    const h = store.getOrCreate('q', () =>
      new LoaderHandle<number>({
        store,
        key: 'q',
        loader: async (ctx) => {
          runs++
          ctx.depend({ kind: 'parent-edge', parentId: 'p' })
          if (runs === 1) {
            await new Promise<void>((r) => { releaseSql = r })
          }
          ctx.depend({ kind: 'row', id: 'childA' })
          return value
        },
      }),
    )
    h.subscribe(() => {})
    await vi.waitFor(() => expect(h.status()).toBe('loading'))

    // One match against the upfront dep (sets pendingReinvalidate via
    // invalidate()), one queued match (would set pendingReinvalidate
    // again on settle). Together they must produce ONE rerun, not two.
    value = 2
    store.invalidate({ parentIds: ['p'] }) // matches upfront → pendingReinvalidate = true
    store.invalidate({ rowIds: ['childA'] }) // queued → matches post-load dep

    releaseSql()
    await vi.waitFor(() => expect(runs).toBe(2))
    await Promise.resolve()
    await Promise.resolve()
    expect(runs).toBe(2)
  })

  it('queue is discarded on load failure (deps were rolled back too)', async () => {
    const store = makeStore()
    let releaseSql!: () => void
    let runs = 0
    let shouldFail = true
    const h = store.getOrCreate('q', () =>
      new LoaderHandle<number>({
        store,
        key: 'q',
        loader: async (ctx) => {
          runs++
          ctx.depend({ kind: 'parent-edge', parentId: 'p' })
          if (runs === 1) {
            await new Promise<void>((r) => { releaseSql = r })
          }
          // Per-row dep would have been declared after the await on a
          // success path; on the failure path we throw before reaching it.
          if (shouldFail) throw new Error('boom')
          ctx.depend({ kind: 'row', id: 'childA' })
          return 7
        },
      }),
    )
    h.subscribe(() => {})
    await vi.waitFor(() => expect(h.status()).toBe('loading'))

    // Queue a change that would have matched a (never-declared) row dep.
    store.invalidate({ rowIds: ['childA'] })
    releaseSql()
    await vi.waitFor(() => expect(h.status()).toBe('error'))

    // The errored load discards `changesDuringLoad` along with the
    // partial deps. A future rerun must not fire spuriously off the
    // queue from the failed run.
    shouldFail = false
    await Promise.resolve()
    await Promise.resolve()
    expect(runs).toBe(1)
  })
})

describe('HandleStore metrics counters', () => {
  it('starts at zero', () => {
    const store = makeStore()
    expect(store.metrics.snapshot()).toEqual({
      invalidations: 0,
      handlesWalked: 0,
      handlesMatched: 0,
      loaderInvalidations: 0,
      loaderRuns: 0,
      midLoadInvalidations: 0,
      reloadsAfterSettle: 0,
      notifiesSkippedByDiff: 0,
      notifiesFired: 0,
    })
  })

  it('counts loaderRuns on cold load', async () => {
    const store = makeStore()
    const { loader } = collectingLoader([1, 2])
    const h = store.getOrCreate('q', () => new LoaderHandle({ store, key: 'q', loader }))
    await h.load()
    expect(store.metrics.loaderRuns).toBe(1)
  })

  it('counts handlesWalked + handlesMatched on invalidate (one match in N)', async () => {
    const store = makeStore()
    // Three handles: A and B depend on row r1; C on row r2. Invalidating
    // r1 walks all three but matches only two.
    for (const [k, depId] of [['a', 'r1'], ['b', 'r1'], ['c', 'r2']] as const) {
      const { loader } = collectingLoader(k, [{ kind: 'row', id: depId }])
      const h = store.getOrCreate(k, () => new LoaderHandle({ store, key: k, loader }))
      await h.load()
    }
    store.metrics.reset()
    store.invalidate({ rowIds: ['r1'] })
    expect(store.metrics.invalidations).toBe(1)
    expect(store.metrics.handlesWalked).toBe(3)
    expect(store.metrics.handlesMatched).toBe(2)
    expect(store.metrics.loaderInvalidations).toBe(2)
  })

  it('does not count empty-store / empty-change invalidate calls', () => {
    const store = makeStore()
    // Empty store
    store.invalidate({ rowIds: ['x'] })
    expect(store.metrics.invalidations).toBe(0)
    expect(store.metrics.handlesWalked).toBe(0)
  })

  it('counts midLoadInvalidations + reloadsAfterSettle when invalidate hits inflight', async () => {
    const store = makeStore()
    let release: () => void = () => {}
    let calls = 0
    const h = store.getOrCreate('q', () =>
      new LoaderHandle<number>({
        store,
        key: 'q',
        loader: async (ctx) => {
          calls++
          ctx.depend({ kind: 'row', id: 'r1' })
          // Block on first call so we can fire invalidate while inflight.
          if (calls === 1) await new Promise<void>((r) => { release = r })
          return calls
        },
      }),
    )
    h.subscribe(() => {})
    // Wait until the load is actually inflight before invalidating —
    // store.invalidate dispatches synchronously, so racing it with a
    // not-yet-started loader would test the no-load path instead.
    await vi.waitFor(() => expect(h.status()).toBe('loading'))
    store.invalidate({ rowIds: ['r1'] })
    expect(store.metrics.midLoadInvalidations).toBe(1)
    expect(store.metrics.reloadsAfterSettle).toBe(0) // not until settle
    release()
    await vi.waitFor(() => expect(calls).toBe(2)) // settle + queued reload
    expect(store.metrics.reloadsAfterSettle).toBe(1)
    expect(store.metrics.loaderRuns).toBe(2)
  })

  it('counts notifiesFired vs notifiesSkippedByDiff via structural dedup', async () => {
    const store = makeStore()
    let value: number[] = [1, 2, 3]
    const h = store.getOrCreate('q', () =>
      new LoaderHandle<number[]>({
        store,
        key: 'q',
        loader: async (ctx) => {
          ctx.depend({ kind: 'row', id: 'r1' })
          return value.slice() // fresh array, same contents → equality match
        },
      }),
    )
    h.subscribe(() => {})
    await vi.waitFor(() => expect(h.status()).toBe('ready'))
    expect(store.metrics.notifiesFired).toBe(1) // first load always notifies

    // Re-resolve with structurally-equal value: dedup suppresses notify.
    store.invalidate({ rowIds: ['r1'] })
    await vi.waitFor(() => expect(store.metrics.loaderRuns).toBe(2))
    expect(store.metrics.notifiesSkippedByDiff).toBe(1)
    expect(store.metrics.notifiesFired).toBe(1) // unchanged

    // Now produce a different value and confirm notify fires again.
    value = [1, 2, 3, 4]
    store.invalidate({ rowIds: ['r1'] })
    await vi.waitFor(() => expect(store.metrics.notifiesFired).toBe(2))
    expect(store.metrics.notifiesSkippedByDiff).toBe(1) // unchanged
  })

  it('reset() zeros every counter; snapshot returns frozen plain object', async () => {
    const store = makeStore()
    const { loader } = collectingLoader('x', [{ kind: 'row', id: 'r1' }])
    const h = store.getOrCreate('q', () => new LoaderHandle({ store, key: 'q', loader }))
    await h.load()
    store.invalidate({ rowIds: ['r1'] })
    expect(store.metrics.loaderRuns).toBeGreaterThan(0)

    const before = store.metrics.snapshot()
    expect(Object.isFrozen(before)).toBe(true)
    expect(() => {
      // @ts-expect-error verify the snapshot is read-only at runtime
      before.invalidations = 999
    }).toThrow()

    store.metrics.reset()
    const after = store.metrics.snapshot()
    expect(after.invalidations).toBe(0)
    expect(after.handlesWalked).toBe(0)
    expect(after.loaderRuns).toBe(0)
    // Prior snapshot is unaffected by reset.
    expect(before.loaderRuns).toBeGreaterThan(0)
  })
})
