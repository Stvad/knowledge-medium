import { BlockNotFoundError, type BlockData, type Tx } from '@/data/api'
import { indent, moveVertical, outdent } from '@/data/mutators'
import type { PropertyDisplayScopeLevels } from '@/data/propertyDisplayMode'
import { visibleSiblingsOf } from '@/data/visibleChildren'
import { precedesInTree } from '@/data/treeOrder'

/** Where a member moves: its scope root (see `scopedPath`) and the display
 *  scope of the surface the selection is on. */
interface MemberSurface {
  scopeRootId: string
  propertyDisplay?: PropertyDisplayScopeLevels
}

interface GroupGesture {
  /** Run bottom-up. Move-down travels toward the next sibling, and outdent
   *  places each block straight after its parent, so top-down would stack a
   *  run in reverse. */
  bottomUp: boolean
  /** Apply the single-block gesture; resolves whether the block moved. */
  apply: (tx: Tx, id: string, surface: MemberSurface) => Promise<boolean>
}

const GROUP_GESTURES = {
  indent: {
    bottomUp: false,
    apply: (tx, id, {propertyDisplay}) => tx.run(indent, {id, propertyDisplay}),
  },
  outdent: {bottomUp: true, apply: (tx, id, surface) => tx.run(outdent, {id, ...surface})},
  moveUp: {bottomUp: false, apply: (tx, id, surface) => tx.run(moveVertical, {id, direction: -1, ...surface})},
  moveDown: {bottomUp: true, apply: (tx, id, surface) => tx.run(moveVertical, {id, direction: 1, ...surface})},
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

/** Whether `id`'s sibling on the side processed just before it, on the list
 *  the surface draws, is in `group`. That sibling ran first, and had it moved
 *  it would no longer be beside `id`; so it stayed, and moving `id` would
 *  split the group. */
const heldByGroup = async (
  tx: Tx,
  id: string,
  group: ReadonlySet<string>,
  {bottomUp, propertyDisplay}: {bottomUp: boolean; propertyDisplay?: PropertyDisplayScopeLevels},
): Promise<boolean> => {
  // Read live: an earlier member's gesture can re-key a tie this one is in.
  const member = await tx.get(id)
  if (member === null) throw new BlockNotFoundError(id)
  const {siblings, index} = await visibleSiblingsOf(tx, member, propertyDisplay)
  const neighbour = siblings[bottomUp ? index + 1 : index - 1]
  return neighbour !== undefined && group.has(neighbour.id)
}

/**
 * Apply an outline gesture to the selected blocks `ids` as one group per scope
 * root (see `scopedPath`), inside `tx`, and resolve whether any block moved.
 * `panelRootId` and `propertyDisplay` describe the surface the selection is
 * on: its zoom root, and the display scope whose list every gesture acts on.
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
  {panelRootId, propertyDisplay}: {panelRootId?: string; propertyDisplay?: PropertyDisplayScopeLevels},
): Promise<boolean> => {
  const {bottomUp, apply} = GROUP_GESTURES[gesture]
  let moved = false
  for (const {scopeRootId, paths} of await scopeGroups(tx, ids, panelRootId)) {
    const members = paths.map(path => path[path.length - 1].id)
    if (bottomUp) members.reverse()
    const group = new Set(members)
    for (const id of members) {
      if (await heldByGroup(tx, id, group, {bottomUp, propertyDisplay})) continue
      if (await apply(tx, id, {scopeRootId, propertyDisplay})) moved = true
    }
  }
  return moved
}
