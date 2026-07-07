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
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { createBridgeClient, type BridgeClient } from './client.js'
import { renderSubtreeOutline, type SubtreeOutlineRow } from './subtreeOutline.js'
import { createBridgeGraph, type BridgeGraph } from './graph.js'
import { isReadOnlySql, type KmMcpToolName, MCP_SERVER_NAME } from './mcpShared.js'
import { moveBlockPositionSchema } from './protocol.js'

interface PackageJson {
  version?: unknown
}

const agentCliPackageVersion = (() => {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  const pkg = JSON.parse(raw) as PackageJson
  if (typeof pkg.version !== 'string') {
    throw new Error('@knowledge-medium/agent-cli package.json is missing a string version')
  }
  return pkg.version
})()

type MoveBlockPositionInput = z.infer<typeof moveBlockPositionSchema>

export type GraphMcpWriteOperation =
  | {type: 'create_block', parentId: string, content: string, properties?: Record<string, unknown>}
  | {type: 'update_block', id: string, content?: string, properties?: Record<string, unknown>}
  | {type: 'move_block', id: string, parentId: string | null, position: MoveBlockPositionInput}
  | {type: 'delete_block', id: string}
  | {type: 'restore_block', id: string}

export interface GraphMcpWriteGuard {
  beforeWrite: (operation: GraphMcpWriteOperation) => void | Promise<void>
}

export interface GraphMcpWriteGuardContext {
  client: BridgeClient
  graph: BridgeGraph
}

export interface GraphMcpServerOptions {
  client?: BridgeClient
  profile?: string
  timeoutMs?: number
  writeGuard?: GraphMcpWriteGuard | ((context: GraphMcpWriteGuardContext) => GraphMcpWriteGuard)
  serverOptions?: ConstructorParameters<typeof McpServer>[1]
}

export const createGraphMcpServer = (options: GraphMcpServerOptions = {}): McpServer => {
  const client = options.client ?? createBridgeClient({
    profile: options.profile ?? process.env.AGENT_RUNTIME_PROFILE,
    timeoutMs: options.timeoutMs ?? 60_000,
  })
  const graph = createBridgeGraph(client)
  const writeGuard = typeof options.writeGuard === 'function'
    ? options.writeGuard({client, graph})
    : options.writeGuard

  const beforeWrite = async (operation: GraphMcpWriteOperation) => {
    await writeGuard?.beforeWrite(operation)
  }

  const json = (value: unknown) => ({
    content: [{type: 'text' as const, text: JSON.stringify(value, null, 2)}],
  })
  const text = (value: string) => ({
    content: [{type: 'text' as const, text: value}],
  })

  const server = new McpServer(
    {name: MCP_SERVER_NAME, version: agentCliPackageVersion},
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
    await beforeWrite({type: 'create_block', parentId, content, properties})
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
    await beforeWrite({type: 'update_block', id, content, properties})
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
    await beforeWrite({type: 'move_block', id, parentId, position})
    return json(await graph.moveBlock({id, parentId, position}))
  })

  server.registerTool('delete_block' satisfies KmMcpToolName, {
    description: 'Soft-delete a block and its descendants.',
    inputSchema: {
      id: z.string(),
    },
  }, async ({id}) => {
    await beforeWrite({type: 'delete_block', id})
    return json(await graph.deleteBlock(id))
  })

  server.registerTool('restore_block' satisfies KmMcpToolName, {
    description: 'Restore one soft-deleted block. Descendants remain deleted unless restored separately.',
    inputSchema: {
      id: z.string(),
    },
  }, async ({id}) => {
    await beforeWrite({type: 'restore_block', id})
    return json(await graph.restoreBlock(id))
  })

  return server
}
