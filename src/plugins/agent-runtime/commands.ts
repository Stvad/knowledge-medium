import React from 'react'
import ReactDOM from 'react-dom'
import type { Repo } from '@/data/repo'
import { ChangeScope, type BlockData, type BlockReference } from '@/data/api'
import { aliasesProp, extensionDisabledProp } from '@/data/properties.ts'
import { EXTENSION_TYPE } from '@/data/blockTypes'
import { keyAtEnd } from '@/data/orderKey.ts'
import { blockRenderersFacet } from '@/extensions/core.ts'
import { readRuntimeActions } from '@/extensions/runtimeActions.ts'
import { refreshAppRuntime } from '@/extensions/runtimeEvents.ts'
import { describeRuntime } from './describeRuntime.ts'
import type {
  AgentRuntimeBridgeOptions,
  AgentRuntimeCommand,
  AgentRuntimeContext,
  BlockPosition,
  CreateBlockInput,
  InstallExtensionInput,
  InstallExtensionResult,
  SqlMode,
  UpdateBlockInput,
} from './protocol.ts'
import type { BlockProperties } from '@/types.ts'

const agentExtensionsParentAlias = 'Agent-installed extensions'

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
  if (mode === 'get') return repo.db.get(sql, params)
  if (mode === 'optional') return repo.db.getOptional(sql, params)
  if (mode === 'execute') return repo.db.execute(sql, params)
  return repo.db.getAll(sql, params)
}

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

const extensionAliasValues = (data: BlockData | null): string[] => {
  const value = data?.properties[aliasesProp.name]
  return Array.isArray(value) && value.every(isString) ? value : []
}

const extensionBlockProperties = (
  existing: BlockProperties | undefined,
  label: string | null,
  disabled: boolean | undefined,
): BlockProperties => {
  const aliases = new Set<string>(Array.isArray(existing?.[aliasesProp.name])
    ? (existing?.[aliasesProp.name] as unknown[]).filter(isString)
    : [])
  if (label) aliases.add(label)

  return {
    ...(existing ?? {}),
    ...(aliases.size > 0 ? {[aliasesProp.name]: aliasesProp.codec.encode([...aliases])} : {}),
    ...(disabled !== undefined ? {[extensionDisabledProp.name]: extensionDisabledProp.codec.encode(disabled)} : {}),
  }
}

const resolveWorkspaceId = (repo: Repo): string => {
  if (repo.activeWorkspaceId) return repo.activeWorkspaceId
  throw new Error('install-extension requires an active workspace')
}

const installRuntimeExtension = async (
  repo: Repo,
  input: InstallExtensionInput,
): Promise<InstallExtensionResult> => {
  const source = input.source.trimEnd()
  if (!source) throw new Error('install-extension requires non-empty source')

  const label = input.label?.trim() || null
  const workspaceId = resolveWorkspaceId(repo)
  const existingExtensions = await repo.query.findExtensionBlocks({workspaceId}).load() as BlockData[]
  const existing = input.id
    ? existingExtensions.find(block => block.id === input.id) ?? null
    : label
      ? existingExtensions.find(block => extensionAliasValues(block).includes(label)) ?? null
      : null

  if (existing) {
    const typeSnapshot = repo.snapshotTypeRegistries()
    await repo.tx(async tx => {
      const current = await tx.get(existing.id)
      if (!current) throw new Error(`Extension block ${existing.id} disappeared before update`)
      await tx.update(existing.id, {
        content: source,
        properties: extensionBlockProperties(current.properties, label, input.disabled),
      })
      await repo.addTypeInTx(tx, existing.id, EXTENSION_TYPE, {}, typeSnapshot)
    }, {scope: ChangeScope.BlockDefault, description: `agent runtime install extension ${label ?? existing.id}`})
    refreshAppRuntime()
    return {id: existing.id, inserted: false, label}
  }

  const parentIdFromInput = input.parentId?.trim() || null
  const defaultParent = parentIdFromInput
    ? null
    : await repo.query.aliasLookup({workspaceId, alias: agentExtensionsParentAlias}).load() as BlockData | null

  let installedId = input.id?.trim() || ''
  const typeSnapshot = repo.snapshotTypeRegistries()
  await repo.tx(async tx => {
    let parentId = parentIdFromInput ?? defaultParent?.id ?? null
    if (!parentId) {
      const rootSiblings = await tx.childrenOf(null, workspaceId)
      parentId = await tx.create({
        workspaceId,
        parentId: null,
        orderKey: keyAtEnd(rootSiblings.at(-1)?.orderKey ?? null),
        content: agentExtensionsParentAlias,
        properties: {
          [aliasesProp.name]: aliasesProp.codec.encode([agentExtensionsParentAlias]),
        },
      })
    }

    const siblings = await tx.childrenOf(parentId, workspaceId)
    installedId = await tx.create({
      id: installedId || undefined,
      workspaceId,
      parentId,
      orderKey: keyAtEnd(siblings.at(-1)?.orderKey ?? null),
      content: source,
      properties: extensionBlockProperties(undefined, label, input.disabled),
    })
    await repo.addTypeInTx(tx, installedId, EXTENSION_TYPE, {}, typeSnapshot)
  }, {scope: ChangeScope.BlockDefault, description: `agent runtime install extension ${label ?? 'unnamed'}`})

  refreshAppRuntime()
  return {id: installedId, inserted: true, label}
}

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
  runtime,
  safeMode,
  sql,
  block,
  getBlock,
  getSubtree,
  createBlock,
  updateBlock,
  installExtension,
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

export const createAgentRuntimeContext = ({
  repo,
  runtime,
  safeMode,
}: AgentRuntimeBridgeOptions): AgentRuntimeContext => ({
  repo,
  db: repo.db,
  runtime,
  safeMode,
  sql: (sql, params, mode) => runSql(repo, sql, params, mode),
  block: id => repo.block(id),
  getBlock: id => repo.load(id),
  getSubtree: async rootId => await repo.query.subtree({id: rootId}).load() as BlockData[],
  createBlock: input => createRuntimeBlock(repo, input),
  updateBlock: input => updateRuntimeBlock(repo, input),
  installExtension: input => installRuntimeExtension(repo, input),
  actions: readRuntimeActions(runtime),
  renderers: runtime.read(blockRenderersFacet),
  refreshAppRuntime,
  React,
  ReactDOM,
  window,
  document,
})

export const executeCommand = async (
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

    case 'get-block':
      return context.getBlock(requireString(command.blockId ?? command.id, 'blockId'))

    case 'get-subtree':
      return context.getSubtree(requireString(command.rootId, 'rootId'))

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

    case 'install-extension':
      return context.installExtension({
        source: requireString(command.source, 'source'),
        label: command.label === undefined
          ? undefined
          : requireString(command.label, 'label'),
        parentId: command.parentId === undefined
          ? undefined
          : requireString(command.parentId, 'parentId'),
        id: command.id === undefined
          ? undefined
          : requireString(command.id, 'id'),
        disabled: command.disabled === undefined
          ? undefined
          : Boolean(command.disabled),
      })

    case 'eval':
      return executeArbitraryCode(requireString(command.code, 'code'), context)

    default:
      throw new Error(`Unknown agent runtime command: ${command.type}`)
  }
}
