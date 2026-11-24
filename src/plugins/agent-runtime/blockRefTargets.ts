/**
 * The `((id))` marks an agent write adds must name live blocks of the active
 * workspace, the only one an agent write's tx admits. A mistyped or invented
 * id parses as a reference to nothing: refused, the agent retries; written,
 * it is a dead link the user finds later.
 */
import type { Tx } from '@/data/api'
import type { Repo } from '@/data/repo'
import { extractBlockRefIds, parseMarkdownBlockRefs } from '@/plugins/references/referenceParser.js'

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

/** Keep the answer deliverable when its author is no longer available to fix a link. */
export const markDanglingReplyLinks = async (
  tx: Tx,
  workspaceId: string,
  blocks: readonly {content: string}[],
  prunedIds: ReadonlySet<string>,
): Promise<void> => {
  const marksByBlock = blocks.map(({content}) => parseMarkdownBlockRefs(content))
  const targetIds = new Set(marksByBlock.flatMap(marks => marks.map(mark => mark.blockId)))
  if (targetIds.size === 0) return
  const liveRows = await tx.liveRowsForIds(workspaceId, [...targetIds])
  const liveIds = new Set(liveRows.filter(row => !prunedIds.has(row.id)).map(row => row.id))

  for (const [index, block] of blocks.entries()) {
    const edits: Array<{startIndex: number, endIndex: number, text: string}> = []
    for (const {blockId, startIndex, endIndex, labelSpan} of marksByBlock[index]) {
      if (liveIds.has(blockId)) continue
      const warning = `(broken block link: ${blockId})`
      if (labelSpan) {
        // Edit around the label so embedded references have disjoint edits.
        // The warning prefix keeps labels like "> quote" inline.
        edits.push(
          {startIndex, endIndex: labelSpan.startIndex, text: '⚠ '},
          {startIndex: labelSpan.endIndex, endIndex, text: ` ${warning}`},
        )
      } else {
        edits.push({startIndex, endIndex, text: warning})
      }
    }
    if (edits.length === 0) continue
    let content = ''
    let cursor = 0
    for (const edit of edits.sort((a, b) => a.startIndex - b.startIndex)) {
      content += block.content.slice(cursor, edit.startIndex) + edit.text
      cursor = edit.endIndex
    }
    block.content = content + block.content.slice(cursor)
  }
}
