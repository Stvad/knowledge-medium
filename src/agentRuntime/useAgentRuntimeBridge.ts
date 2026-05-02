import { useEffect, useMemo, useRef } from 'react'
import React from 'react'
import ReactDOM from 'react-dom'
import { Block } from '@/data/internals/block'
import type { Repo } from '@/data/internals/repo'
import { ChangeScope, type BlockData, type BlockReference } from '@/data/api'
import { blockRenderersFacet } from '@/extensions/core.ts'
import { FacetRuntime } from '@/extensions/facet.ts'
import { describeRuntime } from '@/agentRuntime/describeRuntime.ts'
import { readRuntimeActions } from '@/extensions/runtimeActions.ts'
import { refreshAppRuntime } from '@/extensions/runtimeEvents.ts'
import { BlockProperties } from '@/types.ts'
import { ActionConfig } from '@/shortcuts/types.ts'

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
  landingBlock: Block
  runtime: FacetRuntime
  safeMode: boolean
  sql: (sql: string, params?: unknown[], mode?: SqlMode) => Promise<unknown>
  block: (id: string) => Block
  getBlock: (id: string) => Promise<BlockData | null>
  getSubtree: (rootId?: string) => Promise<BlockData[]>
  createBlock: (input?: CreateBlockInput) => Promise<BlockData | null>
  updateBlock: (input: UpdateBlockInput) => Promise<BlockData | null>
  actions: readonly ActionConfig[]
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
}

interface UseAgentRuntimeBridgeOptions {
  repo: Repo
  landingBlock: Block
  runtime: FacetRuntime
  safeMode: boolean
}

const defaultBridgeUrl = 'http://127.0.0.1:8787'
const longPollMs = 25_000
const retryBaseMs = 1_000
const retryMaxMs = 30_000
const maxAttemptsBeforeIdle = 6

export const agentRuntimeBridgeRestartEvent = 'agent-runtime-bridge:restart'

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
  if (mode === 'get') {
    return repo.db.get(sql, params)
  }
  if (mode === 'optional') {
    return repo.db.getOptional(sql, params)
  }
  if (mode === 'execute') {
    return repo.db.execute(sql, params)
  }
  return repo.db.getAll(sql, params)
}

/** Translate the agent's `position` shape into the kernel mutator's
 *  `position` arg. The legacy bridge accepted `'first' | 'last' |
 *  number` (a numeric index); the new mutator-level position is
 *  `{kind: 'first'|'last'|'before'|'after', siblingId?}`. We map
 *  numeric indices best-effort: 0 → 'first', anything else → 'last'.
 *  Calls that need precise positional inserts can issue tx.move
 *  through the `eval` channel. */
const mapPosition = (
  position: BlockPosition | undefined,
): {kind: 'first'} | {kind: 'last'} | undefined => {
  if (position === undefined || position === 'last') return {kind: 'last'}
  if (position === 'first' || position === 0) return {kind: 'first'}
  return {kind: 'last'}
}

const createRuntimeBlock = async (
  repo: Repo,
  input: CreateBlockInput = {},
): Promise<BlockData | null> => {
  const content = input.content ?? (input.data?.content as string | undefined) ?? ''
  const properties = input.properties ?? (input.data?.properties as Record<string, unknown> | undefined)
  // Forward the agent's optional `data.id` / `data.references` to the
  // mutator. Without these, deterministic-id callers and pre-populated
  // reference rows can't be created through the runtime — agents had
  // to reach for the eval channel to do anything beyond plain content
  // + properties, which breaks tooling that uses createBlock as the
  // canonical surface.
  const explicitId = input.data?.id as string | undefined
  const references = input.data?.references as BlockReference[] | undefined

  if (input.parentId) {
    const id = await repo.mutate.createChild({
      parentId: input.parentId,
      content,
      properties,
      references,
      position: mapPosition(input.position),
      id: explicitId,
    }) as string
    return repo.load(id)
  }

  // Parent-less create. Workspace must be supplied somehow — the
  // agent input doesn't carry one explicitly, so use the active
  // workspace pin (set by App boot). If no pin, this is a hard error.
  const workspaceId = (input.data?.workspaceId as string | undefined) ?? repo.activeWorkspaceId
  if (!workspaceId) {
    throw new Error('createBlock with no parentId requires an active workspace')
  }
  const id = explicitId ?? crypto.randomUUID()
  await repo.tx(async tx => {
    await tx.create({
      id,
      workspaceId,
      parentId: null,
      orderKey: (input.data?.orderKey as string | undefined) ?? 'a0',
      content,
      properties,
      references,
    })
  }, {scope: ChangeScope.BlockDefault, description: 'agent runtime create root block'})
  return repo.load(id)
}

const updateRuntimeBlock = async (
  repo: Repo,
  input: UpdateBlockInput,
): Promise<BlockData | null> => {
  const before = await repo.load(input.id)
  if (!before) throw new Error(`updateBlock: block ${input.id} not found`)

  const nextProperties = input.properties === undefined
    ? undefined
    : input.replaceProperties
      ? structuredClone(input.properties) as Record<string, unknown>
      : {...before.properties, ...structuredClone(input.properties)} as Record<string, unknown>

  await repo.tx(async tx => {
    await tx.update(input.id, {
      ...(input.content !== undefined ? {content: input.content} : {}),
      ...(nextProperties !== undefined ? {properties: nextProperties} : {}),
    })
  }, {scope: ChangeScope.BlockDefault, description: 'agent runtime block update'})

  return repo.load(input.id)
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
      // includeRoot dropped in Phase 4 — agent always receives the
      // root + descendants. Callers that don't want the root filter
      // it out themselves.
      return context.getSubtree(rootId)
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

      // childIds direct replacement is dropped — the new tree shape
      // stores parent_id+order_key as the source of truth, not a
      // childIds array. Agents that need to reorder children should
      // issue tx.move calls per child via the eval channel.
      if (command.childIds !== undefined) {
        if (!isStringArray(command.childIds)) {
          throw new Error('childIds must be an array of strings')
        }
        throw new Error(
          'childIds replacement is no longer supported by update-block; use repo.mutate.move per child instead',
        )
      }
      return context.updateBlock({
        id: requireString(command.blockId ?? command.id, 'blockId'),
        content: command.content === undefined
          ? undefined
          : requireString(command.content, 'content'),
        properties,
        replaceProperties: Boolean(command.replaceProperties),
      })
    }

    case 'eval':
      return executeArbitraryCode(requireString(command.code, 'code'), context)

    default:
      throw new Error(`Unknown agent runtime command: ${command.type}`)
  }
}

// describeRuntime extracted to a non-React module so it's testable in
// isolation; see @/agentRuntime/describeRuntime.

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
  landingBlock,
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
      data: serializeValue(value.peek(), seen),
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
  landingBlock,
  runtime,
  safeMode,
}: UseAgentRuntimeBridgeOptions) {
  const clientId = useMemo(() => crypto.randomUUID(), [])
  const latestContext = useRef<UseAgentRuntimeBridgeOptions>({
    repo,
    landingBlock,
    runtime,
    safeMode,
  })

  useEffect(() => {
    latestContext.current = {
      repo,
      landingBlock,
      runtime,
      safeMode,
    }
  }, [repo, landingBlock, runtime, safeMode])

  useEffect(() => {
    const abortController = new AbortController()
    const baseUrl = bridgeUrl()
    let retryMs = retryBaseMs
    let attempts = 0
    let restartResolve: (() => void) | null = null

    const waitForRestart = () => new Promise<void>(resolve => {
      restartResolve = resolve
    })

    const handleRestart = () => {
      attempts = 0
      retryMs = retryBaseMs
      if (restartResolve) {
        restartResolve()
        restartResolve = null
      }
    }

    window.addEventListener(agentRuntimeBridgeRestartEvent, handleRestart)

    const context = (): AgentRuntimeContext => {
      const {
        repo: currentRepo,
        landingBlock: currentLandingBlock,
        runtime: currentRuntime,
        safeMode: currentSafeMode,
      } = latestContext.current

      return {
        repo: currentRepo,
        db: currentRepo.db,
        landingBlock: currentLandingBlock,
        runtime: currentRuntime,
        safeMode: currentSafeMode,
        sql: (sql, params, mode) => runSql(currentRepo, sql, params, mode),
        block: id => currentRepo.block(id),
        getBlock: id => currentRepo.load(id),
        getSubtree: (rootId) =>
          currentRepo.query.subtree({id: rootId ?? currentLandingBlock.id}).load(),
        createBlock: input => createRuntimeBlock(currentRepo, input),
        updateBlock: input => updateRuntimeBlock(currentRepo, input),
        actions: readRuntimeActions(currentRuntime),
        renderers: currentRuntime.read(blockRenderersFacet),
        refreshAppRuntime,
        React,
        ReactDOM,
        window,
        document,
      }
    }

    const register = () => {
      const {
        repo: currentRepo,
        landingBlock: currentLandingBlock,
        safeMode: currentSafeMode,
      } = latestContext.current

      return postJson(`${baseUrl}/runtime/clients/${clientId}`, {
        landingBlockId: currentLandingBlock.id,
        currentUser: currentRepo.user,
        safeMode: currentSafeMode,
        href: window.location.href,
        userAgent: window.navigator.userAgent,
      }, abortController.signal)
    }

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
          attempts = 0

          if (!command) {
            continue
          }

          try {
            const value = await executeCommand(command, context())
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

          attempts += 1
          if (attempts >= maxAttemptsBeforeIdle) {
            console.info(
              `Agent runtime bridge unavailable at ${baseUrl}; pausing reconnects. ` +
              `Run "Restart agent runtime bridge" from the command palette to retry.`,
            )
            await waitForRestart()
            if (abortController.signal.aborted) return
            continue
          }

          await delay(retryMs)
          retryMs = Math.min(retryMs * 2, retryMaxMs)
        }
      }
    }

    void poll()

    return () => {
      abortController.abort()
      window.removeEventListener(agentRuntimeBridgeRestartEvent, handleRestart)
      if (restartResolve) {
        restartResolve()
        restartResolve = null
      }
    }
  }, [clientId])
}
