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
import { moveBlockPositionSchema, TODO_WRITE_HELP, toDisplayJson, WRITE_TARGET_HELP } from './protocol.js'
import { GRAPH_READ_TOOLS, renderToolResult, toolCommand } from './readTools.js'
import { renderAppendResult } from './writeTools.js'

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

Addressing: get_block, subtree, backlinks, grouped_backlinks and search's \`under\` take a block as a full id, a unique id prefix as printed (^3f2a9c1d), a page name, or a date (today, yesterday, 2026-06-18) for that day's daily note. The write tools' id fields take a full id or a printed ^shortid, never a name; a write target (append_markdown's target, create_block's parentId) also takes a [[Page name]] or a date, creating that page or daily note when missing.

The views (get_block, subtree, backlinks, grouped_backlinks, search) and sql_query are bounded and say so (page and daily_note are lookups that return the matched block whole): an outline line is \`- content  key:: value  ^shortid\`, \`(+N children)\` marks children not expanded, \`…[+N chars]\` marks cut text (get_block reads it a page at a time: pass its nextContentOffset as contentOffset until that is null), and a cut-off list ends with the offset to continue from. Pass format: "json" for structured output.

Start with subtree on a page name or "today" for an overview, search for text (filters: types, under, includeExtensions), backlinks / grouped_backlinks for what references something. guide indexes the data model (guide with a topic reads one section); sql_query is the escape hatch (read-only, rows capped).

Writing: append_markdown writes an outline in one call; edit_block changes one passage of a block; pass update_block the block's exact content as expectedContent so a concurrent edit of it is refused rather than overwritten.`

type MoveBlockPositionInput = z.infer<typeof moveBlockPositionSchema>

/** What a write tool is about to do, as the write guard sees it. Block-id
 *  fields (`id`, move_block's `parentId` and `position.siblingId`) carry the
 *  FULL id the write will act on — a `^short` / `((id))` / prefix the caller
 *  typed is resolved first — so a guard looking rows up by id checks the same
 *  block. Targets (`parentId` of create_block, `target`) stay as typed. */
export type GraphMcpWriteOperation =
  | {type: 'create_block', parentId: string, content: string, properties?: Record<string, unknown>}
  | {type: 'update_block', id: string, content?: string, properties?: Record<string, unknown>, expectedContent?: string}
  | {type: 'move_block', id: string, parentId: string | null, position: MoveBlockPositionInput}
  | {type: 'delete_block', id: string}
  | {type: 'restore_block', id: string}
  | {type: 'append_markdown', target: string, markdown: string, position?: MoveBlockPositionInput, shape?: 'outline' | 'block'}
  | {type: 'edit_block', id: string, old: string, new: string}
  | {type: 'create_page', name?: string, date?: string}

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

  // Resolved once, here, and sent with `exactIds` so the runtime does not read
  // it as a ref a second time: the guard and the write act on one block. Also
  // lets a `^short` id from append_markdown's output work in the read tools.
  const blockId = (ref: string): Promise<string> => graph.resolveBlockId(ref)
  const resolvedPosition = async (position: MoveBlockPositionInput): Promise<MoveBlockPositionInput> =>
    position.kind === 'before' || position.kind === 'after'
      ? {kind: position.kind, siblingId: await blockId(position.siblingId)}
      : position

  const json = (value: unknown) => ({
    content: [{type: 'text' as const, text: toDisplayJson(value)}],
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
    description: 'Create ONE block (content kept whole) under parentId, a target as described for append_markdown — '
    + `the way to write a typed record; for several blocks, use append_markdown. ${TODO_WRITE_HELP}`,
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
    description: 'Replace a block\'s content and/or merge properties (omitted keys stay). To change one passage, use '
    + 'edit_block. With expectedContent the update is refused, showing the current content, unless the block\'s '
    + 'content is exactly that — read it whole with get_block, not from an outline line.',
    inputSchema: {
      id: z.string(),
      content: z.string().optional(),
      properties: z.record(z.string(), z.unknown()).optional(),
      expectedContent: z.string().optional(),
    },
  }, async ({id: ref, content, properties, expectedContent}) => {
    const id = await blockId(ref)
    await beforeWrite({type: 'update_block', id, content, properties, expectedContent})
    return json(await graph.updateBlock(id, {content, properties, expectedContent, exactIds: true}))
  })

  server.registerTool('move_block' satisfies KmMcpToolName, {
    description: 'Move a block under a new parent, or to the workspace root with parentId:null. Positions: first, last, before/after siblingId.',
    inputSchema: {
      id: z.string(),
      parentId: z.string().nullable(),
      position: moveBlockPositionSchema,
    },
  }, async input => {
    const id = await blockId(input.id)
    const parentId = input.parentId === null ? null : await blockId(input.parentId)
    const position = await resolvedPosition(input.position)
    await beforeWrite({type: 'move_block', id, parentId, position})
    return json(await graph.moveBlock({id, parentId, position, exactIds: true}))
  })

  server.registerTool('delete_block' satisfies KmMcpToolName, {
    description: 'Soft-delete a block and its descendants.',
    inputSchema: {
      id: z.string(),
    },
  }, async ({id: ref}) => {
    const id = await blockId(ref)
    await beforeWrite({type: 'delete_block', id})
    return json(await graph.deleteBlock(id, {exactIds: true}))
  })

  server.registerTool('restore_block' satisfies KmMcpToolName, {
    description: 'Restore one soft-deleted block. Descendants remain deleted unless restored separately.',
    inputSchema: {
      id: z.string(),
    },
  }, async ({id: ref}) => {
    const id = await blockId(ref)
    await beforeWrite({type: 'restore_block', id})
    return json(await graph.restoreBlock(id, {exactIds: true}))
  })

  server.registerTool('append_markdown' satisfies KmMcpToolName, {
    description: 'Insert markdown under a target in ONE transaction, split into blocks as the app\'s paste does '
    + '(bullets and headings nest; a code block or table stays one block; shape "block" keeps it all one block). '
    + 'Returns the new blocks as a ^short-id outline. Default position: after the target\'s last child; a '
    + `before/after siblingId must be a child of the target, which is then never created. ${WRITE_TARGET_HELP}`,
    inputSchema: {
      target: z.string(),
      markdown: z.string(),
      position: moveBlockPositionSchema.optional(),
      shape: z.enum(['outline', 'block']).optional(),
    },
  }, async ({target, markdown, position: requested, shape}) => {
    const position = requested && await resolvedPosition(requested)
    await beforeWrite({type: 'append_markdown', target, markdown, position, shape})
    return text(renderAppendResult(await graph.appendMarkdown({target, markdown, position, shape, exactIds: true})))
  })

  server.registerTool('edit_block' satisfies KmMcpToolName, {
    description: 'Replace the one occurrence of `old` in a block\'s content with `new` (literal text), against the '
    + 'content current at write time. Refused when `old` is empty or found more than once (add surrounding text), '
    + 'and when it is not found, showing the current content.',
    inputSchema: {
      id: z.string(),
      old: z.string(),
      new: z.string(),
    },
  }, async input => {
    const edit = {...input, id: await blockId(input.id)}
    await beforeWrite({type: 'edit_block', ...edit})
    return json(await graph.editBlock({...edit, exactIds: true}))
  })

  server.registerTool('create_page' satisfies KmMcpToolName, {
    description: 'Get-or-create a page by name, as typing [[name]] would (a date-literal name is that daily note), '
    + 'or a daily note by date (today, next monday). Pass one of name or date. To also write content, '
    + 'append_markdown to [[name]] instead.',
    inputSchema: {
      name: z.string().optional(),
      date: z.string().optional(),
    },
  }, async ({name, date}) => {
    await beforeWrite({type: 'create_page', name, date})
    return json(await graph.createPage({name, date}))
  })

  // Defaults to this session's own window: what it changed since it started.
  const sessionStartedAt = Date.now()

  server.registerTool('recent_changes' satisfies KmMcpToolName, {
    description: 'Recent local transactions in this workspace, newest first, with the blocks each changed (content '
    + 'before/after, clipped — block_history has it whole; parent; property names). Defaults to agent writes (any agent on this device) since this '
    + 'session started — use it to report what you changed. since: epoch ms or ISO (0 = all); includeUser adds '
    + 'the user\'s own edits.',
    inputSchema: {
      since: z.union([z.number(), z.string()]).optional(),
      limit: z.number().int().positive().optional(),
      includeUser: z.boolean().optional(),
    },
  }, async ({since, limit, includeUser}) =>
    json(await graph.recentChanges({since: since ?? sessionStartedAt, limit, includeUser})))

  server.registerTool('block_history' satisfies KmMcpToolName, {
    description: 'One block\'s recorded changes, newest first, with full content before/after — local edits and '
    + 'ones synced from other devices. Use it to review a change or to restore earlier content with update_block.',
    inputSchema: {
      id: z.string(),
      limit: z.number().int().positive().optional(),
    },
  }, async ({id, limit}) => json(await graph.blockHistory({id, limit})))

  return server
}
