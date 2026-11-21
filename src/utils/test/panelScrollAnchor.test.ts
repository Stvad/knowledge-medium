// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  alignRowToScrollportTop,
  alignScrollportToRow,
  findAnchorRow,
} from '@/utils/panelScrollAnchor.js'

const LOCATION = {blockId: 'row-b', renderScopeId: 'panel:page'}

/**
 * A budget ladder for a worker that gets FROZEN rather than merely slowed:
 * aligner deadlines the test must outrun > the test's own budget > every
 * `vi.waitFor` > what the tests need (~300ms at the slowest, ~2s for the file).
 *
 * The ORDER is the invariant. A freeze leaves every timer overdue at once and
 * they then fire in expiry order, so the smallest budget decides what the
 * failure looks like — on the defaults `vi.waitFor` rejects before its next poll
 * can read a value that is by then already correct. Keep the test's own clock
 * the first to expire and a stalled worker reports an honest timeout instead of
 * a wrong value or a guard that quietly stopped applying.
 */
const TEST_BUDGET_MS = 20_000
/** Under `TEST_BUDGET_MS`, so a real failure still reports its own assertion
 *  rather than an opaque test timeout. `vi.waitFor` defaults to 1000ms. */
const POLL_BUDGET_MS = 10_000
/** Over `TEST_BUDGET_MS`, for an aligner deadline the test has to outrun.
 *  Defence, but the failure it prevents is the silent one: a negative test whose
 *  subject has already given up stays green while asserting nothing. Tests that
 *  don't sleep before the aligner has to act are left on the real defaults, so
 *  those stay covered — see `waits for a row that mounts later`. */
const NEVER_MS = 60_000

/** Same polling budget at every call site — `vi.waitFor` defaults to 1000ms. */
const waitFor = (assertion: () => void) => vi.waitFor(assertion, {timeout: POLL_BUDGET_MS})

const rectAt = (top: number, height: number) => ({
  top, bottom: top + height, left: 0, right: 100, width: 100, height,
  x: 0, y: top, toJSON: () => ({}),
}) as DOMRect

interface Harness {
  port: HTMLElement
  /** Add a row at `layoutTop` — its offset within the scrolled content, NOT its
   *  screen position. */
  addRow: (blockId: string, renderScopeId: string, layoutTop: number) => HTMLElement
  /** Move a row within the content, as a growing element above it would. */
  moveRow: (row: HTMLElement, layoutTop: number) => void
}

/**
 * happy-dom never lays out, so rects have to be modelled. Modelled as a real
 * scrollport: a row's screen position is its layout offset MINUS the port's
 * scrollTop. Rects that ignore scrollTop would make every alignment look like
 * it had no effect, so a re-aligning caller would keep adding the same
 * correction — an artifact of the harness rather than of the code.
 */
const build = (portTop = 100): Harness => {
  const panel = document.createElement('div')
  panel.setAttribute('data-panel-id', 'panel')
  const port = document.createElement('div')
  port.style.overflowY = 'auto'
  port.getBoundingClientRect = () => rectAt(portTop, 600)
  panel.appendChild(port)
  document.body.appendChild(panel)

  const layoutTops = new Map<HTMLElement, number>()
  const place = (row: HTMLElement, layoutTop: number) => {
    layoutTops.set(row, layoutTop)
    row.getBoundingClientRect = () => rectAt((layoutTops.get(row) ?? 0) - port.scrollTop + portTop, 30)
  }

  return {
    port,
    moveRow: place,
    addRow: (blockId, renderScopeId, layoutTop) => {
      const row = document.createElement('div')
      row.setAttribute('data-block-id', blockId)
      row.setAttribute('data-render-scope-id', renderScopeId)
      place(row, layoutTop)
      port.appendChild(row)
      return row
    },
  }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('findAnchorRow', () => {
  it('prefers the row whose render scope matches', () => {
    const {port, addRow} = build()
    addRow('row-b', 'some-other-scope', 200)
    const exact = addRow('row-b', 'panel:page', 300)

    expect(findAnchorRow(port, LOCATION)).toEqual({row: exact, exact: true})
  })

  // A scope id can shift under a stored location — the legacy `outline:`
  // rewrite does exactly that, asynchronously, on the same mount that restores.
  it('falls back to the block id when no scope matches', () => {
    const {port, addRow} = build()
    const drifted = addRow('row-b', 'outline:page', 300)

    expect(findAnchorRow(port, LOCATION)).toEqual({row: drifted, exact: false})
  })

  it('ignores rows belonging to another panel', () => {
    const {port} = build()
    const otherPanel = document.createElement('div')
    otherPanel.setAttribute('data-panel-id', 'other')
    const stray = document.createElement('div')
    stray.setAttribute('data-block-id', 'row-b')
    stray.setAttribute('data-render-scope-id', 'panel:page')
    otherPanel.appendChild(stray)
    port.appendChild(otherPanel)

    expect(findAnchorRow(port, LOCATION)).toBeNull()
  })
})

describe('alignRowToScrollportTop', () => {
  it('scrolls the port by the row-to-port distance', () => {
    const {port, addRow} = build(100)
    const row = addRow('row-b', 'panel:page', 300)
    port.scrollTop = 0

    expect(alignRowToScrollportTop(row)).toBe(port)
    expect(port.scrollTop).toBe(300)
  })

  it('leaves the port alone when the row is already at the top', () => {
    const {port, addRow} = build(100)
    const row = addRow('row-b', 'panel:page', 42)
    port.scrollTop = 42

    expect(alignRowToScrollportTop(row)).toBe(port)
    expect(port.scrollTop).toBe(42)
  })
})

describe('alignScrollportToRow', {timeout: TEST_BUDGET_MS}, () => {
  it('aligns a row that is already rendered', () => {
    const {port, addRow} = build(100)
    addRow('row-b', 'panel:page', 300)
    port.scrollTop = 0

    const cancel = alignScrollportToRow(port, LOCATION)
    expect(port.scrollTop).toBe(300)
    cancel()
  })

  // The anchor row is a lazy placeholder on arrival — `FocusedRowLazyMount`
  // forces it, which resolves over a few commits. Measuring once would measure
  // an empty tree.
  it('waits for a row that mounts later', async () => {
    const {port, addRow} = build(100)
    port.scrollTop = 0

    const cancel = alignScrollportToRow(port, LOCATION, {waitMs: NEVER_MS})
    expect(port.scrollTop).toBe(0)

    addRow('row-b', 'panel:page', 300)

    await waitFor(() => {
      expect(port.scrollTop).toBe(300)
    })
    cancel()
  })

  // The floor under ROW_WAIT_MS: `PanelRenderer` passes no options, and every
  // other async test overrides `waitMs`, so nothing else would notice the
  // default being cut below the hydration it exists to cover. Deliberately off
  // the ladder above — running on the real default is the whole point, and it
  // stays freeze-tolerant because 400ms and 2000ms keep their relative order
  // however late they both fire.
  it('still honours an anchor that hydrates hundreds of ms late', async () => {
    const {port, addRow} = build(100)
    port.scrollTop = 0

    const cancel = alignScrollportToRow(port, LOCATION)

    await new Promise(resolve => setTimeout(resolve, 400))
    addRow('row-b', 'panel:page', 300)

    await waitFor(() => {
      expect(port.scrollTop).toBe(300)
    })
    cancel()
  })

  // Rows that were briefly on screen before the restore keep mounting and grow
  // the document above the anchor, sliding it back down.
  it('re-applies the alignment while the page above keeps growing', async () => {
    const {port, addRow, moveRow} = build(100)
    port.scrollTop = 0
    const row = addRow('row-b', 'panel:page', 300)

    const cancel = alignScrollportToRow(port, LOCATION, {realignWindowMs: NEVER_MS, waitMs: NEVER_MS})
    expect(port.scrollTop).toBe(300)

    // Content lands above the anchor: the row is now 150px further down.
    moveRow(row, 450)
    port.appendChild(document.createElement('div'))

    await waitFor(() => {
      expect(port.scrollTop).toBe(450)
    })
    cancel()
  })

  // Not every shift announces itself as a mutation: an image above the anchor
  // that was already in the DOM at zero height pushes it down when it decodes.
  it('re-applies the alignment after a geometry-only shift', async () => {
    const {port, addRow, moveRow} = build(100)
    port.scrollTop = 0
    const row = addRow('row-b', 'panel:page', 300)

    const cancel = alignScrollportToRow(port, LOCATION, {realignWindowMs: NEVER_MS, waitMs: NEVER_MS})
    expect(port.scrollTop).toBe(300)

    // No DOM change at all — just something above it growing.
    moveRow(row, 460)

    await waitFor(() => {
      expect(port.scrollTop).toBe(460)
    })
    cancel()
  })

  // Keyboard scrolling (PageDown, Space) is a takeover like any other, and it
  // can happen while the anchor row is still hydrating.
  it('gives up when a key is pressed inside this panel', async () => {
    const {port, addRow} = build(100)
    port.scrollTop = 0

    const cancel = alignScrollportToRow(port, LOCATION, {waitMs: NEVER_MS})
    port.dispatchEvent(new Event('keydown', {bubbles: true}))
    addRow('row-b', 'panel:page', 300)

    const fence = build(100)
    const fenceCancel = alignScrollportToRow(fence.port, LOCATION, {waitMs: NEVER_MS})
    fence.addRow('row-b', 'panel:page', 300)
    await waitFor(() => {
      expect(fence.port.scrollTop).toBe(300)
    })
    fenceCancel()

    expect(port.scrollTop).toBe(0)
    cancel()
  })

  // ...but a keystroke in ANOTHER pane must not. During a multi-pane cold load
  // several restores are pending at once, and typing in the one that is ready
  // would otherwise strand all the others at the wrong position.
  it('ignores a keystroke aimed at a different panel', async () => {
    const {port, addRow} = build(100)
    port.scrollTop = 0
    const elsewhere = build(100)

    const cancel = alignScrollportToRow(port, LOCATION, {waitMs: NEVER_MS})
    elsewhere.port.dispatchEvent(new Event('keydown', {bubbles: true}))
    addRow('row-b', 'panel:page', 300)

    await waitFor(() => {
      expect(port.scrollTop).toBe(300)
    })
    cancel()
  })

  // Dragging the native scrollbar emits neither `wheel` nor `touchmove`, so the
  // only evidence is the port moving off the offset we left it at.
  it('gives up when the port is scrolled by someone else', async () => {
    const {port, addRow, moveRow} = build(100)
    port.scrollTop = 0
    const row = addRow('row-b', 'panel:page', 300)

    const cancel = alignScrollportToRow(port, LOCATION, {realignWindowMs: NEVER_MS, waitMs: NEVER_MS})
    expect(port.scrollTop).toBe(300)

    // The user drags the scrollbar somewhere else.
    port.scrollTop = 900
    port.dispatchEvent(new Event('scroll'))

    // Content above the anchor then settles, which would otherwise pull it back.
    moveRow(row, 450)
    await new Promise(resolve => setTimeout(resolve, 200))

    expect(port.scrollTop).toBe(900)
    cancel()
  })

  it('stops correcting once cancelled', async () => {
    const {port, addRow} = build(100)
    port.scrollTop = 0

    const cancel = alignScrollportToRow(port, LOCATION)
    cancel()
    addRow('row-b', 'panel:page', 300)

    // Fence on a second aligner that IS live: once it has reacted to a
    // mutation, the cancelled one has demonstrably had its turn.
    const fence = build(100)
    const fenceCancel = alignScrollportToRow(fence.port, LOCATION, {waitMs: NEVER_MS})
    fence.addRow('row-b', 'panel:page', 300)
    await waitFor(() => {
      expect(fence.port.scrollTop).toBe(300)
    })
    fenceCancel()

    expect(port.scrollTop).toBe(0)
  })

  // A cold load can push the correction window past the point where the user
  // has taken over; yanking someone mid-scroll is worse than a slightly off
  // anchor.
  it('gives up the correction window on a user gesture', async () => {
    const {port, addRow, moveRow} = build(100)
    port.scrollTop = 0
    const row = addRow('row-b', 'panel:page', 300)

    const cancel = alignScrollportToRow(port, LOCATION, {realignWindowMs: NEVER_MS, waitMs: NEVER_MS})
    expect(port.scrollTop).toBe(300)

    port.dispatchEvent(new Event('wheel'))
    moveRow(row, 450)
    port.appendChild(document.createElement('div'))

    const fence = build(100)
    const fenceCancel = alignScrollportToRow(fence.port, LOCATION, {waitMs: NEVER_MS})
    fence.addRow('row-b', 'panel:page', 300)
    await waitFor(() => {
      expect(fence.port.scrollTop).toBe(300)
    })
    fenceCancel()

    expect(port.scrollTop).toBe(300)
    cancel()
  })
})

describe('alignScrollportToRow — whose scrollport it is', {timeout: TEST_BUDGET_MS}, () => {
  // A stack shares ONE `overflow-y-auto` across several panes, each of whose own
  // container is `overflow-visible`. If every pane aligned that shared port to
  // its own cursor, the stack would land wherever the last pane restored, and
  // their takeover listeners would read each other's alignments as the user.
  it('does not move a scrollport the panel does not own', () => {
    const stack = document.createElement('div')
    stack.style.overflowY = 'auto'
    stack.getBoundingClientRect = () => rectAt(0, 600)
    document.body.appendChild(stack)

    const panel = document.createElement('div')
    panel.setAttribute('data-panel-id', 'stacked')
    stack.appendChild(panel)
    // The pane's own container does not scroll — the stack above it does.
    const inner = document.createElement('div')
    panel.appendChild(inner)

    const row = document.createElement('div')
    row.setAttribute('data-block-id', 'row-b')
    row.setAttribute('data-render-scope-id', 'panel:page')
    row.getBoundingClientRect = () => rectAt(400, 30)
    inner.appendChild(row)

    stack.scrollTop = 0
    const cancel = alignScrollportToRow(inner, LOCATION)
    expect(stack.scrollTop).toBe(0)
    cancel()
  })

  // A takeover has to be noticed during a fallback-only wait too. The legacy
  // `outline:` rewrite changes the stored scope out from under the location, so
  // the exact row may never arrive — without this the whole two-second wait ran
  // with no takeover detection and the next mutation snapped the pane back.
  it('notices a takeover after a fallback-only alignment', async () => {
    const {port, addRow, moveRow} = build(100)
    port.scrollTop = 0
    const row = addRow('row-b', 'some-other-scope', 300)

    const cancel = alignScrollportToRow(port, LOCATION, {waitMs: NEVER_MS})
    expect(port.scrollTop).toBe(300)

    port.scrollTop = 900
    port.dispatchEvent(new Event('scroll'))

    // A mutation that would otherwise re-align.
    moveRow(row, 500)
    port.appendChild(document.createElement('div'))
    await new Promise(resolve => setTimeout(resolve, 120))

    expect(port.scrollTop).toBe(900)
    cancel()
  })

  // The exact scoped row can be a lazy copy in another surface that is still
  // hydrating. Aligning to the block-id fallback is a better guess than the top
  // of the page, but closing the correction window on it would strand the pane
  // on the wrong copy for good.
  it('keeps waiting for the exact row after aligning to a scope-drift fallback', async () => {
    const {port, addRow} = build(100)
    port.scrollTop = 0
    addRow('row-b', 'some-other-scope', 300)

    const cancel = alignScrollportToRow(port, LOCATION, {realignWindowMs: 30, waitMs: NEVER_MS})
    expect(port.scrollTop).toBe(300)

    // Well past the correction window the fallback would have opened.
    await new Promise(resolve => setTimeout(resolve, 120))
    addRow('row-b', 'panel:page', 800)

    await waitFor(() => {
      expect(port.scrollTop).toBe(800)
    })
    cancel()
  })
})

describe('alignScrollportToRow — when the anchor never appears', {timeout: TEST_BUDGET_MS}, () => {
  // Restoring by cursor assumes the cursor's row can be re-resolved after a
  // remount, and there are surfaces where it can't (a target inside an embed
  // whose source row is lazy, a layout root that renders no shell, a backlink
  // showing a promoted ancestor from local state). Every one that is missed
  // would otherwise strand the pane at the TOP — worse than the pixel restore
  // this replaced — so the offset is the floor rather than the alternative.
  it('falls back to the stored offset', async () => {
    const {port} = build(100)
    port.scrollTop = 0

    const cancel = alignScrollportToRow(port, LOCATION, {waitMs: 60, fallbackScrollTop: 640})
    expect(port.scrollTop).toBe(0)

    await waitFor(() => {
      expect(port.scrollTop).toBe(640)
    })
    cancel()
  })

  // Successive alignments can land in different ports: a block-id fallback in
  // the pane's own container, then the exact copy inside a nested aside. A
  // one-shot arm left the listener on the port we were no longer moving —
  // unwatched where it mattered, leaked where it didn't. The fallback has to
  // land FIRST for the transition to happen at all.
  it('rebinds takeover detection when the anchor moves to another port', async () => {
    const {port, addRow} = build(100)
    port.scrollTop = 0
    addRow('row-b', 'some-other-scope', 300)

    const cancel = alignScrollportToRow(port, LOCATION, {realignWindowMs: NEVER_MS, waitMs: NEVER_MS})
    // Fallback alignment, in the pane's own port.
    expect(port.scrollTop).toBe(300)

    // NOW the exact scoped copy hydrates, inside a nested port.
    const nested = document.createElement('div')
    nested.style.overflowY = 'auto'
    nested.getBoundingClientRect = () => rectAt(100, 400)
    port.appendChild(nested)
    const exact = document.createElement('div')
    exact.setAttribute('data-block-id', 'row-b')
    exact.setAttribute('data-render-scope-id', 'panel:page')
    exact.getBoundingClientRect = () => rectAt(500, 30)
    nested.appendChild(exact)
    nested.scrollTop = 0

    await waitFor(() => {
      expect(nested.scrollTop).toBe(400)
    })

    // The user drags THAT port's scrollbar — the one we are now moving.
    nested.scrollTop = 50
    nested.dispatchEvent(new Event('scroll'))

    exact.getBoundingClientRect = () => rectAt(300, 30)
    nested.appendChild(document.createElement('div'))
    await new Promise(resolve => setTimeout(resolve, 150))

    expect(nested.scrollTop).toBe(50)
    cancel()
  })

  // A native scrollbar drag while the anchor is still hydrating emits no wheel,
  // touch or key event, and there was no scroll watcher yet — so the row
  // mounting later would snap the pane off the position the user chose.
  it('gives up when the port is dragged before the anchor arrives', async () => {
    const {port, addRow} = build(100)
    port.scrollTop = 0

    const cancel = alignScrollportToRow(port, LOCATION, {waitMs: NEVER_MS, fallbackScrollTop: 640})

    // Past the layout-settling grace window: this is a hand on the scrollbar.
    await new Promise(resolve => setTimeout(resolve, 150))
    port.scrollTop = 900
    port.dispatchEvent(new Event('scroll'))

    // The anchor finally hydrates — and must not be honoured.
    addRow('row-b', 'panel:page', 300)
    await new Promise(resolve => setTimeout(resolve, 150))

    expect(port.scrollTop).toBe(900)
    cancel()
  })

  // A pane's own content settling moves its offset and fires scroll: a
  // back/forward swap keeps the container's old offset and the browser clamps
  // it as the outgoing content shrinks the document. Reading that as the user
  // abandons the restore AND its fallback.
  it('ignores a scroll that lands with the content settling', async () => {
    const {port, addRow} = build(100)
    port.scrollTop = 0

    const cancel = alignScrollportToRow(port, LOCATION, {waitMs: NEVER_MS, fallbackScrollTop: 640})

    // Content churns, and the offset moves in the same breath.
    port.appendChild(document.createElement('div'))
    port.scrollTop = 120
    port.dispatchEvent(new Event('scroll'))

    // The anchor arrives and must still be honoured.
    addRow('row-b', 'panel:page', 300)

    await waitFor(() => {
      expect(port.scrollTop).toBe(300)
    })
    cancel()
  })

  // Clicking a row during the wait moves the cursor while this aligner still
  // holds the old one, and fires none of the other signals — so the anchor
  // mounting a moment later would scroll off the row the user just picked.
  it('gives up when a row in the panel is clicked', async () => {
    const {port, addRow} = build(100)
    port.scrollTop = 0

    const cancel = alignScrollportToRow(port, LOCATION, {waitMs: NEVER_MS, fallbackScrollTop: 640})
    port.dispatchEvent(new Event('pointerdown', {bubbles: true}))

    addRow('row-b', 'panel:page', 300)
    await new Promise(resolve => setTimeout(resolve, 150))

    expect(port.scrollTop).toBe(0)
    cancel()
  })

  it('does not use the offset once the anchor has been found', async () => {
    const {port, addRow} = build(100)
    port.scrollTop = 0
    addRow('row-b', 'panel:page', 300)

    const cancel = alignScrollportToRow(port, LOCATION, {waitMs: 60, fallbackScrollTop: 640})
    expect(port.scrollTop).toBe(300)

    await new Promise(resolve => setTimeout(resolve, 150))
    expect(port.scrollTop).toBe(300)
    cancel()
  })

  // Someone who has already taken over must not be moved when the wait expires.
  it('does not use the offset after the user has taken over', async () => {
    const {port} = build(100)
    port.scrollTop = 0

    const cancel = alignScrollportToRow(port, LOCATION, {waitMs: 60, fallbackScrollTop: 640})
    port.dispatchEvent(new Event('wheel'))

    await new Promise(resolve => setTimeout(resolve, 150))
    expect(port.scrollTop).toBe(0)
    cancel()
  })
})
