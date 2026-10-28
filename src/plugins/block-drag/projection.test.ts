// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { findSlot, projectDrop, type DropProjection, type DropRow, type SlotRows } from './projection.ts'

const INDENT = 36

/** A row at `depth` whose ancestor chain is `chain` (root first) and whose
 *  depth column sits at `INDENT * depth`. */
const row = (id: string, chain: readonly string[]): DropRow => ({
  id,
  depth: chain.length,
  ancestorIds: chain,
  x: INDENT * chain.length,
})

/** Pointer x over the column of `depth`, nudged by `dx`. */
const at = (depth: number, dx = 0) => INDENT * depth + dx

// The outline these tests drop into:
//   root
//     A
//       A1
//         A1a
//       A2
//     B
const A = row('A', ['root'])
const A1 = row('A1', ['root', 'A'])
const A1a = row('A1a', ['root', 'A', 'A1'])
const A2 = row('A2', ['root', 'A'])
const B = row('B', ['root'])
const ROOT = row('root', [])

describe('projectDrop', () => {
  describe('between a leaf and a shallower row (A1a above, A2 below)', () => {
    // Depth range [depth(A2), depth(A1a) + 1] = [2, 4].
    it.each([
      // pointer column → depth → (parent, position)
      [at(1), 2, 'A', {kind: 'after', siblingId: 'A1'}],
      [at(2), 2, 'A', {kind: 'after', siblingId: 'A1'}],
      [at(3), 3, 'A1', {kind: 'after', siblingId: 'A1a'}],
      [at(4), 4, 'A1a', {kind: 'first'}],
      [at(9), 4, 'A1a', {kind: 'first'}],
      [at(-5), 2, 'A', {kind: 'after', siblingId: 'A1'}],
    ] as const)('pointer at x=%d → depth %d under %s', (x, depth, parentId, position) => {
      expect(projectDrop(A1a, A2, x, INDENT)).toEqual({depth, parentId, position})
    })
  })

  it('rounds to the nearest column: under half an indent stays, over half moves', () => {
    expect(projectDrop(A1a, A2, at(3, INDENT / 2 - 1), INDENT).depth).toBe(3)
    expect(projectDrop(A1a, A2, at(3, INDENT / 2 + 1), INDENT).depth).toBe(4)
    expect(projectDrop(A1a, A2, at(3, -INDENT / 2 + 1), INDENT).depth).toBe(3)
    expect(projectDrop(A1a, A2, at(3, -INDENT / 2 - 1), INDENT).depth).toBe(2)
  })

  // Below is above's first child, so the range collapses to one depth:
  // just below an expanded block with children means its first child,
  // matching paste's 'visible' placement.
  it('just below an expanded block with children is its first child, wherever the pointer is', () => {
    for (const x of [at(0), at(1), at(2), at(5)]) {
      expect(projectDrop(A, A1, x, INDENT)).toEqual({depth: 2, parentId: 'A', position: {kind: 'first'}})
    }
  })

  it('below a sibling at the same depth: sibling-after or first child', () => {
    expect(projectDrop(A2, B, at(2), INDENT))
      .toEqual({depth: 2, parentId: 'A', position: {kind: 'after', siblingId: 'A2'}})
    expect(projectDrop(A2, B, at(3), INDENT))
      .toEqual({depth: 3, parentId: 'A2', position: {kind: 'first'}})
    // Outdent to B's depth: after A, the ancestor of A2 at depth 1.
    expect(projectDrop(A2, B, at(1), INDENT))
      .toEqual({depth: 1, parentId: 'root', position: {kind: 'after', siblingId: 'A'}})
  })

  // A collapsed block's children aren't rendered, so the row below it is
  // at its depth or shallower; nesting under it means its first child
  // (the move reveals it).
  it('can nest under a collapsed block', () => {
    expect(projectDrop(B, null, at(2), INDENT))
      .toEqual({depth: 2, parentId: 'B', position: {kind: 'first'}})
  })

  describe('at the end of the surface (no row below)', () => {
    it('can outdent all the way to the scope root, never past it', () => {
      expect(projectDrop(A1a, null, at(1), INDENT))
        .toEqual({depth: 1, parentId: 'root', position: {kind: 'after', siblingId: 'A'}})
      expect(projectDrop(A1a, null, at(0), INDENT))
        .toEqual({depth: 1, parentId: 'root', position: {kind: 'after', siblingId: 'A'}})
      expect(projectDrop(A1a, null, at(-3), INDENT).depth).toBe(1)
    })
  })

  // The scope root has no sibling slot inside the surface: a drop is
  // never placed beside it, only inside it.
  it('just below the scope root is its first child', () => {
    expect(projectDrop(ROOT, A, at(0), INDENT))
      .toEqual({depth: 1, parentId: 'root', position: {kind: 'first'}})
    expect(projectDrop(ROOT, null, at(-2), INDENT))
      .toEqual({depth: 1, parentId: 'root', position: {kind: 'first'}})
  })
})

/** Rows laid out top to bottom, `height` px each own line; `nested[i]`
 *  marks row i+1 as row i's descendant (so i's own line ends where i+1
 *  starts, which is the same here). `excluded` marks dragged rows. */
const rowsOf = (count: number, excluded: readonly number[] = [], height = 20): SlotRows => ({
  count,
  top: i => i * height,
  ownBottom: i => (i + 1) * height,
  bottom: i => (i + 1) * height,
  isExcluded: i => excluded.includes(i),
})

describe('findSlot', () => {
  it('upper half of a row → the slot above it; lower half → the slot below it', () => {
    const rows = rowsOf(4)
    expect(findSlot(rows, 45)).toEqual({above: 1, below: 2}) // row 2, upper half
    expect(findSlot(rows, 55)).toEqual({above: 2, below: 3}) // row 2, lower half
  })

  it('below the last row is the slot after it, with nothing below', () => {
    const rows = rowsOf(3)
    expect(findSlot(rows, 55)).toEqual({above: 2, below: null})
    expect(findSlot(rows, 500)).toEqual({above: 2, below: null})
  })

  it('never offers the slot above the scope root', () => {
    const rows = rowsOf(3)
    expect(findSlot(rows, 2)).toEqual({above: 0, below: 1})
    expect(findSlot(rows, -50)).toEqual({above: 0, below: 1})
  })

  it('a pointer over a dragged row has no slot', () => {
    expect(findSlot(rowsOf(5, [2, 3]), 45)).toBeNull()
    expect(findSlot(rowsOf(5, [2, 3]), 75)).toBeNull()
  })

  it('skips dragged rows when picking the neighbours', () => {
    // Rows 2 and 3 are a dragged block and its child.
    const rows = rowsOf(6, [2, 3])
    expect(findSlot(rows, 35)).toEqual({above: 1, below: 4}) // row 1, lower half
    expect(findSlot(rows, 85)).toEqual({above: 1, below: 4}) // row 4, upper half
    expect(findSlot(rowsOf(4, [2, 3]), 35)).toEqual({above: 1, below: null})
  })

  it('reads the own line, not the whole subtree, for a row with children', () => {
    // Row 1's own line is 10..20 and its child (row 2) starts at 20, so
    // its midpoint is 15 — not the midpoint of its whole subtree.
    const rows: SlotRows = {
      count: 3,
      top: i => [0, 10, 20][i],
      ownBottom: i => [10, 20, 30][i],
      bottom: i => [10, 30, 30][i],
      isExcluded: () => false,
    }
    expect(findSlot(rows, 14)).toEqual({above: 0, below: 1})
    expect(findSlot(rows, 16)).toEqual({above: 1, below: 2})
  })

  // Past the end of a dragged last row (dragging it out to outdent it)
  // the pointer is over no row, so it is the gap the drag left behind.
  it('below a dragged last row is the gap after its predecessor', () => {
    expect(findSlot(rowsOf(4, [3]), 90)).toEqual({above: 2, below: null})
    expect(findSlot(rowsOf(4, [2, 3]), 90)).toEqual({above: 1, below: null})
  })

  it('has no slot when the surface has no rows', () => {
    expect(findSlot(rowsOf(0), 10)).toBeNull()
  })
})

// An oracle independent of the projection's arithmetic: apply the drop to
// a tree, flatten it the way the outline renders it, and check the moved
// block shows up exactly in the gap the pointer was in, at the projected
// depth. Run over every adjacent pair of a mixed outline (leaves,
// expanded and collapsed parents, deep-to-shallow steps) and every
// pointer column from far left to far right. "Exactly in the gap" is
// judged among the rows that were visible before the drop: nesting into a
// collapsed block reveals its children, which then follow the moved one.
describe('projectDrop drops land in the gap they were projected for', () => {
  interface Node { id: string; children: Node[]; collapsed?: boolean }
  const tree: Node = {id: 'root', children: [
    {id: 'a', children: [
      {id: 'a1', children: [{id: 'a1x', children: [{id: 'a1xy', children: []}]}]},
      {id: 'a2', children: []},
    ]},
    {id: 'b', collapsed: true, children: [{id: 'b1', children: []}]},
    {id: 'c', children: [{id: 'c1', children: []}]},
    {id: 'd', children: []},
  ]}

  const visibleRows = (node: Node, chain: string[] = []): DropRow[] => [
    {id: node.id, depth: chain.length, ancestorIds: chain, x: INDENT * chain.length},
    ...(node.collapsed ? [] : node.children.flatMap(child => visibleRows(child, [...chain, node.id]))),
  ]

  const find = (node: Node, id: string): Node | undefined =>
    node.id === id ? node : node.children.map(c => find(c, id)).find(Boolean)

  const insert = (root: Node, {parentId, position}: DropProjection, moved: Node): Node => {
    const copy: Node = structuredClone(root)
    const parent = find(copy, parentId)!
    parent.collapsed = false // the move reveals its destination
    const index = position.kind === 'first' ? 0
      : position.kind === 'after' ? parent.children.findIndex(c => c.id === position.siblingId) + 1
      : NaN
    parent.children.splice(index, 0, moved)
    return copy
  }

  const rows = visibleRows(tree)
  const pairs = rows.map((above, i) => [above, rows[i + 1] ?? null] as const)
  const columns = Array.from({length: 9}, (_, i) => INDENT * (i - 2))

  it.each(pairs.map(([above, below]) => [above.id, below?.id ?? '(end)', above, below] as const))(
    'between %s and %s',
    (_a, _b, above, below) => {
      for (const x of columns) {
        const projection = projectDrop(above, below, x, INDENT)
        const after = visibleRows(insert(tree, projection, {id: 'X', children: []}))
        expect(after.find(r => r.id === 'X')!.depth).toBe(projection.depth)
        const wasVisible = new Set(rows.map(r => r.id))
        const order = after.map(r => r.id).filter(id => id === 'X' || wasVisible.has(id))
        const at = order.indexOf('X')
        expect(order[at - 1]).toBe(above.id)
        if (below) expect(order[at + 1]).toBe(below.id)
      }
    },
  )
})
