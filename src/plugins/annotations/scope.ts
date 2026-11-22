/**
 * The threads a scope covers, for agents: every thread anchored to a block
 * under the scope, and, recursively, every thread anchored to a comment of a
 * covered thread, such as an annotation on a comment. Those threads live under
 * `Comments (km)`, not under the scope, so a subtree walk alone misses them;
 * the typed query language can't say it either, since its target operator
 * matches a target's properties, not its ancestry.
 *
 * Plain SQL rather than a registered query: its readers are one-shot agent
 * reads and a dispatch watcher's poll, and a reactive handle would need a
 * dependency on every covered block's children and target edges.
 */

import {USER_TYPE} from '@/data/blockTypes'
import type {Repo} from '@/data/repo'
import {attributionCreatorsProp, contributorKindProp} from '@/plugins/contributors/schema.js'
import {annotationStatusProp, annotationTargetProp, THREAD_TYPE} from './schema.ts'

/** `covered(id, thread_id, workspace_id, is_comment)`: the scope root, its
 *  structural descendants, each thread root anchored to a covered block, and
 *  that root's comment descendants. `thread_id` is the thread a row belongs
 *  to (the root's own id on the root), NULL for the scope's own blocks.
 *  `is_comment` marks ordinary comment rows. A thread root starts a comment
 *  subtree; field rows turn the mark off without pruning them from discovery.
 *  UNION dedups, so a cycle ends. Binds the scope id.
 *
 *  The descent stops at a thread root: a root is covered only through its
 *  target, so one moved by hand under another thread's comment keeps its own
 *  comments to itself. Property rows are ordinary scope descendants and can
 *  have threads; within a thread's comment tree, field rows stay metadata.
 *
 *  The `INDEXED BY` is load-bearing, as on `SUBTREE_SQL` (treeQueries.ts):
 *  without it the workspace equality below leads the planner to scan the
 *  workspace index for every covered row. The anchor step's first `CROSS JOIN`
 *  is load-bearing the same way: it keeps the edge probe on
 *  `idx_block_references_target`; without it a large graph's stats build an
 *  automatic index over the edges instead, and without either `CROSS JOIN`
 *  the planner drives from `root` through an automatic index over every live
 *  block, walked per covered row (scopeJoinOrder.test.ts). DEFENCE IN DEPTH:
 *  the second, which keeps `root` from leading; no current plan needs it.
 *
 *  DEFENCE IN DEPTH: the `workspace_id` equalities. Sync applies parent ids
 *  and rewrites `workspace_id` verbatim, so a covered block's child or
 *  referrer can sit in another workspace. */
const COVERED_CTE = `
  WITH RECURSIVE covered(id, thread_id, workspace_id, is_comment) AS (
    SELECT id, NULL, workspace_id, 0 FROM blocks WHERE id = ? AND deleted = 0
    UNION
    SELECT child.id, covered.thread_id, covered.workspace_id,
           covered.is_comment AND NOT (COALESCE(child.is_field_form, 0) = 1)
      FROM covered
      JOIN blocks child INDEXED BY idx_blocks_parent_order ON child.parent_id = covered.id
     WHERE child.deleted = 0 AND child.workspace_id = covered.workspace_id
       AND NOT EXISTS (SELECT 1 FROM block_types t WHERE t.block_id = child.id AND t.type = '${THREAD_TYPE}')
    UNION
    SELECT root.id, root.id, covered.workspace_id, 1
      FROM covered
      CROSS JOIN block_references edge
        ON edge.target_id = covered.id AND edge.source_field = '${annotationTargetProp.name}'
      CROSS JOIN blocks root ON root.id = edge.source_id
     WHERE root.deleted = 0 AND root.workspace_id = covered.workspace_id
       AND EXISTS (SELECT 1 FROM block_types t WHERE t.block_id = root.id AND t.type = '${THREAD_TYPE}')
  )`

export const THREAD_IDS_IN_SCOPE_SQL = `${COVERED_CTE}
  SELECT covered.id FROM covered
    JOIN blocks root ON root.id = covered.id
   WHERE covered.thread_id = covered.id
   ORDER BY root.created_at DESC, root.id
`

/** Thread roots in `scopeId`'s scope (see the header), newest first; empty
 *  for a missing or deleted scope. Closed threads included. */
export const threadIdsInScope = async (repo: Repo, scopeId: string): Promise<string[]> => {
  const rows = await repo.db.getAll<{id: string}>(
    THREAD_IDS_IN_SCOPE_SQL,
    [scopeId],
  )
  return rows.map(row => row.id)
}

/** The quiet period the comments recipe waits for. A watcher's raw SQL has no
 *  view of the mention watcher's edit hold, so this is time alone. */
export const COMMENTS_RECIPE_QUIET_MS = 15_000

/** The `query` watcher recipe for monitoring a scope: comment ids, at any
 *  depth, of OPEN threads in the scope, that are non-empty, quiet for
 *  {@link COMMENTS_RECIPE_QUIET_MS} (measured on `coalesce(user_updated_at,
 *  updated_at)`), not created by an agent or automation contributor (the
 *  loop guard), and mentioning none of the given dispatch target pages (the
 *  mention watcher answers those). Binds `[scopeId, targetPageIdsJson]`.
 *
 *  It runs as a watcher's raw SQL, where the registry is out of reach, so it
 *  treats every `::` field row as metadata. The recursive `is_comment` bit
 *  follows only non-field rows after
 *  an annotation edge; property rows remain in discovery so annotations on
 *  them are found, but aren't emitted as comment text. */
export const COMMENTS_RECIPE_SQL = `${COVERED_CTE}
  SELECT comment.id, covered.thread_id AS thread_id, comment.content
    FROM covered
    JOIN blocks comment ON comment.id = covered.id
    JOIN blocks root ON root.id = covered.thread_id
    LEFT JOIN blocks author
      ON author.id = json_extract(comment.properties_json, '$."${attributionCreatorsProp.name}"[0]')
   WHERE covered.is_comment = 1
     AND covered.id != covered.thread_id
     AND COALESCE(json_extract(root.properties_json, '$."${annotationStatusProp.name}"'), 'open') = 'open'
     AND trim(comment.content, ' ' || char(9, 10, 13)) != ''
     AND COALESCE(comment.user_updated_at, comment.updated_at)
         <= CAST(strftime('%s', 'now') AS INTEGER) * 1000 - ${COMMENTS_RECIPE_QUIET_MS}
     AND (
       json_extract(comment.properties_json, '$."${attributionCreatorsProp.name}"[0]') IS NULL
       OR EXISTS (SELECT 1 FROM block_types t WHERE t.block_id = author.id AND t.type = '${USER_TYPE}')
       OR json_extract(author.properties_json, '$."${contributorKindProp.name}"') = 'human'
     )
     AND NOT EXISTS (
       SELECT 1 FROM block_references mention
        WHERE mention.source_id = comment.id
          AND mention.target_id IN (SELECT value FROM json_each(?))
     )
`
