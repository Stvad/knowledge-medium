// @vitest-environment happy-dom
/**
 * Regression test for the dead-handle trap that `<Activity mode="hidden">`
 * exposes (docs/handle-lifecycle-hidden-subtrees.html).
 *
 * The failure needs TWO handle deaths, and that is the whole difficulty of
 * writing this test:
 *
 *   1. Hiding unmounts effects, so the subscription is released and the
 *      handle is GC'd. On its own this is survivable — React's own
 *      `updateStoreInstance` effect re-reads the snapshot on reconnect, sees
 *      it change from data to the consumer's empty sentinel, and forces the
 *      render that re-acquires. A single hide/GC/reveal cycle therefore
 *      passes with or without the fix and pins NOTHING.
 *   2. The kill is the second death: while still hidden, something
 *      re-renders the subtree (here, an ancestor context change — the same
 *      shape as a session host swapping a context value in the commit that
 *      hides a lane). That render acquires a fresh handle which nothing can
 *      retain, because effects do not run in a hidden tree, so it too is
 *      GC'd. Now both snapshots either side of the reveal are the same
 *      frozen sentinel, React forces nothing, and the reconnected
 *      subscription attaches to a corpse.
 *
 * `expect(created).toBeGreaterThanOrEqual(2)` before the reveal is load-bearing:
 * it asserts the second death actually happened. Without it, a React version
 * that declined to render the hidden subtree would quietly reduce this to
 * case 1 and the test would pass while pinning nothing.
 */
import { describe, expect, it } from 'vitest'
import { Activity, createContext, memo, useContext } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import { HandleStore, LoaderHandle } from '@/data/internals/handleStore'
import { useHandle } from '@/hooks/block'

const KEY = 'test:rows'

/** Stand-in for a consumer's "not loaded" sentinel (LayoutRenderer's frozen
 *  EMPTY_ROWS is the real one). Its stable identity is what makes the
 *  post-reveal snapshot compare equal to the pre-reveal one. */
const EMPTY: readonly number[] = Object.freeze([])

const TickContext = createContext(0)

const manualScheduler = () => {
  type Pending = { id: number; cb: () => void; due: number }
  let now = 0
  let nextId = 1
  const queue: Pending[] = []
  return {
    schedule(cb: () => void, ms: number) {
      const entry: Pending = { id: nextId++, cb, due: now + ms }
      queue.push(entry)
      return () => {
        const i = queue.findIndex(q => q.id === entry.id)
        if (i >= 0) queue.splice(i, 1)
      }
    },
    flush(ms: number) {
      now += ms
      while (true) {
        const i = queue.findIndex(q => q.due <= now)
        if (i < 0) break
        const [{ cb }] = queue.splice(i, 1)
        cb()
      }
    },
  }
}

describe('useHandle re-acquires a disposed handle', () => {
  it('recovers after a hidden subtree outlives two handle GCs', async () => {
    const sched = manualScheduler()
    const store = new HandleStore({ gcTimeMs: 100, schedule: sched.schedule })
    let created = 0
    const loader = async () => [1, 2, 3]
    const acquire = () => {
      return store.getOrCreate(KEY, () => {
        created++
        return new LoaderHandle({ store, key: KEY, loader })
      })
    }

    // memo + stable element identity so REVEALING the lane bails out instead
    // of re-rendering the consumer. That is what makes this faithful: in the
    // live app the reveal is a bailout (nothing about the subtree's props
    // changed), so the consumer never re-runs its factory and never discovers
    // that the handle it holds is dead. A test that lets the reveal re-render
    // the consumer heals through that render and pins nothing.
    const Consumer = memo(() => {
      // Read the context so a change to it marks this component dirty even
      // while it sits inside a hidden Activity boundary.
      useContext(TickContext)
      const value = useHandle(acquire(), { selector: v => (v as number[] | undefined) ?? EMPTY })
      return <div data-testid="out">{value.length}</div>
    })

    const consumerElement = <Consumer/>
    const Harness = ({ hidden, tick }: { hidden: boolean; tick: number }) => (
      <TickContext.Provider value={tick}>
        <Activity mode={hidden ? 'hidden' : 'visible'}>
          {consumerElement}
        </Activity>
      </TickContext.Provider>
    )

    const { rerender } = render(<Harness hidden={false} tick={0}/>)
    await act(async () => {})
    expect(screen.getByTestId('out').textContent).toBe('3')
    const createdWhileVisible = created

    // Hide: effects unmount, the subscription is released, GC is scheduled.
    rerender(<Harness hidden tick={0}/>)
    await act(async () => {})
    sched.flush(100)      // first death

    // Re-render the STILL-HIDDEN subtree via an ancestor context change. This
    // acquires a replacement handle that no effect can retain.
    rerender(<Harness hidden tick={1}/>)
    await act(async () => {})
    // Must hold BEFORE the reveal: the replacement handle has to be acquired
    // while the subtree is still hidden (so nothing retains it). Asserting
    // this after the reveal would be satisfied by the reveal's own render and
    // the test would pass vacuously.
    expect(created).toBeGreaterThan(createdWhileVisible)
    sched.flush(100)      // second death — the one that defeats React's self-heal

    // Reveal. The reconnected subscription lands on a disposed handle; only
    // `useHandle` forcing a re-acquiring render gets the data back.
    rerender(<Harness hidden={false} tick={1}/>)
    // waitFor, not a counted number of act() flushes: how many render passes
    // the recovery takes is React's business, and pinning it to a count made
    // this flake roughly 1 run in 20 under a loaded suite.
    await waitFor(() => expect(screen.getByTestId('out').textContent).toBe('3'))
  })

  it('recovers on a fresh mount that is handed an already-disposed handle', async () => {
    // Pins the ensure-load guard on its own. The reveal case above is
    // recovered by either guard, so without this test neither one is
    // individually pinned and one could be deleted unnoticed.
    const sched = manualScheduler()
    const store = new HandleStore({ gcTimeMs: 100, schedule: sched.schedule })
    const loader = async () => [1, 2, 3]
    const acquire = () => store.getOrCreate(KEY, () => new LoaderHandle({ store, key: KEY, loader }))

    // Create and immediately abandon a handle: never retained, so the
    // constructor's GC sweep disposes it.
    acquire()
    sched.flush(100)

    const Consumer = () => {
      const value = useHandle(acquire(), { selector: v => (v as number[] | undefined) ?? EMPTY })
      return <div data-testid="fresh">{value.length}</div>
    }
    render(<Consumer/>)
    await waitFor(() => expect(screen.getByTestId('fresh').textContent).toBe('3'))
  })

  it('gives up instead of spinning when the factory mints a fresh dead handle each render', async () => {
    // The shape that actually loops: every render hands useHandle a NEW
    // disposed handle, so its deps change and the guard re-fires each time.
    // The attempt cap is the only thing that ends it. The explicit throw
    // keeps a regression here a fast failure rather than a hung run.
    const sched = manualScheduler()
    const store = new HandleStore({ gcTimeMs: 100, schedule: sched.schedule })
    const loader = async () => [1, 2, 3]
    let seq = 0
    const freshDeadHandle = () => {
      const key = `dead:${seq++}`
      const h = store.getOrCreate(key, () => new LoaderHandle({ store, key, loader }))
      h.dispose()
      return h
    }
    let renders = 0
    const Consumer = () => {
      renders++
      if (renders > 50) throw new Error(`render loop: ${renders} renders on dead handles`)
      const value = useHandle(freshDeadHandle(), { selector: v => (v as number[] | undefined) ?? EMPTY })
      return <div data-testid="spin">{value.length}</div>
    }
    render(<Consumer/>)
    await act(async () => {})
    await act(async () => {})
    expect(renders).toBeLessThan(20)
  })

  it('gives up instead of spinning when the factory cannot replace a dead handle', async () => {
    // A caller that memoizes its handle hands back the same corpse forever.
    // Re-acquiring can't help, so useHandle must stop asking rather than
    // drive an unbounded render loop. The explicit throw keeps a regression
    // here a fast failure instead of a hung test run.
    const sched = manualScheduler()
    const store = new HandleStore({ gcTimeMs: 100, schedule: sched.schedule })
    const loader = async () => [1, 2, 3]
    const dead = store.getOrCreate(KEY, () => new LoaderHandle({ store, key: KEY, loader }))
    sched.flush(100)
    expect(dead.status()).toBe('disposed')

    let renders = 0
    const Consumer = () => {
      renders++
      if (renders > 50) throw new Error(`render loop: ${renders} renders on a dead handle`)
      const value = useHandle(dead, { selector: v => (v as number[] | undefined) ?? EMPTY })
      return <div data-testid="stuck">{value.length}</div>
    }
    render(<Consumer/>)
    await act(async () => {})
    await act(async () => {})
    expect(renders).toBeLessThan(10)
    expect(screen.getByTestId('stuck').textContent).toBe('0')
  })
})
