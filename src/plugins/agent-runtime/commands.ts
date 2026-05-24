import React from 'react'
import ReactDOM from 'react-dom'
import type { Repo } from '@/data/repo'
import type { Block } from '@/data/block'
import { ChangeScope, type BlockData, type BlockReference } from '@/data/api'
import { aliasesProp, extensionDescriptionProp, extensionNameProp } from '@/data/properties.js'
import { EXTENSION_TYPE, PAGE_TYPE } from '@/data/blockTypes'
import { keyAtEnd } from '@/data/orderKey.js'
import {
  actionsFacet,
  appEffectsFacet,
  appMountsFacet,
  blockRenderersFacet,
} from '@/extensions/core.js'
import { readRuntimeActions } from '@/extensions/runtimeActions.js'
import { refreshAppRuntime } from '@/extensions/runtimeEvents.js'
import { dynamicExtensionsExtension } from '@/extensions/dynamicExtensions.js'
import { resolveAppRuntime } from '@/extensions/resolveAppRuntime.js'
import { applyToggle, userExtensionToggle } from '@/extensions/togglable.js'
import { findExtensionBlock } from '@/extensions/extensionLookup.js'
import { lintExtensionSource } from './extensionLint.ts'
import { getPluginPrefsBlock } from '@/data/stateBlocks.js'
import {
  extensionsOverridesProp,
  extensionsPrefsType,
} from '@/plugins/extensions-settings/config.js'
import {
  describeFacets,
  describeRuntime,
  describeRuntimeSummary,
  pingRuntime,
} from './describeRuntime.ts'
import type {KnownAgentCommand} from '@knowledge-medium/agent-cli/protocol'
import type {
  AgentRuntimeBridgeOptions,
  AgentRuntimeContext,
  BlockPosition,
  CreateBlockInput,
  ExtensionVerificationResult,
  InstallExtensionInput,
  InstallExtensionResult,
  SetExtensionEnabledInput,
  SetExtensionEnabledResult,
  SqlMode,
  UninstallExtensionInput,
  UninstallExtensionResult,
  UpdateBlockInput,
} from './protocol.ts'
import type { BlockProperties } from '@/types.js'

const agentExtensionsParentAlias = 'Agent-installed extensions'

const isString = (value: unknown): value is string =>
  typeof value === 'string'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString)

const optionalStringArray = (value: unknown): string[] | undefined =>
  isStringArray(value) ? value : undefined

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

const getBlockDataInput = (command: KnownAgentCommand): Partial<BlockData> => {
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

const serializeVerificationError = (blockId: string, error: Error) => ({
  blockId,
  name: error.name,
  message: error.message,
})

// Dynamic extension contributions are tagged with `block:<id>...`
// sources (see prefixContributionSource in dynamicExtensions.ts). We
// match the prefix so we capture both the bare `block:<id>` form and
// any nested `block:<id>/<inner-source>` from enables chains.
const isExtensionContribution = (source: unknown, blockId: string): boolean => {
  if (typeof source !== 'string') return false
  const prefix = `block:${blockId}`
  return source === prefix || source.startsWith(`${prefix}/`)
}

const verifyExtensionBlock = async (
  repo: Repo,
  context: AgentRuntimeContext,
  blockId: string,
): Promise<ExtensionVerificationResult> => {
  const block = await repo.load(blockId)
  if (!block) {
    throw new Error(`Extension block ${blockId} not found after install`)
  }

  const errors: ExtensionVerificationResult['errors'] = []
  const singleBlockRepo = {
    query: {
      findExtensionBlocks: () => ({
        load: async () => [block],
      }),
    },
  } as unknown as Repo

  // Use resolveAppRuntime (not the bare resolveFacetRuntime) so the
  // verification's action / facet lists match what production sees:
  // resolveAppRuntime recurses into FacetContribution.enables, and the
  // bare resolver does not. An extension whose contributions hang off
  // an `enables` chain would otherwise verify against a smaller
  // contribution surface than the running app would expose.
  const verificationRuntime = await resolveAppRuntime(
    dynamicExtensionsExtension({
      repo: singleBlockRepo,
      workspaceId: block.workspaceId,
      safeMode: false,
      overrides: new Map([[block.id, true]]),
      errorReporter: (reportedBlockId, error) => {
        errors.push(serializeVerificationError(reportedBlockId, error))
      },
    }),
    {
      overrides: new Map([[block.id, true]]),
      context: {
        repo,
        workspaceId: repo.activeWorkspaceId,
        safeMode: context.safeMode,
        generation: 'agent-runtime-install-verify',
      },
    },
  )

  const renderersContribs = verificationRuntime.contributionsById(blockRenderersFacet.id)
  const appMountsContribs = verificationRuntime.contributionsById(appMountsFacet.id)
  const appEffectsContribs = verificationRuntime.contributionsById(appEffectsFacet.id)

  const filterToExtension = <T extends {source?: unknown, value: unknown}>(contribs: readonly T[]): T[] =>
    contribs.filter(c => isExtensionContribution(c.source, blockId))

  const extensionRenderers = filterToExtension(renderersContribs)
  const extensionAppMounts = filterToExtension(appMountsContribs)
  const extensionAppEffects = filterToExtension(appEffectsContribs)

  const idOf = (value: unknown): string | undefined =>
    typeof value === 'object' && value !== null && typeof (value as {id?: unknown}).id === 'string'
      ? (value as {id: string}).id
      : undefined

  const warnings = lintExtensionSource(block.content ?? '')

  return {
    ok: errors.length === 0,
    errors,
    actions: verificationRuntime.read(actionsFacet).map(action => ({
      id: action.id,
      description: action.description,
      context: action.context,
    })),
    facets: describeFacets(verificationRuntime).map(facet => ({
      id: facet.id,
      contributionCount: facet.contributionCount,
    })),
    contributions: {
      renderers: extensionRenderers.map(c => idOf(c.value)).filter((id): id is string => Boolean(id)),
      appMounts: extensionAppMounts.map(c => idOf(c.value)).filter((id): id is string => Boolean(id)),
      appEffects: extensionAppEffects.map(c => idOf(c.value)).filter((id): id is string => Boolean(id)),
    },
    ...(warnings.length > 0 ? {warnings} : {}),
  }
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

const aliasValuesFromProperties = (properties: BlockProperties | undefined): string[] => {
  const value = properties?.[aliasesProp.name]
  return Array.isArray(value) && value.every(isString) ? value : []
}

const extensionBlockProperties = (
  existing: BlockProperties | undefined,
  label: string | null,
  description: string | null,
): BlockProperties => {
  const aliases = new Set<string>(Array.isArray(existing?.[aliasesProp.name])
    ? (existing?.[aliasesProp.name] as unknown[]).filter(isString)
    : [])
  if (label) aliases.add(label)

  return {
    ...(existing ?? {}),
    ...(label ? {[extensionNameProp.name]: extensionNameProp.codec.encode(label)} : {}),
    // `description ?? ''` keeps an explicit clear (`--description ""`)
    // distinguishable from "leave existing description alone" (null).
    ...(description !== null
      ? {[extensionDescriptionProp.name]: extensionDescriptionProp.codec.encode(description ?? '')}
      : {}),
    ...(aliases.size > 0 ? {[aliasesProp.name]: aliasesProp.codec.encode([...aliases])} : {}),
  }
}

const resolveWorkspaceId = (repo: Repo): string => {
  if (repo.activeWorkspaceId) return repo.activeWorkspaceId
  throw new Error('install-extension requires an active workspace')
}

const installRuntimeExtension = async (
  repo: Repo,
  input: InstallExtensionInput,
  context: AgentRuntimeContext,
): Promise<InstallExtensionResult> => {
  const source = input.source.trimEnd()
  if (!source) throw new Error('install-extension requires non-empty source')

  // description=null means "leave existing description untouched on update,
  // skip writing it on first install". An explicit empty string clears it.
  const description = input.description === undefined ? null : input.description

  const label = input.label?.trim() || null
  const workspaceId = resolveWorkspaceId(repo)
  // Use the direct-SQL lookup rather than the cached
  // `repo.query.findExtensionBlocks`: a fresh install + immediate
  // re-install in the same tick (common in tests + scripted agent
  // flows) needs to see the just-written row before query-cache
  // invalidation has fired. Same reason set-extension-enabled and
  // uninstall use this path.
  const existing = (input.id || label)
    ? (await findExtensionBlock(repo, workspaceId, {
        id: input.id,
        label: label ?? undefined,
      }))?.block ?? null
    : null

  if (existing) {
    const typeSnapshot = repo.snapshotTypeRegistries()
    await repo.tx(async tx => {
      const current = await tx.get(existing.id)
      if (!current) throw new Error(`Extension block ${existing.id} disappeared before update`)
      const properties = extensionBlockProperties(current.properties, label, description)
      await tx.update(existing.id, {
        content: source,
        properties,
      })
      await repo.addTypeInTx(tx, existing.id, EXTENSION_TYPE, {}, typeSnapshot)
      const aliases = aliasValuesFromProperties(properties)
      if (aliases.length > 0) {
        await repo.addTypeInTx(tx, existing.id, PAGE_TYPE, {[aliasesProp.name]: aliases}, typeSnapshot)
      }
    }, {scope: ChangeScope.BlockDefault, description: `agent runtime install extension ${label ?? existing.id}`})
    // Run verify *before* refreshAppRuntime so the verify's isolated
    // facet resolution doesn't contend with the app-wide runtime
    // rebuild that the refresh kicks off. Without this ordering, an
    // install --verify against a large workspace times out the bridge
    // poll waiting for resolveAppRuntime to settle.
    const verification = input.verify
      ? await verifyExtensionBlock(repo, context, existing.id)
      : undefined
    const reloaded = input.reload !== false
    if (reloaded) refreshAppRuntime()
    return {
      id: existing.id,
      inserted: false,
      label,
      reloaded,
      ...(verification ? {verification} : {}),
    }
  }

  const parentIdFromInput = input.parentId?.trim() || null
  const defaultParent = parentIdFromInput
    ? null
    : await repo.query.aliasLookup({workspaceId, alias: agentExtensionsParentAlias}).load() as BlockData | null

  let installedId = input.id?.trim() || ''
  const typeSnapshot = repo.snapshotTypeRegistries()
  await repo.tx(async tx => {
    let rootId = parentIdFromInput ?? defaultParent?.id ?? null
    if (!rootId) {
      const rootSiblings = await tx.childrenOf(null, workspaceId)
      rootId = await tx.create({
        workspaceId,
        parentId: null,
        orderKey: keyAtEnd(rootSiblings.at(-1)?.orderKey ?? null),
        content: agentExtensionsParentAlias,
      })
      await repo.addTypeInTx(
        tx,
        rootId,
        PAGE_TYPE,
        {[aliasesProp.name]: [agentExtensionsParentAlias]},
        typeSnapshot,
      )
    }

    // When a label is supplied (the common case), nest the extension
    // block under a labelled container child of the agent-extensions
    // root. This leaves room for the user to keep notes / configuration
    // pages / etc. as siblings of the extension code block, instead of
    // every install being a flat sibling of every other install. The
    // container has no alias of its own (the extension block still owns
    // the `extension:name`/alias projection used by enable-extension
    // lookups), so there's no alias collision between the two.
    let parentId = rootId
    if (label && !parentIdFromInput) {
      const rootChildren = await tx.childrenOf(rootId, workspaceId)
      const existingContainer = rootChildren.find(
        child => child.content === label && !child.deleted,
      )
      if (existingContainer) {
        parentId = existingContainer.id
      } else {
        parentId = await tx.create({
          workspaceId,
          parentId: rootId,
          orderKey: keyAtEnd(rootChildren.at(-1)?.orderKey ?? null),
          content: label,
        })
        await repo.addTypeInTx(tx, parentId, PAGE_TYPE, {}, typeSnapshot)
      }
    }

    const siblings = await tx.childrenOf(parentId, workspaceId)
    const properties = extensionBlockProperties(undefined, label, description)
    installedId = await tx.create({
      id: installedId || undefined,
      workspaceId,
      parentId,
      orderKey: keyAtEnd(siblings.at(-1)?.orderKey ?? null),
      content: source,
      properties,
    })
    await repo.addTypeInTx(tx, installedId, EXTENSION_TYPE, {}, typeSnapshot)
    const aliases = aliasValuesFromProperties(properties)
    if (aliases.length > 0) {
      await repo.addTypeInTx(tx, installedId, PAGE_TYPE, {[aliasesProp.name]: aliases}, typeSnapshot)
    }
  }, {scope: ChangeScope.BlockDefault, description: `agent runtime install extension ${label ?? 'unnamed'}`})

  const verification = input.verify
    ? await verifyExtensionBlock(repo, context, installedId)
    : undefined
  const reloaded = input.reload !== false
  if (reloaded) refreshAppRuntime()
  return {
    id: installedId,
    inserted: true,
    label,
    reloaded,
    ...(verification ? {verification} : {}),
  }
}

const setExtensionEnabled = async (
  repo: Repo,
  input: SetExtensionEnabledInput,
): Promise<SetExtensionEnabledResult> => {
  const workspaceId = resolveWorkspaceId(repo)
  if (!input.id?.trim() && !input.label?.trim()) {
    throw new Error('set-extension-enabled requires `id` or `label`')
  }

  const found = await findExtensionBlock(repo, workspaceId, input)
  if (!found) {
    throw new Error(`No installed extension matches "${input.id ?? input.label}"`)
  }

  const prefsBlock = await getPluginPrefsBlock(repo, workspaceId, repo.user, extensionsPrefsType)
  const current = prefsBlock.peekProperty(extensionsOverridesProp) ?? new Map<string, boolean>()
  // User-installed extensions have `defaultEnabled: false`, so the
  // applyToggle convention is "absent = disabled, present-true = enabled".
  // We reuse the same map normalization the settings UI uses so the
  // override surface stays consistent between the two entry points.
  const handle = userExtensionToggle(found.block)
  const next = applyToggle(current, handle, input.enabled)
  const changed = next.size !== current.size
    || [...next.entries()].some(([id, value]) => current.get(id) !== value)

  if (changed) {
    await prefsBlock.set(extensionsOverridesProp, next)
  }

  return {id: found.block.id, label: found.label, enabled: input.enabled, changed}
}

const uninstallRuntimeExtension = async (
  repo: Repo,
  input: UninstallExtensionInput,
): Promise<UninstallExtensionResult> => {
  const workspaceId = resolveWorkspaceId(repo)
  if (!input.id?.trim() && !input.label?.trim()) {
    throw new Error('uninstall-extension requires `id` or `label`')
  }

  const found = await findExtensionBlock(repo, workspaceId, input)
  if (!found) {
    throw new Error(`No installed extension matches "${input.id ?? input.label}"`)
  }

  // Soft-delete via tx so the change flows through powersync and
  // refreshAppRuntime pulls a clean extension list on next reload.
  // We mirror the install path's scope/description naming for
  // grep-ability in the change log.
  await repo.tx(async tx => {
    await tx.delete(found.block.id)
  }, {
    scope: ChangeScope.BlockDefault,
    description: `agent runtime uninstall extension ${found.label ?? found.block.id}`,
  })

  refreshAppRuntime()
  return {id: found.block.id, label: found.label, removed: true}
}

const isActionDependenciesInput = (value: unknown): value is Record<string, unknown> =>
  value === undefined || isRecord(value)

const fakeUiStateBlock = (repo: Repo) => ({repo}) as unknown as Block

const runtimeBlock = (
  repo: Repo,
  id: unknown,
) => isString(id) && id ? repo.block(id) : null

const runRuntimeAction = async (
  command: KnownAgentCommand,
  context: AgentRuntimeContext,
) => {
  const actionId = requireString(command.id ?? command.actionId, 'actionId')
  const action = context.actions.find(candidate => candidate.id === actionId)
  if (!action) throw new Error(`Action not found: ${actionId}`)

  if (!isActionDependenciesInput(command.dependencies)) {
    throw new Error('dependencies must be an object')
  }

  const dependencies = command.dependencies ?? {}
  const uiStateBlock = runtimeBlock(context.repo, dependencies.uiStateBlockId)
    ?? runtimeBlock(context.repo, command.uiStateBlockId)
    ?? fakeUiStateBlock(context.repo)
  const block = runtimeBlock(context.repo, dependencies.blockId)
    ?? runtimeBlock(context.repo, command.blockId)
    ?? uiStateBlock

  if (action.context === 'edit-mode-cm' || action.context === 'property-editing') {
    throw new Error(
      `Action ${action.id} runs in ${action.context}; bridge run-action cannot provide editor/input UI dependencies`,
    )
  }

  const selectedBlockIds = Array.isArray(dependencies.selectedBlockIds)
    ? dependencies.selectedBlockIds.filter(isString)
    : []
  const selectedBlocks = selectedBlockIds.map(id => context.repo.block(id))
  const anchorBlock = runtimeBlock(context.repo, dependencies.anchorBlockId)

  let returned: unknown
  try {
    returned = await action.handler({
      uiStateBlock,
      block,
      selectedBlocks,
      anchorBlock,
    }, new CustomEvent('agent-runtime:run-action', {detail: {actionId}}))
  } catch (handlerError) {
    // Bubble up with action context so the CLI shows "which action
    // failed", not just an opaque dispatcher message.
    const prefix = `Action ${action.id} (${action.context}) threw: `
    if (handlerError instanceof Error) {
      handlerError.message = `${prefix}${handlerError.message}`
      throw handlerError
    }
    throw new Error(`${prefix}${String(handlerError)}`, {cause: handlerError})
  }

  return {
    id: action.id,
    description: action.description,
    context: action.context,
    ok: true,
    returnedUndefined: returned === undefined,
    returned: returned === undefined ? null : returned,
  }
}

const executeArbitraryCode = async (
  code: string,
  context: AgentRuntimeContext,
  data: unknown,
) => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as {
    new (...args: string[]): (context: AgentRuntimeContext, data: unknown) => Promise<unknown>
  }

  // Wrap user code in a nested async IIFE so its `const`/`let` get a
  // fresh block scope on every call. Without this, `const block = ...`
  // in user code would collide with the destructured `block` binding
  // exposed from ctx — the "Identifier 'block' has already been
  // declared" papercut the agent kept hitting.
  //
  // `data` is passed as a separate function arg (not via ctx) so it
  // can't collide with a `data` key the runtime context might gain
  // later. It's `undefined` when the caller didn't pass `--data` /
  // `--data-json`.
  const fn = new AsyncFunction(
    'ctx',
    'data',
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
  setExtensionEnabled,
  uninstallExtension,
  actions,
  renderers,
  refreshAppRuntime,
  React,
  ReactDOM,
  window,
  document,
} = ctx

return await (async () => {
${code}
})()
`,
  )

  return fn(context, data)
}

export const createAgentRuntimeContext = ({
  repo,
  runtime,
  safeMode,
}: AgentRuntimeBridgeOptions): AgentRuntimeContext => {
  const context: AgentRuntimeContext = {
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
    installExtension: input => installRuntimeExtension(repo, input, context),
    setExtensionEnabled: input => setExtensionEnabled(repo, input),
    uninstallExtension: input => uninstallRuntimeExtension(repo, input),
    actions: readRuntimeActions(runtime),
    renderers: runtime.read(blockRenderersFacet),
    refreshAppRuntime,
    React,
    ReactDOM,
    window,
    document,
  }

  return context
}

export const executeCommand = async (
  command: KnownAgentCommand,
  context: AgentRuntimeContext,
) => {
  switch (command.type) {
    case 'ping':
      return pingRuntime(context)

    case 'runtime-summary':
      return describeRuntimeSummary(context)

    case 'describe-runtime':
      return describeRuntime(context, {
        actions: isStringArray(command.actions) ? command.actions : undefined,
        facets: isStringArray(command.facets) ? command.facets : undefined,
        guides: optionalStringArray(command.guides ?? command.guide),
        modules: optionalStringArray(command.modules),
        components: optionalStringArray(command.components),
        storage: command.storage === true,
        brief: command.brief === true,
      })

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
        description: command.description === undefined
          ? undefined
          : requireString(command.description, 'description'),
        parentId: command.parentId === undefined
          ? undefined
          : requireString(command.parentId, 'parentId'),
        id: command.id === undefined
          ? undefined
          : requireString(command.id, 'id'),
        reload: command.reload === undefined
          ? undefined
          : Boolean(command.reload),
        verify: command.verify === undefined
          ? undefined
          : Boolean(command.verify),
      })

    case 'set-extension-enabled':
    case 'enable-extension':
    case 'disable-extension':
      return context.setExtensionEnabled({
        id: command.id === undefined ? undefined : requireString(command.id, 'id'),
        label: command.label === undefined ? undefined : requireString(command.label, 'label'),
        enabled: command.type === 'disable-extension'
          ? false
          : command.type === 'enable-extension'
            ? true
            : Boolean(command.enabled),
      })

    case 'uninstall-extension':
      return context.uninstallExtension({
        id: command.id === undefined ? undefined : requireString(command.id, 'id'),
        label: command.label === undefined ? undefined : requireString(command.label, 'label'),
      })

    case 'run-action':
    case 'action':
      return runRuntimeAction(command, context)

    case 'eval':
      return executeArbitraryCode(requireString(command.code, 'code'), context, command.data)

    default: {
      // Exhaustive — the union covers everything; TS narrows `command`
      // to `never` here. Keep the error path defensively in case the
      // bridge's safeParse pre-validation is ever relaxed.
      const unreachable = command as {type: string}
      throw new Error(`Unknown agent runtime command: ${unreachable.type}`)
    }
  }
}
