// @vitest-environment happy-dom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { ChangeScope, type User } from '@/data/api'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import {
  focusBlock,
  isEditingProp,
  peekFocusedBlockLocation,
} from '@/data/properties'
import { PanelCursorFollowsScroll } from '../PanelCursorFollowsScroll.tsx'

const WS = 'ws-1'
const USER: User = {id: 'user-1'}
const PANEL_ID = 'panel'
const FENCE_PANEL_ID = 'fence-panel'
const SCOPE = 'panel:page'
const PORT_HEIGHT = 500

const stubRect = (el: HTMLElement, top: number, height: number): void => {
  el.getBoundingClientRect = () => ({
    top, bottom: top + height, left: 0, right: 100, width: 100, height,
    x: 0, y: top, toJSON: () => ({}),
  }) as DOMRect
}

interface PanelDom {
  port: HTMLElement
  /** Move a row's content rect — the test's stand-in for scrolling, since
   *  happy-dom has no layout to move on its own. */
  moveRow: (blockId: string, top: number) => void
  addRow: (blockId: string, top: number) => void
  scroll: () => void
}

const buildPanel = (panelId: string, rows: ReadonlyArray<[string, number]>): PanelDom => {
  const panel = document.createElement('div')
  panel.setAttribute('data-panel-id', panelId)
  const port = document.createElement('div')
  port.style.overflowY = 'auto'
  stubRect(port, 0, PORT_HEIGHT)
  panel.appendChild(port)
  document.body.appendChild(panel)

  const targets = new Map<string, HTMLElement>()
  const addRow = (blockId: string, top: number) => {
    const shell = document.createElement('div')
    shell.setAttribute('data-block-nav-item', 'true')
    shell.setAttribute('data-block-id', blockId)
    shell.setAttribute('data-render-scope-id', SCOPE)
    const target = document.createElement('div')
    target.setAttribute('data-block-visibility-target', 'true')
    stubRect(target, top, 30)
    shell.appendChild(target)
    port.appendChild(shell)
    targets.set(blockId, target)
  }
  for (const [blockId, top] of rows) addRow(blockId, top)

  return {
    port,
    addRow,
    moveRow: (blockId, top) => {
      const target = targets.get(blockId)
      if (target) stubRect(target, top, 30)
    },
    scroll: () => { port.dispatchEvent(new Event('scroll', {bubbles: false})) },
  }
}

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: USER}).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: PANEL_ID, workspaceId: WS, parentId: null, orderKey: 'a0'})
    await tx.create({id: FENCE_PANEL_ID, workspaceId: WS, parentId: null, orderKey: 'a1'})
  }, {scope: ChangeScope.UiState})
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

/** A second panel whose cursor IS scrolled away, mounted alongside the subject.
 *  Its re-anchor lands on the same scroll event and the same settle delay, so
 *  once it has fired the subject has demonstrably had its turn — the negative
 *  assertions below are observations, not races with the property
 *  subscription. */
const withFence = async () => {
  const fencePanel = repo.block(FENCE_PANEL_ID)
  const dom = buildPanel(FENCE_PANEL_ID, [['fence-a', 20], ['fence-b', 200]])
  await focusBlock(fencePanel, 'fence-a', {renderScopeId: SCOPE})
  return {
    fencePanel,
    scrollAway: () => {
      dom.moveRow('fence-a', -400)
      dom.moveRow('fence-b', 20)
      dom.scroll()
    },
    settled: () => vi.waitFor(() => {
      expect(peekFocusedBlockLocation(fencePanel)?.blockId).toBe('fence-b')
    }),
  }
}

describe('PanelCursorFollowsScroll', () => {
  it('moves the cursor to the top visible row when it is scrolled out of view', async () => {
    const panel = repo.block(PANEL_ID)
    const dom = buildPanel(PANEL_ID, [['a', 20], ['b', 200]])
    await focusBlock(panel, 'a', {renderScopeId: SCOPE})

    render(<PanelCursorFollowsScroll block={panel}/>)

    dom.moveRow('a', -400)
    dom.moveRow('b', 20)
    dom.scroll()

    await vi.waitFor(() => {
      expect(peekFocusedBlockLocation(panel)).toEqual({blockId: 'b', renderScopeId: SCOPE})
    })
  })

  it('leaves a cursor that is still on screen alone', async () => {
    const panel = repo.block(PANEL_ID)
    const dom = buildPanel(PANEL_ID, [['a', 20], ['b', 200]])
    await focusBlock(panel, 'b', {renderScopeId: SCOPE})
    const fence = await withFence()

    render(
      <>
        <PanelCursorFollowsScroll block={panel}/>
        <PanelCursorFollowsScroll block={fence.fencePanel}/>
      </>,
    )

    // The panel scrolled, but not far enough to take the cursor off screen.
    dom.moveRow('a', -200)
    dom.moveRow('b', 40)
    dom.scroll()
    fence.scrollAway()

    await fence.settled()
    expect(peekFocusedBlockLocation(panel)?.blockId).toBe('b')
  })

  // Keyboard navigation to a row below the fold writes focus FIRST and the
  // decorator scrolls it in after. Reacting to the scroll that catch-up
  // produces would re-anchor onto whatever is currently on screen and cancel
  // the move the user just made.
  it('does not fight a scroll that is bringing the cursor into view', async () => {
    const panel = repo.block(PANEL_ID)
    // `mid` is the trap: it IS on screen throughout the catch-up, so anything
    // that re-anchors on geometry alone lands there and strands the move.
    const dom = buildPanel(PANEL_ID, [['a', 20], ['mid', 300], ['b', 900]])
    // Focus lands on a row that is off screen and stays off screen for the
    // first part of the catch-up scroll.
    await focusBlock(panel, 'b', {renderScopeId: SCOPE})
    const fence = await withFence()

    render(
      <>
        <PanelCursorFollowsScroll block={panel}/>
        <PanelCursorFollowsScroll block={fence.fencePanel}/>
      </>,
    )

    dom.moveRow('a', -300)
    dom.moveRow('mid', 100)
    dom.moveRow('b', 600)
    dom.scroll()
    fence.scrollAway()

    await fence.settled()
    expect(peekFocusedBlockLocation(panel)?.blockId).toBe('b')
  })

  // ...but once the catch-up has landed, the row is a normal cursor again.
  it('starts following once the cursor has been on screen', async () => {
    const panel = repo.block(PANEL_ID)
    const dom = buildPanel(PANEL_ID, [['a', 20], ['b', 900]])
    await focusBlock(panel, 'b', {renderScopeId: SCOPE})

    render(<PanelCursorFollowsScroll block={panel}/>)

    // Catch-up lands: `b` is on screen.
    dom.moveRow('a', -800)
    dom.moveRow('b', 100)
    dom.scroll()

    // Now the user scrolls back up, taking `b` off the bottom.
    dom.moveRow('a', 20)
    dom.moveRow('b', 900)
    dom.scroll()

    await vi.waitFor(() => {
      expect(peekFocusedBlockLocation(panel)?.blockId).toBe('a')
    })
  })

  // On a cold load the cursor's row often doesn't exist when this mounts —
  // it's a deferred placeholder waiting on `FocusedRowLazyMount`. If nothing
  // watches for its arrival, one coarse gesture (a scrollbar drag, a fling) can
  // take it from never-sampled straight to off-screen, where it is
  // indistinguishable from a cursor the app is still scrolling toward — and
  // following stays off until focus changes.
  it('notices a cursor row that mounts after it starts watching', async () => {
    const panel = repo.block(PANEL_ID)
    const dom = buildPanel(PANEL_ID, [['a', 20]])
    await focusBlock(panel, 'late', {renderScopeId: SCOPE})

    render(<PanelCursorFollowsScroll block={panel}/>)

    // The row hydrates, on screen, with no scroll event anywhere near it.
    dom.addRow('late', 200)
    // Drain to the next macrotask rather than sleeping: MutationObserver
    // delivers on the microtask checkpoint, so one turn of the loop is a
    // guarantee the watcher has run, not a bet on how loaded the machine is.
    // It has to have run BEFORE the scroll below — that scroll is one-shot, and
    // after it the row is off screen, where no later sample can help.
    await new Promise(resolve => setTimeout(resolve, 0))

    // One coarse gesture takes it straight off screen.
    dom.moveRow('a', 40)
    dom.moveRow('late', 900)
    dom.scroll()

    await vi.waitFor(() => {
      expect(peekFocusedBlockLocation(panel)?.blockId).toBe('a')
    })
  })

  // Outcome test, NOT a pin on the location re-check inside `settle`: what
  // satisfies it here is the effect cleanup cancelling the armed timer, and
  // removing that re-check fails nothing. The re-check covers the ordering
  // where the timer is already due when the move lands, which the cleanup
  // cannot win and a test cannot stage — see the comment at the re-check.
  it('keeps a cursor that moved while the scroll was settling', async () => {
    const panel = repo.block(PANEL_ID)
    const dom = buildPanel(PANEL_ID, [['a', 20], ['b', 200], ['c', 900]])
    await focusBlock(panel, 'b', {renderScopeId: SCOPE})
    const fence = await withFence()

    render(
      <>
        <PanelCursorFollowsScroll block={panel}/>
        <PanelCursorFollowsScroll block={fence.fencePanel}/>
      </>,
    )

    // Scroll `b` out of view — the settle timer is now armed for `b`.
    dom.moveRow('a', -400)
    dom.moveRow('b', -100)
    dom.moveRow('c', 40)
    dom.scroll()
    fence.scrollAway()

    // The user presses `j` before the timer fires: the cursor is now `c`, and
    // the pending timer still holds `b`.
    await focusBlock(panel, 'c', {renderScopeId: SCOPE})

    await fence.settled()
    expect(peekFocusedBlockLocation(panel)?.blockId).toBe('c')
  })

  // The refusal above is a DEFERRAL, not a drop: scroll the open editor off
  // screen, press Escape without scrolling again, and the cursor must catch up.
  // The first attempt at this was inert — it re-ran the effect, which resets
  // `seenOnScreen`, and the row is off screen in exactly this scenario.
  it('catches up when the editor closes after being scrolled off screen', async () => {
    const panel = repo.block(PANEL_ID)
    const dom = buildPanel(PANEL_ID, [['a', 20], ['b', 200]])
    await focusBlock(panel, 'a', {renderScopeId: SCOPE, edit: true})
    expect(panel.peekProperty(isEditingProp)).toBe(true)

    render(<PanelCursorFollowsScroll block={panel}/>)

    // Scrolling with the editor open is refused — the cursor stays on `a`.
    dom.moveRow('a', -400)
    dom.moveRow('b', 20)
    dom.scroll()
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(peekFocusedBlockLocation(panel)?.blockId).toBe('a')

    // Escape, with no further scrolling.
    await panel.set(isEditingProp, false)

    await vi.waitFor(() => {
      expect(peekFocusedBlockLocation(panel)?.blockId).toBe('b')
    })
  })

  // A fast scroll outruns lazy mounting: the rows now filling the viewport are
  // still placeholders when the settle fires. Dropping that attempt strands the
  // cursor off screen, because a row mounting need not move `scrollTop` and so
  // nothing schedules another.
  it('retries when the rows that scrolled into view have not mounted yet', async () => {
    const panel = repo.block(PANEL_ID)
    const dom = buildPanel(PANEL_ID, [['a', 20]])
    await focusBlock(panel, 'a', {renderScopeId: SCOPE})

    render(<PanelCursorFollowsScroll block={panel}/>)

    // The cursor leaves, and nothing else is rendered yet to anchor to.
    dom.moveRow('a', -400)
    dom.scroll()
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(peekFocusedBlockLocation(panel)?.blockId).toBe('a')

    // The destination row mounts, with no scroll event of its own.
    dom.addRow('b', 20)

    await vi.waitFor(() => {
      expect(peekFocusedBlockLocation(panel)?.blockId).toBe('b')
    }, {timeout: 2000})
  })

  // `focusBlock` only preserves edit mode for an unchanged location, so
  // re-anchoring mid-edit closes the editor under the user — which is what
  // scrolling with the on-screen keyboard up would otherwise do on a phone.
  it('does not move the cursor while the panel is in edit mode', async () => {
    const panel = repo.block(PANEL_ID)
    const dom = buildPanel(PANEL_ID, [['a', 20], ['b', 200]])
    await focusBlock(panel, 'a', {renderScopeId: SCOPE, edit: true})
    expect(panel.peekProperty(isEditingProp)).toBe(true)
    const fence = await withFence()

    render(
      <>
        <PanelCursorFollowsScroll block={panel}/>
        <PanelCursorFollowsScroll block={fence.fencePanel}/>
      </>,
    )

    dom.moveRow('a', -400)
    dom.moveRow('b', 20)
    dom.scroll()
    fence.scrollAway()

    await fence.settled()
    expect(peekFocusedBlockLocation(panel)?.blockId).toBe('a')
    expect(panel.peekProperty(isEditingProp)).toBe(true)
  })
})
