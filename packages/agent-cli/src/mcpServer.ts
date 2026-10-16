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
import { renderAppendResult, TODO_WRITE_HELP, WRITE_TARGET_HELP } from './writeTools.js'

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

  // Resolved once, here, so the guard and the write act on one block.
  const blockId = (ref: string): Promise<string> => graph.resolveBlockId(ref)
  const resolvedPosition = async (position: MoveBlockPositionInput): Promise<MoveBlockPositionInput> =>
    position.kind === 'before' || position.kind === 'after'
      ? {kind: position.kind, siblingId: await blockId(position.siblingId)}
      : position

  const json = (value: unknown) => ({
    content: [{type: 'text' as const, text: JSON.stringify(value, null, 2)}],
  })
  const text = (value: string) => ({
    content: [{type: 'text' as const, text: value}],
  })
  const workspaceId = z.string().optional().describe(
    "Workspace to read. Defaults to the one open in the app tab; the token reaches every workspace of its user.",
  )

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
    inputSchema: {name: z.string(), workspaceId},
  }, async ({name, workspaceId}) => json(await client.runCommand({type: 'page', name, workspaceId})))

  server.registerTool('daily_note' satisfies KmMcpToolName, {
    description: 'Resolve a date expression (today | yesterday | ISO date | natural language) to its daily-note block.',
    inputSchema: {date: z.string(), workspaceId},
  }, async ({date, workspaceId}) => json(await client.runCommand({type: 'daily-note', date, workspaceId})))

  server.registerTool('search' satisfies KmMcpToolName, {
    description: 'Full-text search over block content.',
    inputSchema: {query: z.string(), limit: z.number().int().positive().optional(), workspaceId},
  }, async ({query, limit, workspaceId}) => json(await client.runCommand({type: 'search', query, limit, workspaceId})))

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
    description: 'Create ONE block (content kept whole) under a parent, optionally with properties — the way to write a '
    + `typed record. For several blocks or an outline, use append_markdown. ${TODO_WRITE_HELP} `
    + `[[Page]] wikilinks in content create references. parentId is any target: ${WRITE_TARGET_HELP}`,
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
    description: 'Replace a block\'s whole content and/or merge properties (keys you omit are kept). To change one '
    + 'passage, prefer edit_block. Pass expectedContent — the content you read — and the update is refused, with '
    + 'the current content, if the block changed since (e.g. the user edited it on another device). '
    + TODO_WRITE_HELP,
    inputSchema: {
      id: z.string(),
      content: z.string().optional(),
      properties: z.record(z.string(), z.unknown()).optional(),
      expectedContent: z.string().optional(),
    },
  }, async ({id: ref, content, properties, expectedContent}) => {
    const id = await blockId(ref)
    await beforeWrite({type: 'update_block', id, content, properties, expectedContent})
    return json(await graph.updateBlock(id, {content, properties, expectedContent}))
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
    return json(await graph.moveBlock({id, parentId, position}))
  })

  server.registerTool('delete_block' satisfies KmMcpToolName, {
    description: 'Soft-delete a block and its descendants.',
    inputSchema: {
      id: z.string(),
    },
  }, async ({id: ref}) => {
    const id = await blockId(ref)
    await beforeWrite({type: 'delete_block', id})
    return json(await graph.deleteBlock(id))
  })

  server.registerTool('restore_block' satisfies KmMcpToolName, {
    description: 'Restore one soft-deleted block. Descendants remain deleted unless restored separately.',
    inputSchema: {
      id: z.string(),
    },
  }, async ({id: ref}) => {
    const id = await blockId(ref)
    await beforeWrite({type: 'restore_block', id})
    return json(await graph.restoreBlock(id))
  })

  server.registerTool('append_markdown' satisfies KmMcpToolName, {
    description: 'Write markdown into the graph like appending to a file: it is split into blocks exactly as the app '
    + '"paste as markdown" does (bullets and headings nest, a fenced code block or table stays one block) and '
    + 'inserted under the target in ONE transaction. Returns the created blocks as a ^short-id outline. '
    + `Position defaults to after the target's last child; a before/after anchor must be a child of the target, `
    + `and then a missing target is refused rather than created. ${WRITE_TARGET_HELP} `
    + 'shape "block" keeps the whole markdown as one block.',
    inputSchema: {
      target: z.string(),
      markdown: z.string(),
      position: moveBlockPositionSchema.optional(),
      shape: z.enum(['outline', 'block']).optional(),
    },
  }, async ({target, markdown, position: requested, shape}) => {
    const position = requested && await resolvedPosition(requested)
    await beforeWrite({type: 'append_markdown', target, markdown, position, shape})
    return text(renderAppendResult(await graph.appendMarkdown({target, markdown, position, shape})))
  })

  server.registerTool('edit_block' satisfies KmMcpToolName, {
    description: 'Replace the one occurrence of `old` in a block\'s content with `new` — literal text, no regex. '
    + 'Applied against the block\'s content at write time, so edits made elsewhere since you read it survive. '
    + 'Refused when `old` is empty, not found (the error shows the current content) or found more than once '
    + '(include more surrounding text).',
    inputSchema: {
      id: z.string(),
      old: z.string(),
      new: z.string(),
    },
  }, async input => {
    const edit = {...input, id: await blockId(input.id)}
    await beforeWrite({type: 'edit_block', ...edit})
    return json(await graph.editBlock(edit))
  })

  server.registerTool('create_page' satisfies KmMcpToolName, {
    description: 'Get-or-create a page by name — exactly what typing [[name]] creates (a date-literal name is that '
    + 'daily note) — or a daily note by date expression (today, next monday, 2026-10-15). Pass exactly one of '
    + 'name or date. Reports whether it was created. To also write content, append_markdown to [[name]] instead.',
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
    description: 'What changed: recent local transactions in the active workspace, newest first, each with the blocks '
    + 'it changed (kind, content before/after, parent, property names). Defaults to agent writes (any agent session '
    + 'on this device) since THIS session started — use it to report what you changed. since: epoch ms or ISO '
    + 'timestamp (0 for all history); includeUser adds the user\'s own edits on this device.',
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
