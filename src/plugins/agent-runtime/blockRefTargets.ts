/**
 * The `((id))` marks an agent write adds must name live blocks of the active
 * workspace, the only one an agent write's tx admits. A mistyped or invented
 * id parses as a reference to nothing: refused, the agent retries; written,
 * it is a dead link the user finds later.
 */
import type { Repo } from '@/data/repo'
import { extractBlockRefIds } from '@/plugins/references/referenceParser.js'

const TARGET_ROWS_SQL = `
  SELECT b.id AS id, b.workspace_id AS workspaceId, b.deleted AS deleted
    FROM json_each(?) j JOIN blocks b ON b.id = j.value
`

/** Refuses the write when `texts` add a block-ref mark whose target is
 *  missing, deleted or in another workspace. `replaced` reads the content the
 *  write replaces: a mark it already holds is not refused, so a block carrying
 *  an old dead link stays editable. It answers null for a block that does not
 *  exist, which the verb then reports itself. Text without a mark costs one
 *  parse and no reads.
 *
 *  A mark inside code counts: the reference index reads raw content and
 *  records it, though the renderer shows it as code. Only the inline UUID
 *  grammar is read: no view prints an id fragment, and the broad whole-block
 *  class would refuse prose like `((x))`.
 *
 *  Checked before the write's tx, so a target deleted between the check and
 *  the commit is written as a dead link: a window of one read, accepted. */
export const refuseDanglingBlockRefs = async (
  repo: Repo,
  verb: string,
  texts: ReadonlyArray<string | undefined>,
  replaced?: () => Promise<string | null>,
): Promise<void> => {
  const added = new Set(texts.flatMap(text => text ? extractBlockRefIds(text) : []))
  const workspaceId = repo.activeWorkspaceId
  if (added.size === 0 || !workspaceId) return
  const before = replaced ? await replaced() : ''
  if (before === null) return
  for (const id of extractBlockRefIds(before)) added.delete(id)

  const rows = await repo.db.getAll<{id: string, workspaceId: string, deleted: number}>(
    TARGET_ROWS_SQL, [JSON.stringify([...added])],
  )
  const byId = new Map(rows.map(row => [row.id, row]))
  const dangling: string[] = []
  for (const id of added) {
    const row = byId.get(id)
    if (row && row.deleted === 0 && row.workspaceId === workspaceId) continue
    const facts = !row ? 'no block has this id' : row.deleted ? 'deleted' : 'a block of another workspace'
    dangling.push(`  ((${id})) — ${facts}`)
  }
  if (dangling.length === 0) return
  throw new Error(
    `${verb}: the content links blocks that are not live in this workspace — nothing was written:\n`
    + `${dangling.join('\n')}\n`
    + 'A ((ref)) takes a block\'s id as the views print it after ^.',
  )
}
