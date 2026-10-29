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
import {registryRecognitionParams} from '@/data/internals/kernelQueries.js'
import {recognizedFieldRowSql} from '@/data/internals/treeQueries.js'
import type {Repo} from '@/data/repo'
import {attributionCreatorsProp, contributorKindProp} from '@/plugins/contributors/schema.js'
import {annotationStatusProp, annotationTargetProp, THREAD_TYPE} from './schema.ts'

/** `covered(id, thread_id, workspace_id)`: the scope root, its visible
 *  descendants, each thread root anchored to a covered block, and that root's
 *  visible descendants, its comments. `thread_id` is the thread a row belongs
 *  to (the root's own id on the root), NULL for the scope's own blocks.
 *  UNION dedups, so a cycle ends. Binds the scope id, then what `fieldRow`
 *  binds.
 *
 *  DEFENCE IN DEPTH: the `workspace_id` equalities. Sync applies parent ids
 *  and rewrites `workspace_id` verbatim, so a covered block's child or
 *  referrer can sit in another workspace. */
const coveredCte = (fieldRow: (rowRef: string) => string): string => `
  WITH RECURSIVE covered(id, thread_id, workspace_id) AS (
    SELECT id, NULL, workspace_id FROM blocks WHERE id = ? AND deleted = 0
    UNION
    SELECT child.id, covered.thread_id, covered.workspace_id
      FROM covered
      JOIN blocks child ON child.parent_id = covered.id
     WHERE child.deleted = 0 AND child.workspace_id = covered.workspace_id
       AND NOT (${fieldRow('child')})
    UNION
    SELECT root.id, root.id, covered.workspace_id
      FROM covered
      JOIN block_references edge
        ON edge.target_id = covered.id AND edge.source_field = '${annotationTargetProp.name}'
      JOIN blocks root ON root.id = edge.source_id
     WHERE root.deleted = 0 AND root.workspace_id = covered.workspace_id
       AND EXISTS (SELECT 1 FROM block_types t WHERE t.block_id = root.id AND t.type = '${THREAD_TYPE}')
  )`

const THREAD_IDS_IN_SCOPE_SQL = `${coveredCte(recognizedFieldRowSql)}
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
    [scopeId, ...registryRecognitionParams(repo)],
  )
  return [...new Set(rows.map(row => row.id))]
}

/** The quiet period the comments recipe waits for, the mention watcher's
 *  default `quietMs`, so both ways of waking an agent wait alike. */
export const COMMENTS_RECIPE_QUIET_MS = 15_000

/** The `query` watcher recipe for monitoring a scope: comment ids, at any
 *  depth, of OPEN threads in the scope, that are non-empty, quiet for
 *  {@link COMMENTS_RECIPE_QUIET_MS} (measured on `coalesce(user_updated_at,
 *  updated_at)`), not created by an agent or automation contributor (the
 *  loop guard), and mentioning none of the given dispatch target pages (the
 *  mention watcher answers those). Binds `[scopeId, targetPageIdsJson]`.
 *
 *  It runs as a watcher's raw SQL, where the registry is out of reach, so it
 *  treats every `::` field row as one; the scope read above asks the
 *  registry. */
export const COMMENTS_RECIPE_SQL = `${coveredCte(rowRef => `COALESCE(${rowRef}.is_field_form, 0) = 1`)}
  SELECT DISTINCT comment.id, covered.thread_id AS thread_id, comment.content
    FROM covered
    JOIN blocks comment ON comment.id = covered.id
    JOIN blocks root ON root.id = covered.thread_id
    LEFT JOIN blocks author
      ON author.id = json_extract(comment.properties_json, '$."${attributionCreatorsProp.name}"[0]')
   WHERE covered.thread_id IS NOT NULL AND covered.id != covered.thread_id
     AND COALESCE(json_extract(root.properties_json, '$."${annotationStatusProp.name}"'), 'open') = 'open'
     AND trim(comment.content) != ''
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
