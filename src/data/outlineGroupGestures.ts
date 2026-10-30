import type { BlockData, Tx } from '@/data/api'
import { indent, moveVertical, outdent } from '@/data/mutators'
import { visibleChildrenOf } from '@/data/visibleChildren'
import { precedesInTree } from '@/utils/selection'

interface GroupGesture {
  /** Run bottom-up. Move-down travels toward the next sibling, and outdent
   *  places each block straight after its parent, so top-down would stack a
   *  run in reverse. */
  bottomUp: boolean
  /** Apply the single-block gesture; resolves whether the block moved. */
  apply: (tx: Tx, id: string, scopeRootId: string) => Promise<boolean>
}

const GROUP_GESTURES = {
  indent: {bottomUp: false, apply: (tx, id) => tx.run(indent, {id})},
  outdent: {bottomUp: true, apply: (tx, id, scopeRootId) => tx.run(outdent, {id, scopeRootId})},
  moveUp: {
    bottomUp: false,
    apply: (tx, id, scopeRootId) => tx.run(moveVertical, {id, direction: -1, scopeRootId}),
  },
  moveDown: {
    bottomUp: true,
    apply: (tx, id, scopeRootId) => tx.run(moveVertical, {id, direction: 1, scopeRootId}),
  },
} satisfies Record<string, GroupGesture>

export type OutlineGroupGesture = keyof typeof GROUP_GESTURES

/** `id`'s chain from `scopeRootId` down to `id`, or null when `id` is not
 *  strictly inside the scope root's subtree. */
const pathFromScopeRoot = async (tx: Tx, id: string, scopeRootId: string): Promise<BlockData[] | null> => {
  // The scope root anchors its own view and never moves within it.
  if (id === scopeRootId) return null
  // A row from another tree (a backlink entry, an embed) belongs to a surface
  // rooted elsewhere; restructuring it here edits a page nothing here shows.
  if (!(await tx.isDescendantOf(id, scopeRootId))) return null
  // Terminates: the bounded, cycle-safe check above found the scope root on
  // this chain.
  const path: BlockData[] = []
  let current = await tx.get(id)
  while (current) {
    path.unshift(current)
    if (current.id === scopeRootId) break
    current = await tx.parentOf(current.id)
  }
  return path
}

/** Whether `member`'s sibling on the side processed just before it is in
 *  `group`. That sibling ran first, and had it moved it would no longer be
 *  beside `member`; so it stayed, and moving `member` would split the group. */
const heldByGroup = async (
  tx: Tx,
  member: BlockData,
  group: ReadonlySet<string>,
  bottomUp: boolean,
): Promise<boolean> => {
  const siblings = await visibleChildrenOf(tx, member.parentId, member.workspaceId)
  const at = siblings.findIndex(sibling => sibling.id === member.id)
  const neighbour = siblings[bottomUp ? at + 1 : at - 1]
  return neighbour !== undefined && group.has(neighbour.id)
}

/**
 * Apply an outline gesture to the selected blocks `ids` as one group, inside
 * `tx`, and resolve whether any block moved.
 *
 * Only blocks strictly inside `scopeRootId`'s subtree take part, in tree order
 * whatever order `ids` lists them in. A block held by the group keeps its
 * place, so a run of selected siblings moves together or not at all: at the
 * scope edge its leading block can't move and the rest stay beside it, rather
 * than swapping past it (move) or nesting under it (indent).
 */
export const applyOutlineGestureToGroupInTx = async (
  tx: Tx,
  gesture: OutlineGroupGesture,
  ids: readonly string[],
  scopeRootId: string,
): Promise<boolean> => {
  const {bottomUp, apply} = GROUP_GESTURES[gesture]
  const paths: BlockData[][] = []
  for (const id of ids) {
    const path = await pathFromScopeRoot(tx, id, scopeRootId)
    if (path) paths.push(path)
  }
  paths.sort((a, b) => (precedesInTree(a, b) ? -1 : precedesInTree(b, a) ? 1 : 0))
  if (bottomUp) paths.reverse()

  // `heldByGroup` reads only a member's parent from these rows, and that can't
  // change before the member's own turn: each gesture moves only its own
  // block, and re-keying a tie rewrites order keys, never parents.
  const members = paths.map(path => path[path.length - 1])
  const group = new Set(members.map(member => member.id))
  let moved = false
  for (const member of members) {
    if (await heldByGroup(tx, member, group, bottomUp)) continue
    if (await apply(tx, member.id, scopeRootId)) moved = true
  }
  return moved
}
