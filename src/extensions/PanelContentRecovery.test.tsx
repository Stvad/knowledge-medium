// @vitest-environment happy-dom
/**
 * Coverage for the per-panel delete-recovery watchdog (src/extensions/PanelContentRecovery.tsx).
 *
 * Page deletion is deliberately decoupled from navigation — the delete handler
 * just deletes, and this component is what steps a pane off a page that
 * vanished. So "delete a page and end up somewhere sane" rests entirely on
 * WHEN this component decides to call `recoverPanelOffDeadContent` (already
 * covered directly by panelLayoutProjection.test.ts). These tests pin the
 * "when": debounce timing, the tombstone-vs-merely-missing distinction, and
 * the fire-time re-checks that guard against undo / navigation racing the
 * timer.
 *
 * `recoverPanelOffDeadContent` is spied (call-through, real implementation)
 * rather than left un-instrumented: it has its OWN redundant "still stranded"
 * guard, so a state-only assertion (did the panel prop change?) can't tell
 * "the watchdog correctly declined to call it" apart from "the watchdog
 * called it and its own guard no-opped" — the two are indistinguishable from
 * the outside. The call-count spy makes the distinction observable, which is
 * what the debounce/undo/navigate-race tests below actually need to catch a
 * regression in THIS module.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { ChangeScope, type User } from '@/data/api'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { topLevelBlockIdProp } from '@/data/properties'

vi.mock('@/utils/panelHistory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/panelHistory.js')>()
  return {
    ...actual,
    // Call-through spy: real behavior preserved, invocation observable.
    recoverPanelOffDeadContent: vi.fn(actual.recoverPanelOffDeadContent),
  }
})

const {panelHistory, recoverPanelOffDeadContent} = await import('@/utils/panelHistory.js')
const recoverSpy = vi.mocked(recoverPanelOffDeadContent)

const { PanelContentRecovery, RECOVERY_DEBOUNCE_MS } = await import('./PanelContentRecovery.tsx')

const WS = 'ws-1'
const USER: User = {id: 'user-1'}
const PANEL_ID = 'panel'

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const { repo } = createTestRepo({
    db: h.db,
    user: USER,
  })
  repo.setActiveWorkspaceId(WS)
  return {h, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  env = await setup()
  panelHistory.clear(PANEL_ID)
  recoverSpy.mockClear()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks() // clears any per-test setTimeout/clearTimeout spies; leaves the file-level panelHistory.js mock intact
})

const createContentBlocks = async (ids: readonly string[]): Promise<void> => {
  await env.repo.tx(async tx => {
    for (let i = 0; i < ids.length; i++) {
      await tx.create({id: ids[i], workspaceId: WS, parentId: null, orderKey: `${String.fromCharCode(97 + i)}0`, content: ids[i]})
    }
  }, {scope: ChangeScope.BlockDefault, description: 'seed content blocks'})
}

const createPanel = async (topLevelBlockId: string): Promise<void> => {
  await env.repo.tx(async tx => {
    await tx.create({
      id: PANEL_ID,
      workspaceId: WS,
      parentId: null,
      orderKey: 'z0',
      properties: {[topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode(topLevelBlockId)},
    })
  }, {scope: ChangeScope.UiState, description: 'seed panel row'})
}

const panel = () => env.repo.block(PANEL_ID)

/** Spy on the real `setTimeout`/`clearTimeout`, recording both the id AND a
 *  direct reference to the callback for the ONE call matching
 *  `RECOVERY_DEBOUNCE_MS`. Real scheduling is left untouched (the captured
 *  call still delegates to the real `setTimeout`) — this only observes it.
 *
 *  Two independent uses:
 *   - `getId()` + a `clearTimeout` spy lets a test assert the watchdog's own
 *     timer specifically got cleared (case: unmount), rather than inferring
 *     it from the absence of a write (which a leaked-but-harmless timer
 *     would also produce).
 *   - `getCallback()` lets a test invoke the debounce callback directly,
 *     deterministically, INSTEAD of waiting on React's own effect-cleanup
 *     scheduling to race it. React's cleanup (which also clears this same
 *     timer whenever `shownExists`/`topLevelBlockId` changes) reliably wins
 *     that race once the state change is flushed, which would make a
 *     real-elapsed-time test exercise only the cleanup path and never reach
 *     the callback's OWN fire-time re-check — leaving that re-check
 *     un-mutation-tested. Firing the captured reference directly, bypassing
 *     the timer system, isolates it — see `neutralize` for what happens to
 *     the real timer in that case. */
const captureDebounceTimer = ({neutralize = false}: {neutralize?: boolean} = {}): {
  clearSpy: ReturnType<typeof vi.spyOn>
  getId: () => ReturnType<typeof setTimeout> | undefined
  getCallback: () => (() => void) | undefined
} => {
  let capturedId: ReturnType<typeof setTimeout> | undefined
  let capturedCallback: (() => void) | undefined
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const id = originalSetTimeout(fn as never, ms as never, ...(rest as never[]))
    if (ms === RECOVERY_DEBOUNCE_MS) {
      capturedId = id
      capturedCallback = fn as () => void
      // Cancel the real timer the instant it is armed, keeping only the
      // reference to its callback. A test that fires the callback ITSELF owns
      // the whole window between arming and that call — but the real timer is
      // only RECOVERY_DEBOUNCE_MS (120ms) long, and the awaited `repo.tx` such
      // a test performs in between (undo, navigate) can outlast it under CPU
      // contention. The real timer then fires first, against the pre-change
      // state, and recovery legitimately runs: a load-dependent failure of a
      // test that is not about timer duration at all. Cancelled through the
      // ORIGINAL clearTimeout so `clearSpy` still sees only the component's
      // own calls.
      if (neutralize) originalClearTimeout(id)
    }
    return id
  }) as typeof setTimeout)
  const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
  return {clearSpy, getId: () => capturedId, getCallback: () => capturedCallback}
}

describe('PanelContentRecovery', () => {
  it('recovers a block once it is deleted, after the debounce', async () => {
    await createContentBlocks(['a', 'landing'])
    await createPanel('a')
    // A history destination so recovery can land without needing the
    // workspace-landing facet — history-only recovery keeps this focused on
    // the watchdog's own arm/fire decision.
    panelHistory.push(PANEL_ID, {blockId: 'landing'})

    render(<PanelContentRecovery block={panel()} />)
    await act(async () => {}) // let the mount effect run while 'a' is still live

    await env.repo.block('a').delete()

    await vi.waitFor(() => {
      expect(panel().peekProperty(topLevelBlockIdProp)).toBe('landing')
    }, {timeout: 2000})
    expect(recoverSpy).toHaveBeenCalledTimes(1)
  })

  it('does not recover when undo restores the block inside the debounce window', async () => {
    await createContentBlocks(['a', 'landing'])
    await createPanel('a')
    panelHistory.push(PANEL_ID, {blockId: 'landing'})

    const {getCallback} = captureDebounceTimer({neutralize: true})
    render(<PanelContentRecovery block={panel()} />)
    await act(async () => {}) // let the mount effect run while 'a' is still live

    await env.repo.block('a').delete()
    await vi.waitFor(() => expect(getCallback()).toBeDefined())

    // Undo — restores the block while the debounce is still (conceptually)
    // pending.
    await env.repo.tx(tx => tx.restore('a'), {scope: ChangeScope.BlockDefault, description: 'undo delete'})

    // Fire the captured callback directly: the deterministic equivalent of
    // "the debounce timer elapses right now," regardless of whether React's
    // own effect cleanup would also have cancelled it by this point (see
    // captureDebounceTimer's doc). Isolates the callback's own fire-time
    // re-check, which must see the restored, live block and bail.
    getCallback()!()

    expect(recoverSpy).not.toHaveBeenCalled()
    expect(panel().peekProperty(topLevelBlockIdProp)).toBe('a')
    expect(panelHistory.getSnapshot(PANEL_ID).back).toEqual([{blockId: 'landing'}])
  })

  it('does not recover a block never seen live in this pane whose row is simply missing (deep-link protection)', async () => {
    // No block created for 'not-yet-synced' at all — mimics a valid deep
    // link whose row hasn't replicated to this client yet. Moving the pane
    // off it would lose a link that's still syncing, permanently.
    await createContentBlocks(['landing'])
    await createPanel('not-yet-synced')
    panelHistory.push(PANEL_ID, {blockId: 'landing'})

    const {getCallback} = captureDebounceTimer()
    render(<PanelContentRecovery block={panel()} />)

    // Real timers throughout (fake timers armed before the initial mount
    // block the shown.load() -> isBlockTombstoned() DB chain from ever
    // progressing — the passive-effect flush and the SQL round trips need a
    // real macrotask turn that never arrives without an explicit advance,
    // and there's nothing to advance yet). Bound the wait instead of
    // asserting a positive: give the (would-be) armRecovery() call a
    // generous real window, then confirm it never happened.
    await vi.waitFor(() => expect(getCallback()).toBeDefined(), {timeout: 500, interval: 20})
      .catch(() => {/* expected: no timer ever gets armed for a merely-missing row */})

    expect(getCallback()).toBeUndefined()
    expect(recoverSpy).not.toHaveBeenCalled()
    expect(panel().peekProperty(topLevelBlockIdProp)).toBe('not-yet-synced')
    expect(panelHistory.getSnapshot(PANEL_ID).back).toEqual([{blockId: 'landing'}])
  })

  it('recovers a block never seen live in this pane whose row is a real tombstone', async () => {
    await createContentBlocks(['dead', 'landing'])
    await env.repo.block('dead').delete() // tombstoned before this pane ever observes it live
    await createPanel('dead')
    panelHistory.push(PANEL_ID, {blockId: 'landing'})

    render(<PanelContentRecovery block={panel()} />)

    await vi.waitFor(() => {
      expect(panel().peekProperty(topLevelBlockIdProp)).toBe('landing')
    }, {timeout: 2000})
    expect(recoverSpy).toHaveBeenCalledTimes(1)
  })

  it('clears the pending timer on unmount inside the debounce window (no leak, no write)', async () => {
    await createContentBlocks(['a', 'landing'])
    await createPanel('a')
    panelHistory.push(PANEL_ID, {blockId: 'landing'})

    const {clearSpy, getId} = captureDebounceTimer()
    const {unmount} = render(<PanelContentRecovery block={panel()} />)
    await act(async () => {}) // let the mount effect run while 'a' is still live

    await env.repo.block('a').delete()
    // Wait on the timer itself rather than a proxy for it.
    await vi.waitFor(() => expect(getId()).toBeDefined())

    unmount()

    expect(clearSpy).toHaveBeenCalledWith(getId())
    expect(recoverSpy).not.toHaveBeenCalled()
    expect(panel().peekProperty(topLevelBlockIdProp)).toBe('a')
  })

  it('does not recover when the pane navigates to a different block inside the debounce window', async () => {
    await createContentBlocks(['a', 'b', 'landing'])
    await createPanel('a')
    panelHistory.push(PANEL_ID, {blockId: 'landing'})

    const {getCallback} = captureDebounceTimer({neutralize: true})
    render(<PanelContentRecovery block={panel()} />)
    await act(async () => {}) // let the mount effect run while 'a' is still live

    await env.repo.block('a').delete()
    await vi.waitFor(() => expect(getCallback()).toBeDefined())

    // Navigate away while the debounce is still (conceptually) pending.
    await panel().set(topLevelBlockIdProp, 'b')

    // Fire the captured callback directly (see captureDebounceTimer's doc).
    // Its fire-time re-check compares against `topLevelBlockIdProp`'s
    // CURRENT value ('b'), not the 'a' it closed over, and must bail.
    getCallback()!()

    expect(recoverSpy).not.toHaveBeenCalled()
    expect(panel().peekProperty(topLevelBlockIdProp)).toBe('b')
    expect(panelHistory.getSnapshot(PANEL_ID).back).toEqual([{blockId: 'landing'}])
  })
})
