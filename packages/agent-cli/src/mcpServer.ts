/**
 * km MCP server — live Knowledge Medium graph tools over the kmagent
 * bridge, for any MCP client.
 *
 * Deliberately narrower than the bridge: read tools + block-level
 * writes only. No eval, no sql execute, no extension lifecycle — a
 * spawned model gets graph access, not a JS interpreter in the app.
 *
 * Env:
 * - AGENT_RUNTIME_PROFILE: kmagent token profile (default "default")
 * - KM_MCP_BLOCKED_WIKILINKS: page aliases the write tools refuse to
 *   reference. JSON array; legacy comma-separated also accepted.
 *   Enforced against ALL
 *   reference syntaxes: each name is
 *   resolved to its page, and that page's full alias set plus its id
 *   ([[any-alias]], ((id)), (((id))) embeds/labels) is blocked.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { createBridgeClient, type BridgeClient } from './client.js'
import { renderSubtreeOutline, type SubtreeOutlineRow } from './subtreeOutline.js'
import { createBridgeGraph } from './graph.js'
import { BLOCKED_WIKILINKS_ENV, decodeBlockedWikilinks, findBlockedRef, findBlockedRefInProperties, isReadOnlySql, type KmMcpToolName, MCP_SERVER_NAME, type RefGuardSet } from './mcpShared.js'
import { moveBlockPositionSchema } from './protocol.js'

type MoveBlockPositionInput = z.infer<typeof moveBlockPositionSchema>

export interface GraphMcpServerOptions {
  client?: BridgeClient
  profile?: string
  timeoutMs?: number
  blockedWikilinks?: string[]
  serverOptions?: ConstructorParameters<typeof McpServer>[1]
}

export const createGraphMcpServer = (options: GraphMcpServerOptions = {}): McpServer => {
  const client = options.client ?? createBridgeClient({
    profile: options.profile ?? process.env.AGENT_RUNTIME_PROFILE,
    timeoutMs: options.timeoutMs ?? 60_000,
  })
  const graph = createBridgeGraph(client)

  // ----- write guard: optional re-trigger prevention ------------------

  const blockedNames = options.blockedWikilinks ?? decodeBlockedWikilinks(process.env[BLOCKED_WIKILINKS_ENV])

  let guardCache: {set: RefGuardSet, fetchedAt: number} | null = null
  const GUARD_TTL_MS = 10 * 60_000

  /** Resolve the blocked names to their pages' FULL alias sets + ids via
   *  the bridge (lazily, cached). A guard that only blocks the literal
   *  configured string is trivially bypassed with `((page-id))` or any
   *  other alias of the same page. Falls back to the raw names when a
   *  page can't be resolved (it may not exist yet). */
  const guardSet = async (): Promise<RefGuardSet> => {
    if (blockedNames.length === 0) return {aliases: [], ids: []}
    if (guardCache && Date.now() - guardCache.fetchedAt < GUARD_TTL_MS) return guardCache.set

    const aliases = new Set(blockedNames)
    const ids = new Set<string>()
    let complete = true
    for (const name of blockedNames) {
      try {
        const target = await graph.targetGuardSet(name)
        ids.add(target.id)
        for (const alias of target.aliases) aliases.add(alias)
      } catch {
        // Page missing / bridge hiccup: fall back to the raw-name guard,
        // but do NOT cache a partial fill — otherwise an id/alias bypass
        // would be open for the whole TTL. Retry on the next call.
        complete = false
      }
    }
    const set = {aliases: [...aliases], ids: [...ids]}
    if (complete) guardCache = {set, fetchedAt: Date.now()}
    return set
  }

  const assertNoBlockedRefs = async (
    content: string | undefined,
    properties?: Record<string, unknown>,
  ) => {
    if (blockedNames.length === 0) return
    if (!content && !properties) return
    const guard = await guardSet()
    const blocked =
      (content ? findBlockedRef(content, guard) : null)
      ?? findBlockedRefInProperties(properties, guard)
    if (blocked) {
      throw new Error(
        `Refusing to write "${blocked}": it references a blocked page. Refer to the page without linking it.`,
      )
    }
  }

  const propertiesFromJson = (value: unknown): Record<string, unknown> | undefined => {
    if (typeof value !== 'string') return undefined
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object'
        ? parsed as Record<string, unknown>
        : undefined
    } catch {
      return undefined
    }
  }

  const refsFromSqlRow = (
    row: unknown,
  ): {content?: string, properties?: Record<string, unknown>} => {
    if (!row || typeof row !== 'object') return {}
    const {content, properties_json} = row as {content?: unknown, properties_json?: unknown}
    const properties = propertiesFromJson(properties_json)
    return {
      ...(typeof content === 'string' ? {content} : {}),
      ...(properties ? {properties} : {}),
    }
  }

  const tombstoneRefsForGuard = async (
    id: string,
  ): Promise<{content?: string, properties?: Record<string, unknown>}> => {
    if (blockedNames.length === 0) return {}
    const rows = await graph.sqlAll(
      'SELECT content, properties_json FROM blocks WHERE id = ? LIMIT 1',
      [id],
    )
    return refsFromSqlRow(rows[0])
  }

  interface MoveSiblingRow {
    id: string
    orderKey: string
    content?: string
    properties?: Record<string, unknown>
  }

  const moveSiblingFromSqlRow = (row: unknown): MoveSiblingRow | null => {
    if (!row || typeof row !== 'object') return null
    const {id, order_key} = row as {id?: unknown, order_key?: unknown}
    if (typeof id !== 'string' || typeof order_key !== 'string') return null
    return {
      id,
      orderKey: order_key,
      ...refsFromSqlRow(row),
    }
  }

  interface DeleteGuardRow {
    id: string
    content?: string
    properties?: Record<string, unknown>
  }

  const deleteGuardRowFromSqlRow = (row: unknown): DeleteGuardRow | null => {
    if (!row || typeof row !== 'object') return null
    const {id} = row as {id?: unknown}
    if (typeof id !== 'string') return null
    return {id, ...refsFromSqlRow(row)}
  }

  const workspaceIdForMoveTarget = async (
    movedId: string,
    parentId: string | null,
  ): Promise<string | null> => {
    const targetId = parentId ?? movedId
    const rows = await graph.sqlAll(
      'SELECT workspace_id FROM blocks WHERE id = ? AND deleted = 0 LIMIT 1',
      [targetId],
    )
    const row = rows[0]
    if (!row || typeof row !== 'object') return null
    const {workspace_id} = row as {workspace_id?: unknown}
    return typeof workspace_id === 'string' ? workspace_id : null
  }

  const moveTiedRewriteRowsForGuard = async (
    input: {id: string, parentId: string | null, position: MoveBlockPositionInput},
  ): Promise<MoveSiblingRow[]> => {
    if (blockedNames.length === 0) return []
    const {id, parentId, position} = input
    if (position.kind !== 'before' && position.kind !== 'after') return []

    const workspaceId = await workspaceIdForMoveTarget(id, parentId)
    if (!workspaceId) return []
    const rows = parentId === null
      ? await graph.sqlAll(
        `SELECT id, content, properties_json, order_key
           FROM blocks
          WHERE workspace_id = ?
            AND parent_id IS NULL
            AND deleted = 0
            AND id <> ?
          ORDER BY order_key, id`,
        [workspaceId, id],
      )
      : await graph.sqlAll(
        `SELECT id, content, properties_json, order_key
           FROM blocks
          WHERE workspace_id = ?
            AND parent_id = ?
            AND deleted = 0
            AND id <> ?
          ORDER BY order_key, id`,
        [workspaceId, parentId, id],
      )
    const siblings = rows.flatMap(row => {
      const sibling = moveSiblingFromSqlRow(row)
      return sibling ? [sibling] : []
    })
    const anchor = siblings.findIndex(row => row.id === position.siblingId)
    if (anchor < 0) return []
    const anchorKey = siblings[anchor].orderKey

    if (position.kind === 'before') {
      const prev = anchor > 0 ? siblings[anchor - 1] : undefined
      if (!prev || prev.orderKey < anchorKey) return []
      let runEnd = anchor
      while (runEnd + 1 < siblings.length && siblings[runEnd + 1].orderKey === anchorKey) {
        runEnd++
      }
      return siblings.slice(anchor, runEnd + 1)
    }

    const next = anchor + 1 < siblings.length ? siblings[anchor + 1] : undefined
    if (!next || anchorKey < next.orderKey) return []
    let runEnd = anchor + 1
    while (runEnd + 1 < siblings.length && siblings[runEnd + 1].orderKey === anchorKey) {
      runEnd++
    }
    return siblings.slice(anchor + 1, runEnd + 1)
  }

  const assertNoBlockedRefsInLiveSubtree = async (rootId: string): Promise<void> => {
    if (blockedNames.length === 0) return
    const rootRows = await graph.sqlAll(
      'SELECT id, content, properties_json FROM blocks WHERE id = ? AND deleted = 0 LIMIT 1',
      [rootId],
    )
    const root = deleteGuardRowFromSqlRow(rootRows[0])
    if (!root) return

    const stack = [root]
    const seen = new Set<string>()
    while (stack.length > 0) {
      const row = stack.pop()!
      if (seen.has(row.id)) continue
      seen.add(row.id)
      await assertNoBlockedRefs(row.content, row.properties)

      const childRows = await graph.sqlAll(
        `SELECT id, content, properties_json
           FROM blocks
          WHERE parent_id = ?
            AND deleted = 0
          ORDER BY order_key, id`,
        [row.id],
      )
      for (const childRow of childRows) {
        const child = deleteGuardRowFromSqlRow(childRow)
        if (child) stack.push(child)
      }
    }
  }

  const json = (value: unknown) => ({
    content: [{type: 'text' as const, text: JSON.stringify(value, null, 2)}],
  })
  const text = (value: string) => ({
    content: [{type: 'text' as const, text: value}],
  })

  const server = new McpServer(
    {name: MCP_SERVER_NAME, version: '0.1.0'},
    options.serverOptions,
  )

  server.registerTool('get_block' satisfies KmMcpToolName, {
    description: 'Fetch a single block (content, properties, parentId) by id. For its children, use the subtree tool.',
    inputSchema: {id: z.string()},
  }, async ({id}) => json(await graph.getBlock(id)))

  server.registerTool('subtree' satisfies KmMcpToolName, {
    description: 'Fetch the subtree under a block as a depth-indented outline (one line per block: `- [<id>] <content> <propsJSON>`). '
    + "Each block's properties (e.g. status, type) are appended as compact JSON by default; pass includeProperties:false for the lean id+content form.",
    inputSchema: {rootId: z.string(), includeProperties: z.boolean().optional().default(true)},
  }, async ({rootId, includeProperties}) =>
    text(renderSubtreeOutline(await graph.getSubtree(rootId) as SubtreeOutlineRow[], {includeProperties})))

  server.registerTool('backlinks' satisfies KmMcpToolName, {
    description: 'List blocks that reference the given block/page (hydrated: id, content, deepLink).',
    inputSchema: {id: z.string()},
  }, async ({id}) => json(await graph.backlinkSources(id)))

  server.registerTool('page' satisfies KmMcpToolName, {
    description: 'Resolve a page by alias/title. Returns the exact match (if any) plus substring candidates.',
    inputSchema: {name: z.string()},
  }, async ({name}) => json(await client.runCommand({type: 'page', name})))

  server.registerTool('daily_note' satisfies KmMcpToolName, {
    description: 'Resolve a date expression (today | yesterday | ISO date | natural language) to its daily-note block.',
    inputSchema: {date: z.string()},
  }, async ({date}) => json(await client.runCommand({type: 'daily-note', date})))

  server.registerTool('search' satisfies KmMcpToolName, {
    description: 'Full-text search over block content.',
    inputSchema: {query: z.string(), limit: z.number().int().positive().optional()},
  }, async ({query, limit}) => json(await client.runCommand({type: 'search', query, limit})))

  server.registerTool('sql_query' satisfies KmMcpToolName, {
    description: 'Run a read-only SQL query (single SELECT/WITH statement) against the client database. Key tables: blocks(id, content, properties_json, parent_id, workspace_id).',
    inputSchema: {sql: z.string(), params: z.array(z.unknown()).optional()},
  }, async ({sql, params}) => {
    if (!isReadOnlySql(sql)) {
      throw new Error('sql_query only accepts a single read-only statement (SELECT, or WITH without mutating keywords). Use create_block / update_block / move_block / delete_block / restore_block for writes.')
    }
    return json(await graph.sqlAll(sql, params ?? []))
  })

  server.registerTool('create_block' satisfies KmMcpToolName, {
    description: 'Create a new block under a parent. Content is markdown; [[Page]] wikilinks create references.',
    inputSchema: {
      parentId: z.string(),
      content: z.string(),
      properties: z.record(z.string(), z.unknown()).optional(),
    },
  }, async ({parentId, content, properties}) => {
    await assertNoBlockedRefs(content, properties)
    return json(await graph.createBlock(parentId, content, properties))
  })

  server.registerTool('update_block' satisfies KmMcpToolName, {
    description: 'Update a block\'s content and/or merge properties.',
    inputSchema: {
      id: z.string(),
      content: z.string().optional(),
      properties: z.record(z.string(), z.unknown()).optional(),
    },
  }, async ({id, content, properties}) => {
    await assertNoBlockedRefs(content, properties)
    return json(await graph.updateBlock(id, {content, properties}))
  })

  server.registerTool('move_block' satisfies KmMcpToolName, {
    description: 'Move a block under a new parent, or to the workspace root with parentId:null. Positions: first, last, before/after siblingId.',
    inputSchema: {
      id: z.string(),
      parentId: z.string().nullable(),
      position: moveBlockPositionSchema,
    },
  }, async ({id, parentId, position}) => {
    const block = await graph.getBlock(id)
    await assertNoBlockedRefs(block?.content, block?.properties)
    const tiedRewriteRows = await moveTiedRewriteRowsForGuard({id, parentId, position})
    for (const row of tiedRewriteRows) {
      await assertNoBlockedRefs(row.content, row.properties)
    }
    return json(await graph.moveBlock({id, parentId, position}))
  })

  server.registerTool('delete_block' satisfies KmMcpToolName, {
    description: 'Soft-delete a block and its descendants.',
    inputSchema: {
      id: z.string(),
    },
  }, async ({id}) => {
    await assertNoBlockedRefsInLiveSubtree(id)
    return json(await graph.deleteBlock(id))
  })

  server.registerTool('restore_block' satisfies KmMcpToolName, {
    description: 'Restore one soft-deleted block. Descendants remain deleted unless restored separately.',
    inputSchema: {
      id: z.string(),
    },
  }, async ({id}) => {
    const {content, properties} = await tombstoneRefsForGuard(id)
    await assertNoBlockedRefs(content, properties)
    return json(await graph.restoreBlock(id))
  })

  return server
}
