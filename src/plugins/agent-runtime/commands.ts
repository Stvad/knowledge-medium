import React from 'react'
import ReactDOM from 'react-dom'
import type { Repo } from '@/data/repo'
import type { Block } from '@/data/block'
import { ChangeScope, type BlockData, type BlockReference, type SubtreeRow } from '@/data/api'
import { aliasesProp, extensionDescriptionProp, extensionNameProp, getBlockTypes, topLevelBlockIdProp } from '@/data/properties.js'
import { EXTENSION_TYPE, PAGE_TYPE } from '@/data/blockTypes'
import { BACKLINKS_FOR_BLOCK_QUERY, type BacklinksFilter } from '@/plugins/backlinks/query.js'
import { resolveBacklinksFilter, type BacklinksFilterSpec } from '@/plugins/backlinks/resolveFilter.js'
import {
  GROUPED_BACKLINKS_FOR_BLOCK_QUERY,
  type GroupedBacklinksResult,
} from '@/plugins/grouped-backlinks/query.js'
import {
  resolveGroupedBacklinksConfig,
  type GroupedBacklinksGroupingSpec,
} from '@/plugins/grouped-backlinks/resolveConfig.js'
import type { GroupedBacklinksConfig } from '@/plugins/grouped-backlinks/config.js'
import { parseRelativeDate } from '@/utils/relativeDate.js'
import { searchBlocksAcrossSources } from '@/utils/linkTargetAutocomplete.js'
import { formatRoamDate } from '@/utils/dailyPage.js'
import { dailyNoteBlockId } from '@/plugins/daily-notes/dailyNotes.js'
import { DATA_MODEL_GUIDE } from './dataModelGuide.ts'
import { runHealthCommand } from './healthCommand.ts'
import { watchEventsRegistry } from './watchEvents.ts'
import { keyAtEnd, keyBetween } from '@/data/orderKey.js'
import { deleteSubtreeInTx } from '@/data/subtreeDelete.js'
import { syncedWriteTarget } from '@/data/syncedTableWriteGuard.js'
import { parseMarkdownToBlocks, type ParsedBlock } from '@/utils/markdownParser.js'
import {
  actionsFacet,
  appEffectsFacet,
  appMountsFacet,
  blockRenderersFacet,
} from '@/extensions/core.js'
import { readRuntimeActions } from '@/extensions/runtimeActions.js'
import { invokeAction } from '@/shortcuts/actionDispatch.js'
import type { BaseShortcutDependencies } from '@/shortcuts/types.js'
import { refreshAppRuntime } from '@/facets/runtimeEvents.js'
import { dynamicExtensionsExtension } from '@/extensions/dynamicExtensions.js'
import { resolveAppRuntime } from '@/facets/resolveAppRuntime.js'
import { applyToggle } from '@/facets/togglable.js'
import { userExtensionToggle } from '@/extensions/extensionToggles.js'
import {
  approveExtension,
  createCompileCache,
  revokeExtensionApproval,
} from '@/extensions/compileExtensionModule.js'
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
  ReconcileMarkdownSubtreeInput,
  ReconcileMarkdownSubtreeResult,
  DeleteBlockInput,
  DeleteBlockResult,
  ExtensionVerificationResult,
  InstallExtensionInput,
  InstallExtensionResult,
  MoveBlockInput,
  MoveBlockPosition,
  RestoreBlockInput,
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

const getMoveBlockPosition = (value: unknown): MoveBlockPosition => {
  if (!isRecord(value)) {
    throw new Error('position must be an object with kind first|last|before|after')
  }
  if (value.kind === 'first' || value.kind === 'last') {
    return {kind: value.kind}
  }
  if (value.kind === 'before' || value.kind === 'after') {
    return {kind: value.kind, siblingId: requireString(value.siblingId, 'position.siblingId')}
  }
  throw new Error('position.kind must be one of: first, last, before, after')
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

/** Guard for the bridge's raw `sql` verb (any mode — `execute` is the common
 *  shape, but `all`/`get`/`optional` reach the same `repo.db` connection and
 *  could carry a write statement too). A raw write to a synced table
 *  (`blocks`, `workspaces`, `workspace_members`) bypasses `repo.tx`: it
 *  leaves `tx_context.source = NULL` so the upload trigger never fires (the
 *  write is local-only — see `syncedTableWriteGuard.ts`), AND it skips the
 *  kernel's post-commit derivations (block_types, reference normalization,
 *  property projection), desyncing derived state. `allowSyncedWrite` is the
 *  explicit, one-call opt-out for a deliberate surgical fix. */
const assertSyncedTableWriteAllowed = (sql: string, allowSyncedWrite: boolean): void => {
  if (allowSyncedWrite) return
  // Scans the whole statement text — CTE prefixes, later statements, and
  // trigger bodies included (see syncedTableWriteGuard.ts).
  const target = syncedWriteTarget(sql)
  if (target === null) return
  throw new Error(
    `sql: refusing to write to synced table "${target}" via raw SQL — this bypasses ` +
      'repo.tx, so the write leaves tx_context.source = NULL (never uploads to the ' +
      'server or other clients) and skips the kernel derivations (block_types, ' +
      'reference normalization, property projection), desyncing derived state. Use ' +
      'create-block / update-block / run-action (which go through repo.tx) for a normal ' +
      'write. For a deliberate surgical fix, pass --allow-synced-write on the CLI ' +
      '(or {allowSyncedWrite: true} on the command body) to override this check.',
  )
}

const runSql = async (
  repo: Repo,
  sql: string,
  params: unknown[] = [],
  mode: SqlMode = 'all',
  allowSyncedWrite = false,
) => {
  assertSyncedTableWriteAllowed(sql, allowSyncedWrite)
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
      // Verification compiles the brand-new LIVE source in isolation to
      // inspect its contributions before any device-local approval exists,
      // so it bypasses the approval gate (#67). This does NOT run the
      // block in the app — it's a throwaway resolution for the bridge.
      verifyLiveSource: true,
      // Throwaway in-memory cache so verifying live (un-approved) source
      // never shares the process-wide cache with the user-facing loader.
      cache: createCompileCache(),
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

/** App-owned property that tags every block of a reconciled subtree with
 *  its caller-supplied `key`. The reconcile identifies "this subtree" by
 *  this tag, so it never touches user content interleaved under the same
 *  parent, and successive reconciles of the same key converge in place. */
const SUBTREE_KEY_PROP = 'agent:subtreeKey'

/** Reconcile the keyed block subtree under `parentId` to match `markdown`,
 *  in ONE transaction (atomic — never a partial tree). The markdown is
 *  parsed with the app's own paste parser (`parseMarkdownToBlocks`) so the
 *  split matches "paste as markdown" exactly; `shape:'block'` keeps it one
 *  block. Every block is tagged `SUBTREE_KEY_PROP=key` plus `properties`
 *  (the daemon passes `claude:reply`).
 *
 *  Idempotent by `key`: the tagged blocks are made to carry the parsed
 *  tree's content/parentage by a positional (pre-order) reconcile — update
 *  the block at each position, re-parent it if its parent drifted, create
 *  new tail nodes (appended contiguously with the reply's existing nodes —
 *  see `appendKey`), and (only on `final`) delete trailing tagged blocks
 *  with no parsed counterpart. So re-sending the same markdown is a no-op
 *  and a growing markdown (a live stream) just extends the tail — no
 *  duplication, safe to retry. This unifies "stream the reply" and "split
 *  the reply": streaming is repeated reconciles with the growing text; the
 *  terminal write is the last reconcile.
 *
 *  BOUNDARY: a matched block keeps its own order key, so the reply's nodes
 *  stay in correct RELATIVE order but aren't forcibly made ADJACENT. If the
 *  user deliberately drops a block BETWEEN two already-placed reply nodes
 *  mid-stream, it stays there (the reply reads split around it) rather than
 *  being evicted — respecting the user's edit over strict contiguity. The
 *  common case (a block added AFTER the reply) keeps the reply contiguous. */
const reconcileMarkdownSubtree = async (
  repo: Repo,
  input: ReconcileMarkdownSubtreeInput,
): Promise<ReconcileMarkdownSubtreeResult> => {
  const {parentId, key, properties, shape, final} = input
  // shape 'block' → the whole markdown is ONE root block (newlines kept);
  // 'outline' (default) → split along the markdown outline.
  const parsed: ParsedBlock[] = shape === 'block'
    ? (input.markdown.length === 0
        ? []
        : [{id: 'block-root', orderKey: '', content: input.markdown}])
    : parseMarkdownToBlocks(input.markdown)

  const ids: string[] = []
  const rootIds: string[] = []

  await repo.tx(async tx => {
    const parent = await tx.get(parentId)
    if (!parent) throw new Error(`reconcile-markdown-subtree: parent ${parentId} not found`)
    const {workspaceId} = parent

    // This subtree's existing blocks, in pre-order (the target we reconcile
    // onto). Walk children depth-first following ONLY tagged blocks, so user
    // content interleaved under the parent is skipped and never touched.
    const existing: BlockData[] = []
    const collect = async (pid: string): Promise<void> => {
      for (const child of await tx.childrenOf(pid, workspaceId)) {
        if (child.properties?.[SUBTREE_KEY_PROP] !== key) continue
        existing.push(child)
        await collect(child.id)
      }
    }
    await collect(parentId)

    // Cursor per real parent for APPENDING new nodes. To keep the subtree
    // CONTIGUOUS, new nodes slot right after the parent's last child ALREADY
    // TAGGED with this key (a prior reconcile's node) and BEFORE that node's
    // next sibling — so a block the user inserted after a streamed root
    // mid-run can't split the reply around unrelated content. When the parent
    // has no tagged child yet (a fresh reply, or a freshly-created reply
    // parent), append after its last child so the reply lands after existing
    // content. `keyBetween` needs a strictly-greater upper bound, so a tie
    // between the anchor and its next sibling falls back to open-ended append.
    const cursorByParent = new Map<string, {after: string | null, before: string | null}>()
    const appendKey = async (realParentId: string): Promise<string> => {
      let cursor = cursorByParent.get(realParentId)
      if (!cursor) {
        const children = await tx.childrenOf(realParentId, workspaceId)
        let anchor = -1
        for (let j = children.length - 1; j >= 0; j -= 1) {
          if (children[j].properties?.[SUBTREE_KEY_PROP] === key) { anchor = j; break }
        }
        cursor = anchor === -1
          ? {after: children.at(-1)?.orderKey ?? null, before: null}
          : {after: children[anchor].orderKey, before: children[anchor + 1]?.orderKey ?? null}
        cursorByParent.set(realParentId, cursor)
      }
      const upper = cursor.before !== null && (cursor.after === null || cursor.before > cursor.after)
        ? cursor.before
        : null
      const orderKey = keyBetween(cursor.after, upper)
      cursor.after = orderKey
      return orderKey
    }

    const idMap = new Map<string, string>()          // parsed id → real id
    const blockProps = {...(properties ?? {}), [SUBTREE_KEY_PROP]: key}

    for (let i = 0; i < parsed.length; i += 1) {
      const node = parsed[i]
      const realParentId = node.parentId ? idMap.get(node.parentId)! : parentId
      const match = i < existing.length ? existing[i] : undefined

      if (match) {
        // Reconcile the block already at this pre-order position: update its
        // content, and re-parent it (to the end of the new parent's run) only
        // if its PARENT drifted. Its own order key is left alone — a no-op on
        // the common append-only stream (stable prefix, growing tail); and a
        // deliberate boundary otherwise, so a user block wedged between two
        // matched reply nodes isn't evicted just to close the gap (see the
        // function's BOUNDARY note).
        idMap.set(node.id, match.id)
        if (match.content !== node.content) {
          await tx.update(match.id, {content: node.content})
        }
        if (match.parentId !== realParentId) {
          await tx.move(match.id, {parentId: realParentId, orderKey: await appendKey(realParentId)})
        }
      } else {
        const id = crypto.randomUUID()
        await tx.create({
          id,
          workspaceId,
          parentId: realParentId,
          orderKey: await appendKey(realParentId),
          content: node.content,
          properties: blockProps,
        })
        idMap.set(node.id, id)
      }

      const realId = idMap.get(node.id)!
      ids.push(realId)
      if (!node.parentId) rootIds.push(realId)
    }

    // Trailing extras: tagged blocks past the end of the parsed tree — only
    // reachable when the final text parses to FEWER nodes than an earlier
    // streamed tick (e.g. resultText trimmed a trailing bullet, or a failed
    // run collapses a streamed outline to a single note block). In pre-order
    // a parent precedes its children, so the trailing slice is closed under
    // descendants; delete it leaf-first (reverse order) so no parent orphans
    // a child. Only on `final` — a mid-stream tick must not delete a tail it
    // simply hasn't re-streamed yet.
    if (final && existing.length > parsed.length) {
      for (let i = existing.length - 1; i >= parsed.length; i -= 1) {
        const doomed = existing[i]
        // Salvage the user's OWN content: a block the user nested under this
        // reply node isn't tagged with our key, so `collect` never saw it and
        // it isn't in the doomed set. `tx.delete` is a single-row soft-delete
        // (no cascade), so leaving it would strand it under a tombstone and it
        // would vanish from the outline. Reparent any such foreign child up to
        // the doomed node's parent BEFORE deleting — deleting leaf-first means
        // the doomed node's own tagged children are already gone, so only
        // foreign children remain, and a child under a parent that is itself
        // doomed bubbles up again until it lands under a surviving ancestor.
        const target = doomed.parentId ?? parentId
        // Visible view: a property field row is machinery OWNED by `doomed`
        // (not foreign content), so it must not be rescued/reparented — it
        // goes with `doomed` in the subtree-delete below.
        const foreign = (await tx.childrenOf(doomed.id, workspaceId, {hidePropertyChildren: true}))
          .filter(child => child.properties?.[SUBTREE_KEY_PROP] !== key)
        if (foreign.length > 0) {
          // Land the rescued children in the doomed node's OWN slot (between
          // it and its next sibling), keeping their relative order, rather
          // than at the parent's end. Slot-anchoring is what makes order
          // correct regardless of the reverse (leaf-first) walk: each doomed
          // sibling's children land at that sibling's position, so notes
          // under an earlier reply node stay before notes under a later one,
          // and neither jumps past unrelated content that followed the reply.
          const siblings = await tx.childrenOf(target, workspaceId)
          const doomedIdx = siblings.findIndex(sibling => sibling.id === doomed.id)
          const nextKey = doomedIdx >= 0 ? siblings[doomedIdx + 1]?.orderKey ?? null : null
          let lower: string | null = doomed.orderKey ?? null
          for (const child of foreign) {
            const upper = nextKey !== null && (lower === null || nextKey > lower) ? nextKey : null
            const orderKey = keyBetween(lower, upper)
            await tx.move(child.id, {parentId: target, orderKey})
            lower = orderKey
          }
        }
        // Subtree-delete (not single-row): after foreign content is rescued
        // above, `doomed`'s only remaining descendants are its own property
        // field/value machinery, which must be tombstoned with it rather
        // than stranded live under the tombstone (§9). In an un-flipped
        // workspace there is no machinery, so this equals the single-row
        // delete it replaces.
        await deleteSubtreeInTx(tx, doomed.id)
      }
    }
  }, {scope: ChangeScope.BlockDefault, description: 'agent runtime reconcile markdown subtree'})

  return {ids, rootIds}
}

const updateRuntimeBlock = async (
  repo: Repo,
  input: UpdateBlockInput,
): Promise<BlockData | null> => {
  // Read INSIDE the tx so a merge-update is an ATOMIC read-modify-write.
  // repo.tx runs its whole body in one db.writeTransaction, which SQLite
  // serializes against every other writer — so no concurrent update to the
  // same block can land between this read and this write. A prior
  // repo.load-then-merge OUTSIDE the tx had a TOCTOU: a full-map write built
  // from a stale snapshot clobbered any property another writer set in the
  // gap (e.g. an agent-dispatch orphan-clear reverting a channel task's
  // concurrently-written agent:status back to `running`).
  let found = false
  await repo.tx(async tx => {
    const before = await tx.get(input.id)
    if (!before || before.deleted) return
    found = true
    const nextProperties = input.properties === undefined
      ? undefined
      : input.replaceProperties
        ? structuredClone(input.properties) as Record<string, unknown>
        : {...before.properties, ...structuredClone(input.properties)} as Record<string, unknown>
    // Deliberately the RAW bag write, not the typed setProperty/setProperties:
    // `input.properties` is arbitrary external JSON (raw-encoded values, often
    // schema-less keys from agent extensions). The typed primitives would throw
    // on an unresolvable schema or an undecodable value; the raw write + the
    // same-tx MATERIALIZE processor instead reconciles the schema-backed,
    // decodable subset into children (create/update, and delete-by-omission on
    // a `replaceProperties` replace) and gracefully leaves the rest cell-only
    // (MATERIALIZE skips keys it can't resolve/decode). Read-inside-tx above
    // already closed the TOCTOU clobber this verb was once flagged for.
    await tx.update(input.id, {
      ...(input.content !== undefined ? {content: input.content} : {}),
      ...(nextProperties !== undefined ? {properties: nextProperties} : {}),
    })
  }, {scope: ChangeScope.BlockDefault, description: 'agent runtime block update'})

  if (!found) throw new Error(`updateBlock: block ${input.id} not found`)
  return repo.load(input.id)
}

const moveRuntimeBlock = async (
  repo: Repo,
  input: MoveBlockInput,
): Promise<BlockData | null> => {
  await repo.mutate.move(input)
  return repo.load(input.id)
}

const deleteRuntimeBlock = async (
  repo: Repo,
  input: DeleteBlockInput,
): Promise<DeleteBlockResult> => {
  await repo.mutate.delete(input)
  return {id: input.id, deleted: true}
}

const restoreRuntimeBlock = async (
  repo: Repo,
  input: RestoreBlockInput,
): Promise<BlockData | null> => {
  await repo.mutate.restore(input)
  return repo.load(input.id)
}

const extensionBlockProperties = (
  existing: BlockProperties | undefined,
  label: string | null,
  description: string | null,
): BlockProperties => {
  // Extensions are identified by `extension:name` only — install no
  // longer writes an alias or tags PAGE_TYPE. An aliased block whose
  // content is its own source would have that source mirrored into an
  // alias by the content↔alias parity processor
  // (`@/plugins/alias/syncProcessor.ts`).
  return {
    ...(existing ?? {}),
    ...(label ? {[extensionNameProp.name]: extensionNameProp.codec.encode(label)} : {}),
    // `description ?? ''` keeps an explicit clear (`--description ""`)
    // distinguishable from "leave existing description alone" (null).
    ...(description !== null
      ? {[extensionDescriptionProp.name]: extensionDescriptionProp.codec.encode(description ?? '')}
      : {}),
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
    // extension block itself is identified by `extension:name`, not an
    // alias (see extensionBlockProperties), so it carries no PAGE_TYPE /
    // alias to keep its source out of the alias index.
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

  // Enable grants device-local trust (issue #67): the bridge is an
  // authorized local actor, so enabling (re-)approves the CURRENT source on
  // this device, pinned to its hash. This is also how the agent ships an
  // update — install the new source, then enable to re-pin — which is why
  // it always re-approves rather than only-if-absent (unlike the cautious
  // settings-UI checkbox). Disable leaves the trust grant intact and only
  // flips intent, so it propagates across devices through the intent gate.
  if (input.enabled) {
    await approveExtension(found.block.id, found.block.content ?? '')
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
  // Re-pinning an already-enabled extension (changed === false) writes no
  // intent, so the prefs-block subscription won't fire a refresh — do it
  // explicitly so the freshly approved source takes effect.
  if (input.enabled && !changed) {
    refreshAppRuntime()
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

  // Drop this device's trust grant + cached compiled output for the block
  // (issue #67): the block is gone, so its approval row would otherwise be
  // a true orphan. Best-effort — uninstall must not fail on a flaky delete.
  await revokeExtensionApproval(found.block.id)

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
  const realUiStateBlock = runtimeBlock(context.repo, dependencies.uiStateBlockId)
    ?? runtimeBlock(context.repo, command.uiStateBlockId)
  const uiStateBlock = realUiStateBlock ?? fakeUiStateBlock(context.repo)
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

  // Imperative runner (no React context), so scopeRootId isn't injected
  // by useShortcutSurfaceActivations. Forward a caller-supplied one, else
  // derive the panel scope — but only from a REAL ui-state block;
  // `fakeUiStateBlock` is a bare {repo} with no peekProperty.
  const scopeRootId = isString(dependencies.scopeRootId)
    ? dependencies.scopeRootId
    : realUiStateBlock?.peekProperty(topLevelBlockIdProp)

  // Route imperative agent dispatch through the same `invokeAction` choke the
  // keyboard / pointer / runActionById paths use, so the action-dispatch
  // middleware (and the behaviour decorators migrated off `actionTransformsFacet`)
  // cover M-x-style dispatch too — otherwise calling `action.handler` directly
  // would skip the decorators the effective action no longer carries.
  const deps = {
    uiStateBlock,
    block,
    selectedBlocks,
    anchorBlock,
    scopeRootId,
  } as BaseShortcutDependencies
  const trigger = new CustomEvent('agent-runtime:run-action', {detail: {actionId}})
  let returned: unknown
  try {
    returned = await invokeAction(context.runtime, {action, deps, trigger})
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

// ----- backlinks / grouped-backlinks --------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface HydratedBlockRef {
  id: string
  content: string
  types: string[]
  deepLink: string
}

const deepLinkFor = (workspaceId: string, blockId: string): string =>
  `#${workspaceId}/${blockId}`

const HYDRATE_BLOCK_REFS_SQL = `
  SELECT b.id AS id, b.content AS content,
         b.properties_json AS properties_json, b.workspace_id AS workspace_id
  FROM json_each(?) j
  JOIN blocks b ON b.id = j.value
  WHERE b.deleted = 0
`

interface HydrateRow {
  id: string
  content: string | null
  properties_json: string | null
  workspace_id: string | null
}

/** Hydrate a list of block ids into {id, content, types, deepLink},
 *  preserving the input order. One JSON-array bind regardless of count
 *  (avoids the SQLite parameter ceiling on heavily-linked targets). */
const hydrateBlockRefs = async (
  repo: Repo,
  fallbackWorkspaceId: string,
  ids: readonly string[],
): Promise<HydratedBlockRef[]> => {
  if (ids.length === 0) return []
  const rows = await repo.db.getAll<HydrateRow>(HYDRATE_BLOCK_REFS_SQL, [JSON.stringify(ids)])
  const byId = new Map(rows.map(row => [row.id, row]))
  return ids.map(id => {
    const row = byId.get(id)
    let types: string[] = []
    if (row?.properties_json) {
      try {
        const properties = JSON.parse(row.properties_json) as Record<string, unknown>
        types = [...getBlockTypes({properties: properties as BlockProperties})]
      } catch {
        types = []
      }
    }
    return {
      id,
      content: row?.content ?? '',
      types,
      deepLink: deepLinkFor(row?.workspace_id ?? fallbackWorkspaceId, id),
    }
  })
}

const SOURCE_FIELDS_SQL = `
  SELECT DISTINCT source_id, source_field
  FROM block_references
  WHERE workspace_id = ? AND target_id = ?
`

/** Map each backlink source to the set of source_fields it referenced the
 *  target through. `''` means a plain text wikilink; other values are
 *  projected property refs (groupWith, next-review-date, …). */
const sourceFieldsByBacklink = async (
  repo: Repo,
  workspaceId: string,
  targetId: string,
): Promise<Map<string, string[]>> => {
  const rows = await repo.db.getAll<{source_id: string, source_field: string}>(
    SOURCE_FIELDS_SQL,
    [workspaceId, targetId],
  )
  const out = new Map<string, Set<string>>()
  for (const row of rows) {
    let set = out.get(row.source_id)
    if (!set) {
      set = new Set()
      out.set(row.source_id, set)
    }
    set.add(row.source_field)
  }
  return new Map([...out].map(([id, set]) => [id, [...set].sort()]))
}

const resolveBlockWorkspaceId = async (
  repo: Repo,
  blockId: string,
  override: unknown,
): Promise<string> => {
  if (isString(override) && override) return override
  const data = await repo.load(blockId)
  if (data?.workspaceId) return data.workspaceId
  if (repo.activeWorkspaceId) return repo.activeWorkspaceId
  throw new Error(`Cannot resolve a workspace for block ${blockId}; pass workspaceId`)
}

const parseFilterSpec = (value: unknown): BacklinksFilterSpec | undefined => {
  if (value === undefined) return undefined
  if (value === 'none' || value === 'stored' || value === 'effective') return value
  if (isRecord(value)) return value as BacklinksFilter
  throw new Error("filter must be 'none' | 'stored' | 'effective' or a BacklinksFilter object")
}

const parseGroupingSpec = (value: unknown): GroupedBacklinksGroupingSpec | undefined => {
  if (value === undefined) return undefined
  if (value === 'user' || value === 'none') return value
  if (isRecord(value)) return value as Partial<GroupedBacklinksConfig>
  throw new Error("grouping must be 'user' | 'none' or a grouping-config object")
}

interface BacklinksCommandResult {
  target: HydratedBlockRef
  workspaceId: string
  total: number
  filter: BacklinksFilter | null
  backlinks: Array<HydratedBlockRef & {sourceFields: string[]}>
}

const runBacklinksCommand = async (
  repo: Repo,
  command: KnownAgentCommand,
): Promise<BacklinksCommandResult> => {
  const id = requireString(command.blockId ?? command.id, 'blockId')
  const workspaceId = await resolveBlockWorkspaceId(repo, id, command.workspaceId)
  const filter = await resolveBacklinksFilter(repo, workspaceId, id, parseFilterSpec(command.filter))

  const ids = await repo.query[BACKLINKS_FOR_BLOCK_QUERY]({
    workspaceId,
    id,
    ...(filter ? {filter} : {}),
  }).load()

  const [hydrated, fieldsBySource, [target]] = await Promise.all([
    hydrateBlockRefs(repo, workspaceId, ids),
    sourceFieldsByBacklink(repo, workspaceId, id),
    hydrateBlockRefs(repo, workspaceId, [id]),
  ])

  return {
    target,
    workspaceId,
    total: ids.length,
    filter: filter ?? null,
    backlinks: hydrated.map(ref => ({
      ...ref,
      sourceFields: fieldsBySource.get(ref.id) ?? [],
    })),
  }
}

interface GroupedBacklinksCommandGroup {
  groupId: string
  label: string
  fallback: boolean
  deepLink: string | null
  members: HydratedBlockRef[]
}

interface GroupedBacklinksCommandResult {
  target: HydratedBlockRef
  workspaceId: string
  total: number
  filter: BacklinksFilter | null
  grouping: GroupedBacklinksConfig
  groups: GroupedBacklinksCommandGroup[]
}

const runGroupedBacklinksCommand = async (
  repo: Repo,
  command: KnownAgentCommand,
): Promise<GroupedBacklinksCommandResult> => {
  const id = requireString(command.blockId ?? command.id, 'blockId')
  const workspaceId = await resolveBlockWorkspaceId(repo, id, command.workspaceId)
  const filter = await resolveBacklinksFilter(repo, workspaceId, id, parseFilterSpec(command.filter))
  const grouping = await resolveGroupedBacklinksConfig(
    repo,
    workspaceId,
    id,
    parseGroupingSpec(command.grouping),
  )

  const result = await repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY]({
    workspaceId,
    id,
    groupingConfig: grouping,
    ...(filter ? {filter} : {}),
  }).load() as GroupedBacklinksResult

  const memberIds = [...new Set(result.groups.flatMap(group => group.sourceIds))]
  const [members, [target]] = await Promise.all([
    hydrateBlockRefs(repo, workspaceId, memberIds),
    hydrateBlockRefs(repo, workspaceId, [id]),
  ])
  const memberById = new Map(members.map(member => [member.id, member]))

  return {
    target,
    workspaceId,
    total: result.total,
    filter: filter ?? null,
    grouping,
    groups: result.groups.map(group => ({
      groupId: group.groupId,
      label: group.label,
      fallback: group.fallback,
      deepLink: UUID_RE.test(group.groupId) ? deepLinkFor(workspaceId, group.groupId) : null,
      members: group.sourceIds.map(sourceId =>
        memberById.get(sourceId) ?? {
          id: sourceId,
          content: '',
          types: [],
          deepLink: deepLinkFor(workspaceId, sourceId),
        },
      ),
    })),
  }
}

// ----- page / daily-note / search -----------------------------------

const hydrateData = (data: BlockData): HydratedBlockRef => ({
  id: data.id,
  content: data.content ?? '',
  types: [...getBlockTypes(data)],
  deepLink: deepLinkFor(data.workspaceId, data.id),
})

const commandWorkspaceId = (repo: Repo, override: unknown): string => {
  if (isString(override) && override) return override
  if (repo.activeWorkspaceId) return repo.activeWorkspaceId
  throw new Error('No active workspace; pass workspaceId')
}

interface PageCommandResult {
  query: string
  workspaceId: string
  match: HydratedBlockRef | null
  candidates: Array<{id: string, alias: string, content: string, deepLink: string}>
}

const runPageCommand = async (
  repo: Repo,
  command: KnownAgentCommand,
): Promise<PageCommandResult> => {
  const name = requireString(command.name, 'name')
  const workspaceId = commandWorkspaceId(repo, command.workspaceId)
  const limit = typeof command.limit === 'number' ? command.limit : 20

  const exact = await repo.query.aliasLookup({workspaceId, alias: name}).load() as BlockData | null
  const candidates = await repo.query.aliasMatches({workspaceId, filter: name, limit}).load()

  return {
    query: name,
    workspaceId,
    match: exact ? hydrateData(exact) : null,
    candidates: candidates.map(row => ({
      id: row.blockId,
      alias: row.alias,
      content: row.content,
      deepLink: deepLinkFor(workspaceId, row.blockId),
    })),
  }
}

interface DailyNoteCommandResult {
  input: string
  iso: string
  title: string
  workspaceId: string
  blockId: string
  exists: boolean
  deepLink: string
  block: HydratedBlockRef | null
}

const runDailyNoteCommand = async (
  repo: Repo,
  command: KnownAgentCommand,
): Promise<DailyNoteCommandResult> => {
  const input = requireString(command.date, 'date')
  const workspaceId = commandWorkspaceId(repo, command.workspaceId)
  const parsed = parseRelativeDate(input)
  if (!parsed) {
    throw new Error(
      `Could not parse "${input}" as a date. Try today | yesterday | 2026-06-18 | "June 17th, 2026" | "next monday".`,
    )
  }

  // Daily-note ids are deterministic (uuidv5 of workspace+ISO), so the
  // id is known whether or not the note has been created yet.
  const blockId = dailyNoteBlockId(workspaceId, parsed.iso)
  const data = await repo.load(blockId)

  return {
    input,
    iso: parsed.iso,
    title: formatRoamDate(parsed.date),
    workspaceId,
    blockId,
    exists: data !== null,
    deepLink: deepLinkFor(workspaceId, blockId),
    block: data ? hydrateData(data) : null,
  }
}

interface SearchCommandResult {
  query: string
  workspaceId: string
  total: number
  results: HydratedBlockRef[]
}

const runSearchCommand = async (
  repo: Repo,
  command: KnownAgentCommand,
): Promise<SearchCommandResult> => {
  const query = requireString(command.query, 'query')
  const workspaceId = commandWorkspaceId(repo, command.workspaceId)
  const limit = typeof command.limit === 'number' ? command.limit : 50

  // Shared merge point (searchSourcesFacet), not a direct
  // `searchByContent` call, so a contributed search source (e.g. semantic
  // search) is reachable from the agent `search` command too.
  const rows = await searchBlocksAcrossSources(repo, {workspaceId, query, limit})
  return {
    query,
    workspaceId,
    total: rows.length,
    results: rows.map(hydrateData),
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
  moveBlock,
  deleteBlock,
  restoreBlock,
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
    sql: (sql, params, mode, allowSyncedWrite) => runSql(repo, sql, params, mode, allowSyncedWrite),
    block: id => repo.block(id),
    getBlock: id => repo.load(id),
    // The visible outline: `get-subtree` (and the MCP `subtree` tool, and
    // agent-dispatch's prompt render) already surface each row's property BAG,
    // so emitting field/value rows too would show the same properties a second
    // time as `((fieldId))` blocks pretending to be user content. Agents that
    // genuinely want raw storage have `sql` (PR #386 review).
    getSubtree: async rootId =>
      await repo.query.subtree({id: rootId, hidePropertyChildren: true}).load() as SubtreeRow[],
    createBlock: input => createRuntimeBlock(repo, input),
    reconcileMarkdownSubtree: input => reconcileMarkdownSubtree(repo, input),
    updateBlock: input => updateRuntimeBlock(repo, input),
    moveBlock: input => moveRuntimeBlock(repo, input),
    deleteBlock: input => deleteRuntimeBlock(repo, input),
    restoreBlock: input => restoreRuntimeBlock(repo, input),
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

    case 'health':
      return runHealthCommand(context.repo)

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

      return context.sql(sql, getParams(command.params), mode, command.allowSyncedWrite === true)
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

    case 'reconcile-markdown-subtree': {
      const properties = command.properties === undefined
        ? undefined
        : isRecord(command.properties)
          ? structuredClone(command.properties) as BlockProperties
          : undefined
      if (command.properties !== undefined && !properties) {
        throw new Error('properties must be an object')
      }
      return context.reconcileMarkdownSubtree({
        parentId: requireString(command.parentId, 'parentId'),
        markdown: requireString(command.markdown, 'markdown'),
        key: requireString(command.key, 'key'),
        shape: command.shape === 'block' ? 'block' : command.shape === 'outline' ? 'outline' : undefined,
        final: command.final === true,
        properties,
      })
    }

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

    case 'move-block': {
      const parentId = command.parentId === null
        ? null
        : requireString(command.parentId, 'parentId')
      return context.moveBlock({
        id: requireString(command.blockId ?? command.id, 'blockId'),
        parentId,
        position: getMoveBlockPosition(command.position),
      })
    }

    case 'delete-block':
      return context.deleteBlock({
        id: requireString(command.blockId ?? command.id, 'blockId'),
      })

    case 'restore-block':
      return context.restoreBlock({
        id: requireString(command.blockId ?? command.id, 'blockId'),
      })

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

    case 'backlinks':
      return runBacklinksCommand(context.repo, command)

    case 'grouped-backlinks':
      return runGroupedBacklinksCommand(context.repo, command)

    case 'data-model':
      return DATA_MODEL_GUIDE

    case 'page':
      return runPageCommand(context.repo, command)

    case 'daily-note':
      return runDailyNoteCommand(context.repo, command)

    case 'search':
      return runSearchCommand(context.repo, command)

    case 'watch-events':
      // Detection relocation (see watchEvents.ts): the tab hosts the
      // reactive watchers; the registering consumer long-polls the
      // bridge events channel for their settle events.
      return watchEventsRegistry.register(context.db, {
        consumer: command.consumer,
        watchers: command.watchers,
        ttlMs: command.ttlMs,
      })

    default: {
      // Exhaustive — the union covers everything; TS narrows `command`
      // to `never` here. Keep the error path defensively in case the
      // bridge's safeParse pre-validation is ever relaxed.
      const unreachable = command as {type: string}
      throw new Error(`Unknown agent runtime command: ${unreachable.type}`)
    }
  }
}
