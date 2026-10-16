/**
 * km MCP server — live Knowledge Medium graph tools over the kmagent
 * bridge, for any MCP client.
 *
 * Deliberately narrower than the bridge: read tools (generated from
 * `GRAPH_READ_TOOLS`, shared with the CLI) + block-level
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
import { createBridgeGraph, type BridgeGraph } from './graph.js'
import { type KmMcpToolName, MCP_SERVER_NAME } from './mcpShared.js'
import { moveBlockPositionSchema } from './protocol.js'
import { GRAPH_READ_TOOLS, renderToolResult, toolCommand } from './readTools.js'

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

/** What every km-mcp client is told about the graph; a caller's own
 *  `serverOptions.instructions` is appended after it. */
export const KM_MCP_INSTRUCTIONS = `Knowledge Medium is an outliner: everything is a block (markdown content plus typed properties) nested under a parent. A page is a top-level block whose content is its title; [[Page name]] in content links to a page; a block's backlinks are the blocks that reference it. Daily notes are pages, one per date.

Addressing: get_block, subtree, backlinks, grouped_backlinks and search's \`under\` take a block as a full id, a unique id prefix as printed (^3f2a9c1d), a page name, or a date (today, yesterday, 2026-06-18) for that day's daily note. The write tools take full ids: format: "json" gives the exact id (text output clips an unusually long one).

The views (get_block, subtree, backlinks, grouped_backlinks, search) and sql_query are bounded and say so (page and daily_note return a short lookup): an outline line is \`- content  key:: value  ^shortid\`, \`(+N children)\` marks children not expanded, \`…[+N chars]\` marks cut text (get_block reads it a page at a time: pass its nextContentOffset as contentOffset until that is null), and a cut-off list ends with the offset to continue from. Pass format: "json" for structured output.

Start with subtree on a page name or "today" for an overview, search for text (filters: types, under, includeExtensions), backlinks / grouped_backlinks for what references something. guide explains the data model; sql_query is the escape hatch (read-only, rows capped).`

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
    {
      ...options.serverOptions,
      instructions: options.serverOptions?.instructions
        ? `${KM_MCP_INSTRUCTIONS}\n\n${options.serverOptions.instructions}`
        : KM_MCP_INSTRUCTIONS,
    },
  )

  for (const tool of GRAPH_READ_TOOLS) {
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.shape,
    }, async input => text(renderToolResult(await client.runCommand(toolCommand(tool, input)))))
  }

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
