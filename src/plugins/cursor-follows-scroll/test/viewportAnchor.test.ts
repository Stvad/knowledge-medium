// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { resolveViewportAnchor } from '../viewportAnchor.ts'
import { DEFAULT_NON_NAVIGABLE_SURFACES } from '@/plugins/spatial-navigation/walker.js'

const SCOPE = 'panel:page'
const PORT_TOP = 0
const PORT_BOTTOM = 500

const stubRect = (el: HTMLElement, top: number, height: number): void => {
  el.getBoundingClientRect = () => ({
    top, bottom: top + height, left: 0, right: 100, width: 100, height,
    x: 0, y: top, toJSON: () => ({}),
  }) as DOMRect
}

interface RowSpec {
  blockId: string
  /** Top of the row's own content rect. The port spans 0–500, so anything
   *  outside that (by more than a line) is off screen. */
  top: number
  surface?: string
  scope?: string
}

const build = (rows: readonly RowSpec[]): HTMLElement => {
  const panel = document.createElement('div')
  panel.setAttribute('data-panel-id', 'panel')
  const port = document.createElement('div')
  port.style.overflowY = 'auto'
  stubRect(port, PORT_TOP, PORT_BOTTOM - PORT_TOP)
  panel.appendChild(port)
  document.body.appendChild(panel)

  for (const row of rows) {
    const shell = document.createElement('div')
    shell.setAttribute('data-block-nav-item', 'true')
    shell.setAttribute('data-block-id', row.blockId)
    shell.setAttribute('data-render-scope-id', row.scope ?? SCOPE)
    if (row.surface) shell.setAttribute('data-block-surface', row.surface)
    const target = document.createElement('div')
    target.setAttribute('data-block-visibility-target', 'true')
    stubRect(target, row.top, 30)
    shell.appendChild(target)
    port.appendChild(shell)
  }
  return panel
}

const anchorFor = (panel: HTMLElement, blockId: string) =>
  resolveViewportAnchor(panel, {blockId, renderScopeId: SCOPE}, DEFAULT_NON_NAVIGABLE_SURFACES)

afterEach(() => {
  document.body.innerHTML = ''
})

describe('resolveViewportAnchor', () => {
  it('moves the cursor to the topmost visible row when it scrolls off the top', () => {
    const panel = build([
      {blockId: 'a', top: -400},
      {blockId: 'b', top: -60},
      {blockId: 'c', top: 20},
      {blockId: 'd', top: 200},
    ])

    expect(anchorFor(panel, 'a')).toEqual({blockId: 'c', renderScopeId: SCOPE})
  })

  // Emacs would take the nearest edge — the LAST visible row — because that
  // moves point the least. The anchor doubles as the restore target, and only
  // the top row restores the same viewport.
  it('still takes the topmost row when the cursor scrolls off the bottom', () => {
    const panel = build([
      {blockId: 'a', top: 20},
      {blockId: 'b', top: 200},
      {blockId: 'c', top: 900},
    ])

    expect(anchorFor(panel, 'c')).toEqual({blockId: 'a', renderScopeId: SCOPE})
  })

  it('leaves a cursor that is still on screen alone', () => {
    const panel = build([
      {blockId: 'a', top: 20},
      {blockId: 'b', top: 200},
    ])

    expect(anchorFor(panel, 'b')).toBeNull()
  })

  // Scrolling past the outline into the backlinks should carry the cursor with
  // it — those rows are already where `j` travels.
  it('anchors onto a backlink row when that is what is on screen', () => {
    const panel = build([
      {blockId: 'outline-row', top: -400, surface: 'outline'},
      {blockId: 'backlink-row', top: 40, surface: 'backlink'},
    ])

    expect(anchorFor(panel, 'outline-row')).toEqual({
      blockId: 'backlink-row',
      renderScopeId: SCOPE,
    })
  })

  it('skips surfaces the walker excludes', () => {
    const panel = build([
      {blockId: 'a', top: -400},
      {blockId: 'crumb', top: 10, surface: 'breadcrumb'},
      {blockId: 'b', top: 60},
    ])

    expect(anchorFor(panel, 'a')).toEqual({blockId: 'b', renderScopeId: SCOPE})
  })

  // A cursor with no row in this panel is a disappearance, not a scroll:
  // `PanelFocusRecovery` handles it, by data-tree neighbourhood rather than
  // geometry. Re-anchoring here would race it with a worse answer.
  it('declines when the cursor has no row in the panel', () => {
    const panel = build([{blockId: 'a', top: 20}])

    expect(anchorFor(panel, 'gone')).toBeNull()
  })

  it('declines when nothing is on screen', () => {
    const panel = build([
      {blockId: 'a', top: -400},
      {blockId: 'b', top: 900},
    ])

    expect(anchorFor(panel, 'a')).toBeNull()
  })

  // The video-notes layout: the video block's own row sits in a section that
  // never scrolls, ahead of the notes in DOM order and permanently on screen.
  // Unfiltered, it would take the cursor every time a note scrolled out.
  it('only considers rows that scroll with the cursor', () => {
    const panel = document.createElement('div')
    panel.setAttribute('data-panel-id', 'panel')
    document.body.appendChild(panel)

    const addRow = (parent: HTMLElement, blockId: string, top: number) => {
      const shell = document.createElement('div')
      shell.setAttribute('data-block-nav-item', 'true')
      shell.setAttribute('data-block-id', blockId)
      shell.setAttribute('data-render-scope-id', SCOPE)
      const t = document.createElement('div')
      t.setAttribute('data-block-visibility-target', 'true')
      stubRect(t, top, 30)
      shell.appendChild(t)
      parent.appendChild(shell)
    }

    // Fixed pane — no scrollport of its own, always in view.
    const fixed = document.createElement('div')
    stubRect(fixed, PORT_TOP, 200)
    panel.appendChild(fixed)
    addRow(fixed, 'video', 20)

    // Notes pane — its own scrollport.
    const notes = document.createElement('div')
    notes.style.overflowY = 'auto'
    stubRect(notes, PORT_TOP, PORT_BOTTOM - PORT_TOP)
    panel.appendChild(notes)
    addRow(notes, 'note-a', -400)
    addRow(notes, 'note-b', 60)

    expect(anchorFor(panel, 'note-a')).toEqual({blockId: 'note-b', renderScopeId: SCOPE})
  })

  // Two panels can show the same block; the cursor is a (block, scope) pair and
  // a row from another scope is not the cursor's row.
  it('matches the cursor on its render scope, not the block id alone', () => {
    const panel = build([
      {blockId: 'a', top: -400, scope: 'other-panel:page'},
      {blockId: 'b', top: 20},
    ])

    expect(anchorFor(panel, 'a')).toBeNull()
  })
})
