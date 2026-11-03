/**
 * The `((id))` marks an agent write adds must name live blocks of the
 * workspace it writes to. A mistyped or invented id parses as a reference to
 * nothing: refused, the agent retries; written, it is a dead link the user
 * finds later.
 */
import type { Repo } from '@/data/repo'
import { extractBlockRefIds } from '@/plugins/references/referenceParser.js'

interface RefDestination {
  workspaceId: string
  /** The content the write replaces. A mark it already holds is not refused,
   *  so a block carrying an old dead link stays editable. */
  before?: string
}

const TARGET_ROWS_SQL = `
  SELECT b.id AS id, b.workspace_id AS workspaceId, b.deleted AS deleted
    FROM json_each(?) j JOIN blocks b ON b.id = j.value
`

/** Refuses the write when `texts` add a block-ref mark whose target is
 *  missing, deleted or in another workspace. Text without a mark costs one
 *  parse: `destination` is read only when there is one, and answers null for
 *  a written block that does not exist, which the verb then reports itself.
 *
 *  A mark inside code counts: the reference index reads raw content and
 *  records it, though the renderer shows it as code.
 *
 *  Checked before the write's tx: a target deleted between the check and the
 *  commit is the same dead link as one deleted right after it. */
export const refuseDanglingBlockRefs = async (
  repo: Repo,
  verb: string,
  texts: ReadonlyArray<string | undefined>,
  destination: () => Promise<RefDestination | null>,
): Promise<void> => {
  const added = new Set(texts.flatMap(text => text ? extractBlockRefIds(text) : []))
  if (added.size === 0) return
  const where = await destination()
  if (!where) return
  for (const id of extractBlockRefIds(where.before ?? '')) added.delete(id)

  const rows = await repo.db.getAll<{id: string, workspaceId: string, deleted: number}>(
    TARGET_ROWS_SQL, [JSON.stringify([...added])],
  )
  const byId = new Map(rows.map(row => [row.id, row]))
  const dangling: string[] = []
  for (const id of added) {
    const row = byId.get(id)
    if (row && row.deleted === 0 && row.workspaceId === where.workspaceId) continue
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

/** The destination of a write that changes the block `id`. */
export const blockDestination = (repo: Repo, id: string) => async (): Promise<RefDestination | null> => {
  const block = await repo.load(id)
  return block && {workspaceId: block.workspaceId, before: block.content}
}

/** The destination of a write that creates blocks: the active workspace, the
 *  only one an agent write's tx admits. */
export const newBlockDestination = (repo: Repo) => async (): Promise<RefDestination | null> => {
  const workspaceId = repo.activeWorkspaceId
  return workspaceId ? {workspaceId} : null
}
