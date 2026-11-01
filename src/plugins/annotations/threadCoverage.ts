import {annotationTargetProp, THREAD_TYPE} from './schema.ts'

/** Seeds select `(start_id, id, thread_id, workspace_id)`. Each start owns a
 *  downward walk through ordinary children and threads targeting covered
 *  blocks. A nested thread root enters only through its target, so moving it
 *  under another thread never transfers ownership of its comments.
 *
 *  UNION deduplicates complete rows and terminates cycles. The parent index
 *  avoids a workspace scan per child step. Workspace equalities are defence
 *  in depth for cross-workspace parent or target edges applied by sync. */
export const threadCoverageCte = (seedsSql: string, fieldRow: (rowRef: string) => string): string => `
  WITH RECURSIVE covered(start_id, id, thread_id, workspace_id) AS (
    ${seedsSql}
    UNION
    SELECT covered.start_id, child.id, covered.thread_id, covered.workspace_id
      FROM covered
      JOIN blocks child INDEXED BY idx_blocks_parent_order ON child.parent_id = covered.id
     WHERE child.deleted = 0 AND child.workspace_id = covered.workspace_id
       AND NOT (${fieldRow('child')})
       AND NOT EXISTS (SELECT 1 FROM block_types t WHERE t.block_id = child.id AND t.type = '${THREAD_TYPE}')
    UNION
    SELECT covered.start_id, root.id, root.id, covered.workspace_id
      FROM covered
      JOIN block_references edge
        ON edge.target_id = covered.id AND edge.source_field = '${annotationTargetProp.name}'
      JOIN blocks root ON root.id = edge.source_id
     WHERE root.deleted = 0 AND root.workspace_id = covered.workspace_id
       AND EXISTS (SELECT 1 FROM block_types t WHERE t.block_id = root.id AND t.type = '${THREAD_TYPE}')
  )`
