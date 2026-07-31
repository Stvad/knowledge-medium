// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  alignRowToScrollportTop,
  alignScrollportToRow,
  findAnchorRow,
} from '@/utils/panelScrollAnchor.js'

const LOCATION = {blockId: 'row-b', renderScopeId: 'panel:page'}

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

    expect(findAnchorRow(port, LOCATION)).toBe(exact)
  })

  // A scope id can shift under a stored location — the legacy `outline:`
  // rewrite does exactly that, asynchronously, on the same mount that restores.
  it('falls back to the block id when no scope matches', () => {
    const {port, addRow} = build()
    const drifted = addRow('row-b', 'outline:page', 300)

    expect(findAnchorRow(port, LOCATION)).toBe(drifted)
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

describe('alignScrollportToRow', () => {
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

    const cancel = alignScrollportToRow(port, LOCATION)
    expect(port.scrollTop).toBe(0)

    addRow('row-b', 'panel:page', 300)

    await vi.waitFor(() => {
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

    const cancel = alignScrollportToRow(port, LOCATION)
    expect(port.scrollTop).toBe(300)

    // Content lands above the anchor: the row is now 150px further down.
    moveRow(row, 450)
    port.appendChild(document.createElement('div'))

    await vi.waitFor(() => {
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

    const cancel = alignScrollportToRow(port, LOCATION, {realignWindowMs: 1000})
    expect(port.scrollTop).toBe(300)

    // No DOM change at all — just something above it growing.
    moveRow(row, 460)

    await vi.waitFor(() => {
      expect(port.scrollTop).toBe(460)
    })
    cancel()
  })

  // Keyboard scrolling (PageDown, Space) is a takeover like any other, and it
  // can happen while the anchor row is still hydrating.
  it('gives up when a key is pressed inside this panel', async () => {
    const {port, addRow} = build(100)
    port.scrollTop = 0

    const cancel = alignScrollportToRow(port, LOCATION)
    port.dispatchEvent(new Event('keydown', {bubbles: true}))
    addRow('row-b', 'panel:page', 300)

    const fence = build(100)
    const fenceCancel = alignScrollportToRow(fence.port, LOCATION)
    fence.addRow('row-b', 'panel:page', 300)
    await vi.waitFor(() => {
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

    const cancel = alignScrollportToRow(port, LOCATION)
    elsewhere.port.dispatchEvent(new Event('keydown', {bubbles: true}))
    addRow('row-b', 'panel:page', 300)

    await vi.waitFor(() => {
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

    const cancel = alignScrollportToRow(port, LOCATION, {realignWindowMs: 1000})
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
    const fenceCancel = alignScrollportToRow(fence.port, LOCATION)
    fence.addRow('row-b', 'panel:page', 300)
    await vi.waitFor(() => {
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

    const cancel = alignScrollportToRow(port, LOCATION)
    expect(port.scrollTop).toBe(300)

    port.dispatchEvent(new Event('wheel'))
    moveRow(row, 450)
    port.appendChild(document.createElement('div'))

    const fence = build(100)
    const fenceCancel = alignScrollportToRow(fence.port, LOCATION)
    fence.addRow('row-b', 'panel:page', 300)
    await vi.waitFor(() => {
      expect(fence.port.scrollTop).toBe(300)
    })
    fenceCancel()

    expect(port.scrollTop).toBe(300)
    cancel()
  })
})
