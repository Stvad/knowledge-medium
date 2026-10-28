// @vitest-environment happy-dom
/**
 * `resolveDropTarget` against a DOM shaped like the default layout's: a
 * panel whose root row (no bullet) holds nested row shells, each with its
 * own bullet; depth-1 rows sit flush with the root and every level below
 * indents by `INDENT`. Geometry is stubbed per element — the DOM under
 * test does no layout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveDropTarget, type DropContext } from './dropTarget.ts'

/** Not the adapter's 36px fallback, so a test can tell measuring from
 *  falling back. */
const INDENT = 30
const ROW_HEIGHT = 20
const SCOPE = 'panel:p1:root'

type Spec = readonly [id: string, children?: Spec[]]

const rects = new WeakMap<Element, DOMRect>()
const rectOf = (left: number, top: number, width: number, height: number) =>
  ({left, top, width, height, right: left + width, bottom: top + height, x: left, y: top}) as DOMRect

let panel: HTMLElement
const rows = new Map<string, HTMLElement>()

/** Lay `children` out under `parent`, one ROW_HEIGHT line per row in
 *  document order. Returns the next free y. */
const layout = (parent: HTMLElement, children: readonly Spec[], depth: number, y: number, scope = SCOPE): number => {
  for (const [id, grandchildren = []] of children) {
    const row = document.createElement('div')
    row.setAttribute('data-block-shell', 'true')
    row.dataset.blockId = id
    row.dataset.renderScopeId = scope
    const bullet = document.createElement('a')
    bullet.setAttribute('data-block-bullet', 'true')
    row.append(bullet)
    parent.append(row)
    rows.set(id, row)
    const left = INDENT * (depth - 1)
    rects.set(bullet, rectOf(left, y, 20, ROW_HEIGHT))
    const bottom = layout(row, grandchildren, depth + 1, y + ROW_HEIGHT, scope)
    rects.set(row, rectOf(left, y, 500 - left, bottom - y))
    y = bottom
  }
  return y
}

/** root
 *    a
 *      a1
 *        a1x
 *    b                */
beforeEach(() => {
  document.body.innerHTML = ''
  rows.clear()
  panel = document.createElement('div')
  panel.dataset.panelId = 'p1'
  document.body.append(panel)
  const root = document.createElement('div')
  root.setAttribute('data-block-shell', 'true')
  root.dataset.blockId = 'root'
  root.dataset.renderScopeId = SCOPE
  panel.append(root)
  rows.set('root', root)
  const bottom = layout(root, [['a', [['a1', [['a1x']]]]], ['b']], 1, ROW_HEIGHT)
  rects.set(root, rectOf(0, 0, 500, bottom + 40)) // title line + a footer
  rects.set(panel, rectOf(-100, 0, 700, 400))
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return rects.get(this) ?? rectOf(0, 0, 0, 0)
  })
})

afterEach(() => { vi.restoreAllMocks() })

const context = (dragged: readonly string[] = [], surfaceAllowed = true): DropContext => ({
  draggedIds: new Set(dragged),
  isSurfaceAllowed: () => surfaceAllowed,
})

/** Pointer y in the lower half of `id`'s own line, and the x of `depth`'s
 *  bullet column. */
const lowerHalf = (id: string) => rects.get(rows.get(id)!)!.top + ROW_HEIGHT * 0.75
const column = (depth: number) => INDENT * (depth - 1) + 10

describe('resolveDropTarget', () => {
  it('nests or places after a sibling by the pointer column, and draws the line there', () => {
    const y = lowerHalf('a1x') // between a1x (depth 3) and b (depth 1)
    const hit = rows.get('a1x')!

    expect(resolveDropTarget(hit, column(3), y, context())).toMatchObject({
      move: {parentId: 'a1', position: {kind: 'after', siblingId: 'a1x'}},
      line: {x: column(3), y: rects.get(rows.get('a1x')!)!.bottom},
      renderScopeId: SCOPE,
      panelId: 'p1',
    })
    expect(resolveDropTarget(hit, column(4), y, context())?.move)
      .toEqual({parentId: 'a1x', position: {kind: 'first'}})
    expect(resolveDropTarget(hit, column(1), y, context())?.move)
      .toEqual({parentId: 'root', position: {kind: 'after', siblingId: 'a'}})
  })

  it('measures the indent from the rendered rows', () => {
    // Just over half of this layout's indent right of a1x's column rounds
    // to a1x's child; against the 36px fallback it would round back.
    const y = lowerHalf('a1x')
    expect(resolveDropTarget(rows.get('a1x')!, column(3) + INDENT * 0.55, y, context())?.move)
      .toEqual({parentId: 'a1x', position: {kind: 'first'}})
  })

  it('just under the page title is the first child of the root', () => {
    expect(resolveDropTarget(rows.get('root')!, column(1), 5, context())?.move)
      .toEqual({parentId: 'root', position: {kind: 'first'}})
  })

  it('has no target over a dragged row or anything rendered inside it', () => {
    expect(resolveDropTarget(rows.get('a1')!, column(2), lowerHalf('a1'), context(['a']))).toBeNull()
    expect(resolveDropTarget(rows.get('a1x')!, column(3), lowerHalf('a1x'), context(['a']))).toBeNull()
    // …while a row outside it still takes the drop.
    expect(resolveDropTarget(rows.get('b')!, column(1), lowerHalf('b'), context(['a']))?.move)
      .toEqual({parentId: 'root', position: {kind: 'after', siblingId: 'b'}})
  })

  it('has no target on a surface the data check refuses', () => {
    expect(resolveDropTarget(rows.get('b')!, column(1), lowerHalf('b'), context([], false))).toBeNull()
  })

  it('has no target inside a nested surface (an embed)', () => {
    const embedTop = rects.get(rows.get('b')!)!.top + ROW_HEIGHT
    const embedRoot = rows.get('b')!
    layout(embedRoot, [['embedded']], 2, embedTop, 'embed:b:occ:x:panel:p1:root')
    expect(resolveDropTarget(rows.get('embedded')!, column(2), embedTop + 15, context())).toBeNull()
  })

  it('off every row but inside the panel, targets the panel outline', () => {
    // Left of the outline, beside b: dragged out to outdent.
    expect(resolveDropTarget(panel, -80, lowerHalf('b'), context())?.move)
      .toEqual({parentId: 'root', position: {kind: 'after', siblingId: 'b'}})
  })

  // A layout that renders the root's children in the panel's scope but
  // not the root's own shell (the video-notes layout): its first row is a
  // child, not the root, so the depths read off the DOM would be wrong.
  it('has no target on a surface that does not render its root', () => {
    document.body.innerHTML = ''
    rows.clear()
    panel = document.createElement('div')
    panel.dataset.panelId = 'p1'
    document.body.append(panel)
    layout(panel, [['n1'], ['n2']], 1, 0)
    expect(resolveDropTarget(rows.get('n2')!, column(1), lowerHalf('n2'), context())).toBeNull()
    expect(resolveDropTarget(rows.get('n1')!, column(1), lowerHalf('n1'), context())).toBeNull()
  })

  it('ignores a deferred row placeholder', () => {
    // A placeholder carries the shell attribute but no block id; a pointer
    // over it belongs to the rows around it.
    const placeholder = document.createElement('div')
    placeholder.setAttribute('data-block-shell', 'true')
    placeholder.dataset.lazyBlockId = 'later'
    rows.get('root')!.append(placeholder)
    const top = rects.get(rows.get('b')!)!.bottom
    rects.set(placeholder, rectOf(0, top, 500, ROW_HEIGHT))
    expect(resolveDropTarget(placeholder, column(1), top + 5, context())?.move)
      .toEqual({parentId: 'root', position: {kind: 'after', siblingId: 'b'}})
  })
})
