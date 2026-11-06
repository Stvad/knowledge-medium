import type { BlockData, Tx } from '@/data/api'
import { indent, moveVertical, outdent } from '@/data/mutators'
import { visibleChildrenOf } from '@/data/visibleChildren'
import { precedesInTree } from '@/data/treeOrder'

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

/** `id`'s chain down from its scope root: the panel's root when `id` is under
 *  it, else the root of `id`'s own page (a backlink or embed row), which keeps
 *  every gesture inside that page. Null when `id` is its own scope root, which
 *  never moves within its own view, or when its live chain breaks first: a row
 *  under a deleted block isn't on screen. */
const scopedPath = async (
  tx: Tx,
  id: string,
  panelRootId: string | undefined,
): Promise<BlockData[] | null> => {
  const path: BlockData[] = []
  const seen = new Set<string>()
  for (let current = await tx.get(id); current; current = await tx.parentOf(current.id)) {
    // Defence in depth: sync can apply a parent cycle, which would loop forever.
    if (seen.has(current.id)) return null
    seen.add(current.id)
    path.unshift(current)
    if (current.id === panelRootId || current.parentId === null) {
      return path.length > 1 ? path : null
    }
  }
  return null
}

interface ScopeGroup {
  scopeRootId: string
  /** The members' paths down from `scopeRootId`, in tree order. */
  paths: BlockData[][]
}

/** The selected blocks the gesture moves, grouped by scope root: each block
 *  once, and none under another selected block, which carries it along
 *  instead of it moving again. */
const scopeGroups = async (
  tx: Tx,
  ids: readonly string[],
  panelRootId: string | undefined,
): Promise<ScopeGroup[]> => {
  const pathsByScope = new Map<string, BlockData[][]>()
  for (const id of new Set(ids)) {
    const path = await scopedPath(tx, id, panelRootId)
    if (!path) continue
    const paths = pathsByScope.get(path[0].id) ?? []
    paths.push(path)
    pathsByScope.set(path[0].id, paths)
  }
  return [...pathsByScope].map(([scopeRootId, paths]) => {
    const selected = new Set(paths.map(path => path[path.length - 1].id))
    return {
      scopeRootId,
      paths: paths
        .filter(path => !path.slice(1, -1).some(ancestor => selected.has(ancestor.id)))
        .sort((a, b) => (precedesInTree(a, b) ? -1 : precedesInTree(b, a) ? 1 : 0)),
    }
  })
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
 * Apply an outline gesture to the selected blocks `ids` as one group per scope
 * root (see `scopedPath`), inside `tx`, and resolve whether any block moved.
 *
 * Each group applies in tree order, whatever order `ids` lists them in. A
 * block held by its group keeps its place, so a run of selected siblings moves
 * together or not at all: at the scope edge its leading block can't move and
 * the rest stay beside it, rather than swapping past it (move) or nesting
 * under it (indent).
 */
export const applyOutlineGestureToGroupInTx = async (
  tx: Tx,
  gesture: OutlineGroupGesture,
  ids: readonly string[],
  panelRootId: string | undefined,
): Promise<boolean> => {
  const {bottomUp, apply} = GROUP_GESTURES[gesture]
  let moved = false
  for (const {scopeRootId, paths} of await scopeGroups(tx, ids, panelRootId)) {
    if (bottomUp) paths.reverse()
    // `heldByGroup` reads only a member's parent from these rows, and that
    // can't change before the member's own turn: members are distinct roots,
    // each gesture moves only its own block, and re-keying a tie rewrites
    // order keys, never parents.
    const members = paths.map(path => path[path.length - 1])
    const group = new Set(members.map(member => member.id))
    for (const member of members) {
      if (await heldByGroup(tx, member, group, bottomUp)) continue
      if (await apply(tx, member.id, scopeRootId)) moved = true
    }
  }
  return moved
}
