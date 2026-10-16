/**
 * The checker's view of the graph: raw wire commands and read-only SQL,
 * never the MCP tools under test, so a change to a tool's output cannot
 * change how its task is scored.
 */

export interface GraphProbe {
  workspaceId: string
  command: (command: Record<string, unknown>) => Promise<unknown>
}

export interface BlockRow {
  id: string
  parent_id: string | null
  content: string
  order_key: string
  properties_json: string
  created_at: number
  updated_at: number
  deleted: number
}

const BLOCK_COLUMNS = 'id, parent_id, content, order_key, properties_json, created_at, updated_at, deleted'

export const sqlAll = async <T>(probe: GraphProbe, sql: string, params: unknown[] = []): Promise<T[]> =>
  await probe.command({type: 'sql', mode: 'all', sql, params}) as T[]

export const pageIdByTitle = async (probe: GraphProbe, title: string): Promise<string | null> => {
  const result = await probe.command({type: 'page', name: title}) as {match?: {id: string} | null}
  return result.match?.id ?? null
}

export const requirePageId = async (probe: GraphProbe, title: string): Promise<string> => {
  const id = await pageIdByTitle(probe, title)
  if (!id) throw new Error(`fixture page not found: "${title}" — is the fixture seeded? (pnpm agent-eval seed)`)
  return id
}

export const dailyNoteId = async (probe: GraphProbe, date: string): Promise<string> => {
  const result = await probe.command({type: 'daily-note', date}) as {blockId: string}
  return result.blockId
}

export const childrenOf = (probe: GraphProbe, parentId: string): Promise<BlockRow[]> =>
  sqlAll<BlockRow>(probe,
    `SELECT ${BLOCK_COLUMNS} FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id`,
    [parentId])

export const descendantsOf = (probe: GraphProbe, rootId: string): Promise<BlockRow[]> =>
  sqlAll<BlockRow>(probe, `
    WITH RECURSIVE tree(id) AS (
      SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0
      UNION ALL
      SELECT b.id FROM blocks b JOIN tree ON b.parent_id = tree.id WHERE b.deleted = 0
    )
    SELECT ${BLOCK_COLUMNS} FROM blocks WHERE id IN (SELECT id FROM tree)`,
  [rootId])

/** Every block written since `since` (ms), deleted ones included. */
export const changedSince = (probe: GraphProbe, since: number): Promise<BlockRow[]> =>
  sqlAll<BlockRow>(probe,
    `SELECT ${BLOCK_COLUMNS} FROM blocks WHERE workspace_id = ? AND updated_at >= ? ORDER BY created_at, id`,
    [probe.workspaceId, since])

/** Hard-deletes blocks and everything under them, deleted rows included, so
 *  nothing is left for an agent's raw SQL to find. A raw write to a synced
 *  table: the eval only ever runs on a tab that has never synced. */
export const purgeBlocks = async (probe: GraphProbe, ids: readonly string[]): Promise<void> => {
  for (let start = 0; start < ids.length; start += 200) {
    const chunk = ids.slice(start, start + 200)
    await probe.command({
      type: 'sql',
      mode: 'execute',
      allowSyncedWrite: true,
      params: [probe.workspaceId, ...chunk],
      sql: `WITH RECURSIVE doomed(id) AS (
          SELECT id FROM blocks WHERE workspace_id = ? AND id IN (${chunk.map(() => '?').join(', ')})
          UNION ALL
          SELECT b.id FROM blocks b JOIN doomed ON b.parent_id = doomed.id
        )
        DELETE FROM blocks WHERE id IN (SELECT id FROM doomed)`,
    })
  }
}

export const getBlock = async (probe: GraphProbe, id: string) =>
  await probe.command({type: 'get-block', id}) as {id: string, content: string, properties: Record<string, unknown>} | null
