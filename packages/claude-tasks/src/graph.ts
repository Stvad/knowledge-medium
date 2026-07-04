/**
 * Typed graph operations over the kmagent bridge — the daemon's (and
 * MCP server's) only channel into the live client. Everything here is
 * a thin shape-checked wrapper around wire commands; no business logic.
 */
import type { BridgeClient } from '@knowledge-medium/agent-cli/client'
import { PROPS, type TaskStatus } from './config.js'
import type { BlockView } from './watchers.js'

export interface HydratedRef {
  id: string
  content: string
  types: string[]
  deepLink: string
}

export interface BacklinkSource extends HydratedRef {
  sourceFields: string[]
}

interface BacklinksResult {
  target: HydratedRef
  workspaceId: string
  total: number
  backlinks: BacklinkSource[]
}

interface PageResult {
  match: HydratedRef | null
  candidates: Array<{id: string, alias: string}>
}

export interface BlockData extends BlockView {
  workspaceId?: string
}

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object') throw new Error(`Unexpected ${label} result shape`)
  return value as Record<string, unknown>
}

const parseProps = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** Property values arrive either as a real array or as a JSON-encoded
 *  string depending on the write path; accept both, keep only strings. */
const decodeStringList = (raw: unknown): string[] => {
  const keepStrings = (values: unknown[]) =>
    values.filter((entry): entry is string => typeof entry === 'string')
  if (Array.isArray(raw)) return keepStrings(raw)
  if (typeof raw !== 'string') return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? keepStrings(parsed) : []
  } catch {
    return []
  }
}

export const createGraph = (client: BridgeClient) => {
  const sqlAll = async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
    const result = await client.runCommand({type: 'sql', mode: 'all', sql, params})
    return Array.isArray(result) ? result : []
  }

  const resolvePageId = async (alias: string): Promise<string> => {
    const result = await client.runCommand({type: 'page', name: alias}) as PageResult
    if (!result.match) {
      throw new Error(
        `Watcher target page "${alias}" does not exist yet — create it (type [[${alias}]] once and click it) before the watcher can run.`,
      )
    }
    return result.match.id
  }

  /** All aliases of a page block (the `alias` property, list-encoded)
   *  plus its own id — the full set a wikilink/block-ref guard must
   *  block to prevent watcher re-trigger loops. */
  const targetGuardSet = async (alias: string): Promise<{id: string, aliases: string[]}> => {
    const id = await resolvePageId(alias)
    const block = await getBlock(id)
    const decoded = decodeStringList(block?.properties?.['alias'])
    return {id, aliases: [...new Set([alias, ...decoded])]}
  }

  const backlinkSources = async (blockId: string): Promise<BacklinkSource[]> => {
    const result = await client.runCommand({type: 'backlinks', id: blockId}) as BacklinksResult
    return result.backlinks ?? []
  }

  const getBlock = async (id: string): Promise<BlockData | null> => {
    const result = await client.runCommand({type: 'get-block', id})
    if (result === null || result === undefined) return null
    const raw = asRecord(result, 'get-block')
    const editedAt = raw.userUpdatedAt ?? raw.updatedAt
    return {
      ...(raw as unknown as BlockData),
      editedAtMs: typeof editedAt === 'number' ? editedAt : null,
    }
  }

  /** Ancestor chain, nearest first — ONE recursive-CTE query instead of
   *  a bridge round-trip per level (also narrows the pre-claim race
   *  window). Depth-capped so a corrupt parent cycle can't hang it. */
  const ancestors = async (id: string, maxDepth = 100): Promise<BlockData[]> => {
    const rows = await sqlAll(
      `WITH RECURSIVE anc(id, parent_id, content, properties_json, depth) AS (
         SELECT b.id, b.parent_id, b.content, b.properties_json, 0
           FROM blocks b
           WHERE b.id = (SELECT parent_id FROM blocks WHERE id = ?) AND b.deleted = 0
         UNION ALL
         SELECT p.id, p.parent_id, p.content, p.properties_json, anc.depth + 1
           FROM blocks p JOIN anc ON p.id = anc.parent_id
           WHERE anc.depth < ? AND p.deleted = 0
       )
       SELECT id, parent_id, content, properties_json FROM anc ORDER BY depth`,
      [id, maxDepth],
    )
    return rows.flatMap(row => {
      const {id: rowIdValue, parent_id, content, properties_json} = row as Record<string, unknown>
      if (typeof rowIdValue !== 'string') return []
      return [{
        id: rowIdValue,
        parentId: typeof parent_id === 'string' ? parent_id : null,
        content: typeof content === 'string' ? content : '',
        properties: parseProps(properties_json),
      }]
    })
  }

  const getSubtree = async (rootId: string): Promise<BlockData[]> => {
    const result = await client.runCommand({type: 'get-subtree', rootId})
    return Array.isArray(result) ? result as BlockData[] : []
  }

  // KNOWN LIMITATION: this write goes through the bridge `update-block`
  // command, which stamps user_updated_at/updatedBy like a user edit —
  // so a claimed mention jumps to the top of "recently edited" views.
  // It does NOT cause a re-trigger (decidePending only reads editedAtMs
  // when status is unset, and this sets status). A clean fix needs the
  // bridge to forward a skipMetadata flag to tx.update; not available yet.
  const setTaskProps = async (
    id: string,
    args: {
      status: TaskStatus, watcher?: string, session?: string | null, error?: string | null,
      attempts?: number, activity?: string | null, nowMs: number,
    },
  ): Promise<void> => {
    const properties: Record<string, unknown> = {
      [PROPS.status]: args.status,
      [PROPS.updatedAt]: args.nowMs,
    }
    if (args.watcher !== undefined) properties[PROPS.watcher] = args.watcher
    if (args.session !== undefined && args.session !== null) properties[PROPS.session] = args.session
    if (args.error !== undefined) properties[PROPS.error] = args.error ?? ''
    if (args.attempts !== undefined) properties[PROPS.attempts] = args.attempts
    if (args.activity !== undefined) properties[PROPS.activity] = args.activity ?? ''
    await client.runCommand({type: 'update-block', id, properties})
  }

  const createReply = async (parentId: string, content: string): Promise<BlockData> => {
    const result = await client.runCommand({
      type: 'create-block',
      parentId,
      content,
      properties: {[PROPS.reply]: true},
    })
    return asRecord(result, 'create-block') as unknown as BlockData
  }

  /** Transient "what the run is doing now" label — merged (update-block
   *  merges the properties map) so it never clobbers other claude:*
   *  state written concurrently. */
  const setActivity = async (id: string, label: string): Promise<void> => {
    await client.runCommand({type: 'update-block', id, properties: {[PROPS.activity]: label}})
  }

  /** Overwrite a block's content — used to stream the in-progress reply
   *  text into an early-created reply block. */
  const updateBlockContent = async (id: string, content: string): Promise<void> => {
    await client.runCommand({type: 'update-block', id, content})
  }

  /** Batched pending-decision views — ONE query per tick instead of a
   *  bridge round-trip per backlink source, so processed mentions stay
   *  cheap to re-scan forever. Includes the last-edit timestamp for the
   *  quiet-period gate. */
  const blockViews = async (ids: string[]): Promise<Map<string, BlockView>> => {
    const views = new Map<string, BlockView>()
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500)
      const placeholders = chunk.map(() => '?').join(', ')
      const rows = await sqlAll(
        `SELECT id, properties_json, coalesce(user_updated_at, updated_at) AS edited_at
           FROM blocks WHERE deleted = 0 AND id IN (${placeholders})`,
        chunk,
      )
      for (const row of rows) {
        const {id, properties_json, edited_at} = row as Record<string, unknown>
        if (typeof id !== 'string') continue
        views.set(id, {
          id,
          properties: parseProps(properties_json),
          editedAtMs: typeof edited_at === 'number' ? edited_at : null,
        })
      }
    }
    return views
  }

  return {
    resolvePageId,
    targetGuardSet,
    backlinkSources,
    getBlock,
    ancestors,
    getSubtree,
    setTaskProps,
    createReply,
    setActivity,
    updateBlockContent,
    sqlAll,
    blockViews,
  }
}

export type Graph = ReturnType<typeof createGraph>
