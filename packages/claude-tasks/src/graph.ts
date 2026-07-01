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
  childIds?: string[]
}

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object') throw new Error(`Unexpected ${label} result shape`)
  return value as Record<string, unknown>
}

export const createGraph = (client: BridgeClient) => {
  const resolvePageId = async (alias: string): Promise<string> => {
    const result = await client.runCommand({type: 'page', name: alias}) as PageResult
    if (!result.match) {
      throw new Error(
        `Watcher target page "${alias}" does not exist yet — create it (type [[${alias}]] once and click it) before the watcher can run.`,
      )
    }
    return result.match.id
  }

  const backlinkSources = async (blockId: string): Promise<BacklinkSource[]> => {
    const result = await client.runCommand({type: 'backlinks', id: blockId}) as BacklinksResult
    return result.backlinks ?? []
  }

  const getBlock = async (id: string): Promise<BlockData | null> => {
    const result = await client.runCommand({type: 'get-block', id})
    if (result === null || result === undefined) return null
    return asRecord(result, 'get-block') as unknown as BlockData
  }

  /** Ancestor chain, nearest first. Bounded to keep a corrupt
   *  parent-cycle from hanging the daemon. */
  const ancestors = async (id: string, maxDepth = 100): Promise<BlockData[]> => {
    const chain: BlockData[] = []
    let current = await getBlock(id)
    while (current?.parentId && chain.length < maxDepth) {
      const parent = await getBlock(current.parentId)
      if (!parent) break
      chain.push(parent)
      current = parent
    }
    return chain
  }

  const getSubtree = async (rootId: string): Promise<BlockData[]> => {
    const result = await client.runCommand({type: 'get-subtree', rootId})
    return Array.isArray(result) ? result as BlockData[] : []
  }

  const setTaskProps = async (
    id: string,
    args: {status: TaskStatus, watcher?: string, session?: string | null, error?: string | null, nowMs: number},
  ): Promise<void> => {
    const properties: Record<string, unknown> = {
      [PROPS.status]: args.status,
      [PROPS.updatedAt]: args.nowMs,
    }
    if (args.watcher !== undefined) properties[PROPS.watcher] = args.watcher
    if (args.session !== undefined && args.session !== null) properties[PROPS.session] = args.session
    if (args.error !== undefined) properties[PROPS.error] = args.error ?? ''
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

  const sqlAll = async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
    const result = await client.runCommand({type: 'sql', mode: 'all', sql, params})
    return Array.isArray(result) ? result : []
  }

  return {
    client,
    resolvePageId,
    backlinkSources,
    getBlock,
    ancestors,
    getSubtree,
    setTaskProps,
    createReply,
    sqlAll,
  }
}

export type Graph = ReturnType<typeof createGraph>
