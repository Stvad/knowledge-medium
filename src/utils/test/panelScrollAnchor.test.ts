// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  alignRowToScrollportTop,
  alignScrollportToRow,
  findAnchorRow,
} from '@/utils/panelScrollAnchor.js'

const LOCATION = {blockId: 'row-b', renderScopeId: 'panel:page'}

/** happy-dom never lays out, so every rect is zero unless a test says
 *  otherwise. Only the vertical position matters here. */
const stubTop = (el: HTMLElement, top: number): void => {
  el.getBoundingClientRect = () => ({
    top, bottom: top + 30, left: 0, right: 100, width: 100, height: 30,
    x: 0, y: top, toJSON: () => ({}),
  }) as DOMRect
}

interface Harness {
  port: HTMLElement
  addRow: (blockId: string, renderScopeId: string, top: number) => HTMLElement
}

const build = (portTop = 100): Harness => {
  const panel = document.createElement('div')
  panel.setAttribute('data-panel-id', 'panel')
  const port = document.createElement('div')
  port.style.overflowY = 'auto'
  stubTop(port, portTop)
  panel.appendChild(port)
  document.body.appendChild(panel)

  return {
    port,
    addRow: (blockId, renderScopeId, top) => {
      const row = document.createElement('div')
      row.setAttribute('data-block-id', blockId)
      row.setAttribute('data-render-scope-id', renderScopeId)
      stubTop(row, top)
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
    const exact = addRow('row-b', 'panel:page', 400)

    expect(findAnchorRow(port, LOCATION)).toBe(exact)
  })

  // A scope id can shift under a stored location — the legacy `outline:`
  // rewrite does exactly that, asynchronously, on the same mount that restores.
  it('falls back to the block id when no scope matches', () => {
    const {port, addRow} = build()
    const drifted = addRow('row-b', 'outline:page', 400)

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
    const row = addRow('row-b', 'panel:page', 400)
    port.scrollTop = 0

    expect(alignRowToScrollportTop(row)).toBe(300)
    expect(port.scrollTop).toBe(300)
  })

  it('reports zero and leaves the port alone when the row is already at the top', () => {
    const {port, addRow} = build(100)
    const row = addRow('row-b', 'panel:page', 100)
    port.scrollTop = 42

    expect(alignRowToScrollportTop(row)).toBe(0)
    expect(port.scrollTop).toBe(42)
  })
})

describe('alignScrollportToRow', () => {
  it('aligns a row that is already rendered', () => {
    const {port, addRow} = build(100)
    addRow('row-b', 'panel:page', 400)
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

    addRow('row-b', 'panel:page', 400)

    await vi.waitFor(() => {
      expect(port.scrollTop).toBe(300)
    })
    cancel()
  })

  // Rows that were briefly on screen before the restore keep mounting and grow
  // the document above the anchor, sliding it back down.
  it('re-applies the alignment while the page above keeps growing', async () => {
    const {port, addRow} = build(100)
    port.scrollTop = 0
    const row = addRow('row-b', 'panel:page', 400)

    const cancel = alignScrollportToRow(port, LOCATION)
    expect(port.scrollTop).toBe(300)

    // Content lands above the anchor: the row is now 150px further down.
    stubTop(row, 250)
    port.appendChild(document.createElement('div'))

    await vi.waitFor(() => {
      expect(port.scrollTop).toBe(450)
    })
    cancel()
  })

  it('stops correcting once cancelled', async () => {
    const {port, addRow} = build(100)
    port.scrollTop = 0

    const cancel = alignScrollportToRow(port, LOCATION)
    cancel()
    addRow('row-b', 'panel:page', 400)

    // Fence on a second aligner that IS live: once it has reacted to a
    // mutation, the cancelled one has demonstrably had its turn.
    const fence = build(100)
    const fenceCancel = alignScrollportToRow(fence.port, LOCATION)
    fence.addRow('row-b', 'panel:page', 400)
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
    const {port, addRow} = build(100)
    port.scrollTop = 0
    const row = addRow('row-b', 'panel:page', 400)

    const cancel = alignScrollportToRow(port, LOCATION)
    expect(port.scrollTop).toBe(300)

    port.dispatchEvent(new Event('wheel'))
    stubTop(row, 250)
    port.appendChild(document.createElement('div'))

    const fence = build(100)
    const fenceCancel = alignScrollportToRow(fence.port, LOCATION)
    fence.addRow('row-b', 'panel:page', 400)
    await vi.waitFor(() => {
      expect(fence.port.scrollTop).toBe(300)
    })
    fenceCancel()

    expect(port.scrollTop).toBe(300)
    cancel()
  })
})
