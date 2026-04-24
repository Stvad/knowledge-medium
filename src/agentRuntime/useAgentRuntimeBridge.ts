import { useEffect, useMemo } from 'react'
import React from 'react'
import ReactDOM from 'react-dom'
import { Block } from '@/data/block.ts'
import { Repo } from '@/data/repo.ts'
import { blockRenderersFacet, actionsFacet } from '@/extensions/core.ts'
import { FacetRuntime } from '@/extensions/facet.ts'
import { refreshAppRuntime } from '@/extensions/runtimeEvents.ts'
import { BlockData, BlockProperties } from '@/types.ts'

type SqlMode = 'all' | 'get' | 'optional' | 'execute'
type BlockPosition = 'first' | 'last' | number

interface AgentRuntimeCommand {
  commandId: string
  type: string
  [key: string]: unknown
}

interface AgentRuntimeContext {
  repo: Repo
  db: Repo['db']
  rootBlock: Block
  runtime: FacetRuntime
  safeMode: boolean
  sql: (sql: string, params?: unknown[], mode?: SqlMode) => Promise<unknown>
  block: (id: string) => Block
  getBlock: (id: string) => Promise<BlockData | undefined>
  getSubtree: (rootId?: string, includeRoot?: boolean) => Promise<BlockData[]>
  createBlock: (input?: CreateBlockInput) => Promise<BlockData | undefined>
  updateBlock: (input: UpdateBlockInput) => Promise<BlockData | undefined>
  actions: ReturnType<typeof actionsFacet.empty>
  renderers: ReturnType<typeof blockRenderersFacet.empty>
  refreshAppRuntime: typeof refreshAppRuntime
  React: typeof React
  ReactDOM: typeof ReactDOM
  window: Window
  document: Document
}

interface CreateBlockInput {
  parentId?: string
  position?: BlockPosition
  data?: Partial<BlockData>
  content?: string
  properties?: BlockProperties
}

interface UpdateBlockInput {
  id: string
  content?: string
  properties?: BlockProperties
  replaceProperties?: boolean
  childIds?: string[]
}

interface UseAgentRuntimeBridgeOptions {
  repo: Repo
  rootBlock: Block
  runtime: FacetRuntime
  safeMode: boolean
}

const defaultBridgeUrl = 'http://127.0.0.1:8787'
const longPollMs = 25_000
const retryBaseMs = 1_000
const retryMaxMs = 10_000

const bridgeUrl = () =>
  (import.meta.env.VITE_AGENT_RUNTIME_URL?.trim() || defaultBridgeUrl).replace(/\/+$/, '')

const delay = (ms: number) =>
  new Promise(resolve => window.setTimeout(resolve, ms))

const isString = (value: unknown): value is string =>
  typeof value === 'string'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString)

const isBlockPosition = (value: unknown): value is BlockPosition =>
  value === undefined ||
  value === 'first' ||
  value === 'last' ||
  typeof value === 'number'

const isSqlMode = (value: unknown): value is SqlMode =>
  value === 'all' ||
  value === 'get' ||
  value === 'optional' ||
  value === 'execute'

const requireString = (value: unknown, fieldName: string) => {
  if (!isString(value)) {
    throw new Error(`${fieldName} must be a string`)
  }
  return value
}

const getParams = (value: unknown): unknown[] => {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new Error('params must be an array')
  }
  return value
}

const getPosition = (value: unknown): BlockPosition | undefined => {
  if (!isBlockPosition(value)) {
    throw new Error('position must be "first", "last", or a number')
  }
  return value
}

const getBlockDataInput = (command: AgentRuntimeCommand): Partial<BlockData> => {
  const data = isRecord(command.data)
    ? structuredClone(command.data) as Partial<BlockData>
    : {}

  if (command.content !== undefined) {
    data.content = requireString(command.content, 'content')
  }

  if (command.properties !== undefined) {
    if (!isRecord(command.properties)) {
      throw new Error('properties must be an object')
    }
    data.properties = structuredClone(command.properties) as BlockProperties
  }

  return data
}

const runSql = async (
  repo: Repo,
  sql: string,
  params: unknown[] = [],
  mode: SqlMode = 'all',
) => {
  await repo.flush()

  if (mode === 'get') {
    return repo.db.get(sql, params)
  }
  if (mode === 'optional') {
    return repo.db.getOptional(sql, params)
  }
  if (mode === 'execute') {
    const result = await repo.db.execute(sql, params)
    await repo.flush()
    return result
  }

  return repo.db.getAll(sql, params)
}

const createRuntimeBlock = async (
  repo: Repo,
  input: CreateBlockInput = {},
) => {
  const data = {
    ...(input.data ?? {}),
    ...(input.content !== undefined ? {content: input.content} : {}),
    ...(input.properties !== undefined ? {properties: input.properties} : {}),
  }

  if (input.parentId) {
    const parent = repo.find(input.parentId)
    await parent.data()
    const block = await parent.createChild({
      data,
      position: input.position ?? 'last',
    })
    await repo.flush()
    return block.data()
  }

  const block = repo.create(data)
  await repo.flush()
  return block.data()
}

const updateRuntimeBlock = async (
  repo: Repo,
  input: UpdateBlockInput,
) => {
  const block = repo.find(input.id)
  await block.data()

  block.change((doc) => {
    if (input.content !== undefined) {
      doc.content = input.content
    }
    if (input.properties !== undefined) {
      doc.properties = input.replaceProperties
        ? structuredClone(input.properties)
        : {...doc.properties, ...structuredClone(input.properties)}
    }
    if (input.childIds !== undefined) {
      doc.childIds = [...input.childIds]
    }
  }, {description: 'Agent runtime block update'})

  await repo.flush()
  return block.data()
}

const executeCommand = async (
  command: AgentRuntimeCommand,
  context: AgentRuntimeContext,
) => {
  switch (command.type) {
    case 'ping':
    case 'describe-runtime':
      return describeRuntime(context)

    case 'sql': {
      const sql = requireString(command.sql, 'sql')
      const mode = command.mode === undefined
        ? 'all'
        : isSqlMode(command.mode)
          ? command.mode
          : undefined

      if (!mode) {
        throw new Error('mode must be one of: all, get, optional, execute')
      }

      return context.sql(sql, getParams(command.params), mode)
    }

    case 'get-block': {
      const id = requireString(command.blockId ?? command.id, 'blockId')
      return context.getBlock(id)
    }

    case 'get-subtree': {
      const rootId = command.rootId === undefined
        ? undefined
        : requireString(command.rootId, 'rootId')
      return context.getSubtree(rootId, Boolean(command.includeRoot))
    }

    case 'create-block':
      return context.createBlock({
        parentId: command.parentId === undefined
          ? undefined
          : requireString(command.parentId, 'parentId'),
        position: getPosition(command.position),
        data: getBlockDataInput(command),
      })

    case 'update-block': {
      const properties = command.properties === undefined
        ? undefined
        : isRecord(command.properties)
          ? structuredClone(command.properties) as BlockProperties
          : undefined

      if (command.properties !== undefined && !properties) {
        throw new Error('properties must be an object')
      }

      return context.updateBlock({
        id: requireString(command.blockId ?? command.id, 'blockId'),
        content: command.content === undefined
          ? undefined
          : requireString(command.content, 'content'),
        properties,
        replaceProperties: Boolean(command.replaceProperties),
        childIds: command.childIds === undefined
          ? undefined
          : isStringArray(command.childIds)
            ? command.childIds
            : (() => {
              throw new Error('childIds must be an array of strings')
            })(),
      })
    }

    case 'eval':
      return executeArbitraryCode(requireString(command.code, 'code'), context)

    default:
      throw new Error(`Unknown agent runtime command: ${command.type}`)
  }
}

const describeRuntime = (context: AgentRuntimeContext) => ({
  rootBlockId: context.rootBlock.id,
  currentUser: context.repo.currentUser,
  safeMode: context.safeMode,
  actions: context.actions.map(action => ({
    id: action.id,
    description: action.description,
    context: action.context,
    hasDefaultBinding: Boolean(action.defaultBinding),
  })),
  renderers: Object.keys(context.renderers),
})

const executeArbitraryCode = async (
  code: string,
  context: AgentRuntimeContext,
) => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as {
    new (...args: string[]): (context: AgentRuntimeContext) => Promise<unknown>
  }

  const fn = new AsyncFunction(
    'ctx',
    `
const {
  repo,
  db,
  rootBlock,
  runtime,
  safeMode,
  sql,
  block,
  getBlock,
  getSubtree,
  createBlock,
  updateBlock,
  actions,
  renderers,
  refreshAppRuntime,
  React,
  ReactDOM,
  window,
  document,
} = ctx

${code}
`,
  )

  return fn(context)
}

const serializeError = (error: unknown) => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }

  return {
    name: 'Error',
    message: String(error),
  }
}

const serializeValue = (value: unknown, seen = new WeakSet<object>()): unknown => {
  if (value === undefined) {
    return {type: 'undefined'}
  }

  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }

  if (typeof value === 'bigint') {
    return value.toString()
  }

  if (typeof value === 'function') {
    return `[Function ${value.name || 'anonymous'}]`
  }

  if (value instanceof Error) {
    return serializeError(value)
  }

  if (value instanceof Block) {
    return {
      type: 'Block',
      id: value.id,
      data: serializeValue(value.dataSync(), seen),
    }
  }

  if (Array.isArray(value)) {
    return value.map(item => serializeValue(item, seen))
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]'
    }

    seen.add(value)

    if (value instanceof Map) {
      return Object.fromEntries(
        Array.from(value.entries()).map(([key, mapValue]) => [
          String(key),
          serializeValue(mapValue, seen),
        ]),
      )
    }

    if (value instanceof Set) {
      return Array.from(value.values()).map(item => serializeValue(item, seen))
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, objectValue]) => [
        key,
        serializeValue(objectValue, seen),
      ]),
    )
  }

  return String(value)
}

const postJson = async (
  url: string,
  body: unknown,
  signal?: AbortSignal,
) => {
  const response = await window.fetch(url, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    throw new Error(`Agent runtime bridge request failed: ${response.status}`)
  }

  return response
}

export function useAgentRuntimeBridge({
  repo,
  rootBlock,
  runtime,
  safeMode,
}: UseAgentRuntimeBridgeOptions) {
  const clientId = useMemo(() => crypto.randomUUID(), [])

  useEffect(() => {
    const abortController = new AbortController()
    const baseUrl = bridgeUrl()
    let retryMs = retryBaseMs

    const context = (): AgentRuntimeContext => ({
      repo,
      db: repo.db,
      rootBlock,
      runtime,
      safeMode,
      sql: (sql, params, mode) => runSql(repo, sql, params, mode),
      block: id => repo.find(id),
      getBlock: async id => {
        const block = repo.find(id)
        return block.data()
      },
      getSubtree: (rootId, includeRoot) =>
        repo.getSubtreeBlockData(rootId ?? rootBlock.id, {includeRoot}),
      createBlock: input => createRuntimeBlock(repo, input),
      updateBlock: input => updateRuntimeBlock(repo, input),
      actions: runtime.read(actionsFacet),
      renderers: runtime.read(blockRenderersFacet),
      refreshAppRuntime,
      React,
      ReactDOM,
      window,
      document,
    })

    const register = () => postJson(`${baseUrl}/runtime/clients/${clientId}`, {
      rootBlockId: rootBlock.id,
      currentUser: repo.currentUser,
      safeMode,
      href: window.location.href,
      userAgent: window.navigator.userAgent,
    }, abortController.signal)

    const reportResult = async (commandId: string, payload: unknown) => {
      await postJson(
        `${baseUrl}/runtime/commands/${commandId}/result`,
        payload,
        abortController.signal,
      )
    }

    const poll = async () => {
      while (!abortController.signal.aborted) {
        try {
          await register()

          const nextUrl = new URL(`${baseUrl}/runtime/commands/next`)
          nextUrl.searchParams.set('clientId', clientId)
          nextUrl.searchParams.set('timeoutMs', String(longPollMs))

          const response = await window.fetch(nextUrl, {signal: abortController.signal})
          if (!response.ok) {
            throw new Error(`Agent runtime bridge poll failed: ${response.status}`)
          }

          const command = await response.json() as AgentRuntimeCommand | null
          retryMs = retryBaseMs

          if (!command) {
            continue
          }

          try {
            const value = await executeCommand(command, context())
            await repo.flush()
            await reportResult(command.commandId, {
              ok: true,
              value: serializeValue(value),
            })
          } catch (error) {
            await reportResult(command.commandId, {
              ok: false,
              error: serializeError(error),
            })
          }
        } catch {
          if (abortController.signal.aborted) {
            return
          }

          await delay(retryMs)
          retryMs = Math.min(retryMs * 2, retryMaxMs)
        }
      }
    }

    void poll()

    return () => {
      abortController.abort()
    }
  }, [clientId, repo, rootBlock, runtime, safeMode])
}
