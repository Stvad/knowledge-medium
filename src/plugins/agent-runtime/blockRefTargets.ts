/**
 * The `((id))` marks an agent write adds must name live blocks of the
 * workspace it writes to. The read views print ids as `^shortid`, and an id
 * completed from one parses as a reference to nothing: refused, the agent
 * retries; written, it is a dead link the user finds later.
 */
import type { Repo } from '@/data/repo'
import { extractBlockRefIds } from '@/plugins/references/referenceParser.js'
import { PREFIX_RANGE_SQL, SHORT_ID_LENGTHS } from './agentViews/resolveRef.ts'
import { clipLine, textHeadSql } from './agentViews/text.ts'

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

const PREFIX_CANDIDATES = 3

const PREFIX_CANDIDATES_SQL = `
  SELECT id, ${textHeadSql('content', 200)} AS content FROM blocks
   WHERE ${PREFIX_RANGE_SQL} AND workspace_id = ? AND deleted = 0
   ORDER BY id
   LIMIT ${PREFIX_CANDIDATES}
`

/** What there is instead of `id`: the live blocks sharing its first
 *  shortid-length characters, the part of an id the read views print. */
const missingTargetFacts = async (repo: Repo, workspaceId: string, id: string): Promise<string> => {
  const prefix = id.slice(0, SHORT_ID_LENGTHS[0])
  const rows = await repo.db.getAll<{id: string, content: string | null}>(
    PREFIX_CANDIDATES_SQL, [prefix, prefix, workspaceId],
  )
  if (rows.length === 0) return 'no block has this id'
  return `no block has this id; live blocks whose id starts with ${prefix}:`
    + rows.map(row => `\n      ${row.id}  ${clipLine(row.content ?? '', 60).text}`).join('')
}

/** Refuses the write when `texts` add a block-ref mark whose target is
 *  missing, deleted or in another workspace. Text without a mark costs one
 *  parse: `destination` is read only when there is one, and answers null for
 *  a written block that does not exist, which the verb then reports itself.
 *
 *  Checked before the write's tx, not inside it: the hint reads through
 *  `repo.db`, which a write tx would deadlock on, and a target deleted in the
 *  gap is the same dead link as one deleted right after the commit. */
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
    const facts = !row ? await missingTargetFacts(repo, where.workspaceId, id)
      : row.deleted ? 'deleted'
        : 'a block of another workspace'
    dangling.push(`  ((${id})) — ${facts}`)
  }
  if (dangling.length === 0) return
  throw new Error(
    `${verb}: the content links blocks that are not live in this workspace — nothing was written:\n`
    + `${dangling.join('\n')}\n`
    + 'A ((ref)) takes a block\'s full id, which get_block prints in parentheses after its ^shortid.',
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
