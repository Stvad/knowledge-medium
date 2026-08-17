/** Aggregation for the Recents feed.
 *
 *  A raw "recently edited blocks" list reports one row per block, which
 *  is the wrong grain for how edits actually happen: importing a tree
 *  (a Matrix thread, a Roam page) writes its root and every descendant
 *  within the same second, and a writing session touches a dozen blocks
 *  on one page. Both arrive as one thing conceptually and should read as
 *  one entry.
 *
 *  Two folds, in order:
 *   1. an edited block whose nearest edited ANCESTOR was edited in the
 *      same session folds into that ancestor — an imported tree collapses
 *      to its root, no matter how deep;
 *   2. what is left folds into the PAGE it lives under, per session — so
 *      scattered edits on one page read as one visit to that page.
 *
 *  Pure: `rows` and the ancestor chains come from `core.recentBlocks` +
 *  `core.manyAncestors`, and nothing here reads the repo.
 */

import type { BlockData } from '@/data/api'
import { getBlockTypes } from '@/data/properties'
import { PAGE_TYPE } from '@/data/blockTypes'

/** Edits this far apart are separate sessions, so they get separate
 *  entries even on the same page. Long enough to hold one sitting
 *  together (including a pause to read something), short enough that
 *  yesterday evening and this morning don't merge. */
export const DEFAULT_SESSION_GAP_MS = 30 * 60 * 1000

export interface RecentActivityGroup {
  /** The block the entry is titled by: the root of an edited tree, or
   *  the page a session's edits happened on. */
  anchorId: string
  /** Whether the anchor is itself one of the edited blocks. False when it
   *  is a page we grouped under but nobody edited — the renderer shows it
   *  as context rather than as an edit. */
  anchorEdited: boolean
  /** The edited blocks this entry stands for, newest first, never
   *  including `anchorId`. */
  memberIds: readonly string[]
  /** Newest edit in the entry — what the feed sorts and timestamps by. */
  lastEditedAt: number
}

const editTime = (block: BlockData): number => block.userUpdatedAt ?? block.updatedAt ?? 0

const isPage = (block: BlockData): boolean => getBlockTypes(block).includes(PAGE_TYPE)

interface Tree {
  anchorId: string
  rows: BlockData[]
  lastEditedAt: number
}

/** Fold recent edits into activity entries. `rows` must be newest-first
 *  (as `core.recentBlocks` returns them); `ancestorsById` maps each row's
 *  id to its leaf-to-root chain with the row itself excluded (as
 *  `core.manyAncestors` returns them). Rows with no chain entry are
 *  treated as having no ancestors — they simply stand alone. */
export const groupRecentActivity = (
  rows: readonly BlockData[],
  ancestorsById: ReadonlyMap<string, readonly BlockData[]>,
  options: {sessionGapMs?: number} = {},
): RecentActivityGroup[] => {
  const gap = options.sessionGapMs ?? DEFAULT_SESSION_GAP_MS
  const editedAt = new Map<string, number>()
  for (const row of rows) editedAt.set(row.id, editTime(row))

  // ── Fold 1: into the nearest edited ancestor of the same session ──
  const anchorOf = new Map<string, string>()
  const resolveAnchor = (id: string): string => {
    const cached = anchorOf.get(id)
    if (cached !== undefined) return cached
    // Seed with self before recursing: a chain is finite and strictly
    // ascending, but the seed also makes a malformed input (a row listed
    // as its own ancestor) terminate instead of recursing forever.
    anchorOf.set(id, id)
    for (const ancestor of ancestorsById.get(id) ?? []) {
      const ancestorEdit = editedAt.get(ancestor.id)
      if (ancestorEdit === undefined) continue
      // Stop at the NEAREST edited ancestor either way. Out of session,
      // this row starts its own entry rather than jumping over that
      // ancestor into a further one — the intervening edit is what makes
      // the higher block the wrong home for it.
      if (Math.abs(editedAt.get(id)! - ancestorEdit) <= gap) {
        const anchor = resolveAnchor(ancestor.id)
        anchorOf.set(id, anchor)
        return anchor
      }
      break
    }
    return id
  }

  const trees = new Map<string, Tree>()
  for (const row of rows) {
    const anchorId = resolveAnchor(row.id)
    const tree = trees.get(anchorId)
    if (tree) {
      tree.rows.push(row)
      tree.lastEditedAt = Math.max(tree.lastEditedAt, editTime(row))
    } else {
      trees.set(anchorId, {anchorId, rows: [row], lastEditedAt: editTime(row)})
    }
  }

  // ── Fold 2: into the page the tree lives on, per session ──
  const blocksById = new Map<string, BlockData>()
  for (const row of rows) blocksById.set(row.id, row)
  for (const chain of ancestorsById.values()) {
    for (const block of chain) blocksById.set(block.id, block)
  }

  const containerOf = (anchorId: string): string | null => {
    const self = blocksById.get(anchorId)
    if (self && isPage(self)) return anchorId
    for (const ancestor of ancestorsById.get(anchorId) ?? []) {
      if (isPage(ancestor)) return ancestor.id
    }
    return null
  }

  const ordered = [...trees.values()].sort((a, b) => b.lastEditedAt - a.lastEditedAt)
  const groups: RecentActivityGroup[] = []
  /** Open (still-extendable) entry per container — closed as soon as a
   *  tree arrives more than `gap` older than it. Since `ordered` is
   *  newest-first, only the most recent entry per container is open. */
  const open = new Map<string, {group: RecentActivityGroup; oldestEditedAt: number}>()

  for (const tree of ordered) {
    // Only lone edits look for a page to gather under. A tree that
    // already folded (an import, an outline typed out in one go) has its
    // own root to be titled by, and re-titling it by the page it happens
    // to sit on would lose exactly the structure fold 1 recovered.
    const containerId = tree.rows.length === 1 ? containerOf(tree.anchorId) : null
    const existing = containerId === null ? undefined : open.get(containerId)
    if (existing && existing.oldestEditedAt - tree.lastEditedAt <= gap) {
      existing.group.memberIds = [
        ...existing.group.memberIds,
        ...tree.rows.map(r => r.id).filter(id => id !== existing.group.anchorId),
      ]
      existing.oldestEditedAt = Math.min(
        existing.oldestEditedAt,
        ...tree.rows.map(editTime),
      )
      continue
    }

    const anchorId = containerId ?? tree.anchorId
    const group: RecentActivityGroup = {
      anchorId,
      anchorEdited: editedAt.has(anchorId),
      memberIds: tree.rows.map(r => r.id).filter(id => id !== anchorId),
      // The tree's own newest edit, NOT the container's: a page edited in
      // some other session has its own entry, and folding its timestamp
      // in here would stamp this entry with an edit it doesn't contain.
      lastEditedAt: tree.lastEditedAt,
    }
    groups.push(group)
    if (containerId !== null) {
      open.set(containerId, {
        group,
        oldestEditedAt: Math.min(...tree.rows.map(editTime)),
      })
    }
  }

  for (const group of groups) {
    // Members arrive tree-by-tree; re-sort so a merged entry reads
    // newest-first like the feed around it.
    group.memberIds = [...group.memberIds].sort(
      (a, b) => (editedAt.get(b) ?? 0) - (editedAt.get(a) ?? 0),
    )
  }
  return groups.sort((a, b) => b.lastEditedAt - a.lastEditedAt)
}
