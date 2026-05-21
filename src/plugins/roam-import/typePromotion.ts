/** promoteToType — turn a Roam-isa target page into a user-defined
 *  type and retag every block that points at it via `roam:isa`.
 *
 *  Two-tx flow per docs/user-defined-types/design.html §Roam isa
 *  adoption + §7 of design.ts:
 *    Phase A: tx — add BLOCK_TYPE_TYPE + PAGE_TYPE on the target,
 *             stamp `block-type:label` + `block-type:properties`.
 *    Bridge:  the `block-type` subscription on UserTypesService picks
 *             up the new block and republishes the user-data bucket.
 *             Wait via `repo.onTypesChange` until the runtime registry
 *             carries the new id, bounded by a timeout.
 *    Phase B: tx — query roam:isa-referencing blocks (outside the tx
 *             per the bare-DB-read-inside-tx deadlock note), open a
 *             retag tx, snapshot the registry inside the tx body,
 *             addTypeInTx each candidate, optionally rewrite
 *             roam:isa to drop the promoted alias.
 *
 *  No `withProvisionalSchema`-style synchronous-append primitive
 *  (design §6 — review pressure compounded; two txs are simpler). */

import {
  BLOCK_TYPE_TYPE,
  PAGE_TYPE,
  PROPERTY_SCHEMA_TYPE,
} from '@/data/blockTypes'
import { ChangeScope } from '@/data/api'
import {
  blockTypeLabelProp,
  blockTypePropertiesProp,
  hasBlockType,
  propertyNameProp,
} from '@/data/properties'
import type { Repo } from '@/data/repo'
import { ROAM_ISA_PROP } from './properties'

export interface PromoteToTypeArgs {
  /** The Roam-isa target page (e.g. the "Person" page). */
  targetBlockId: string
  /** Display label — pre-filled from the page's alias by the UI. */
  label: string
  /** Property-schema block ids picked from the candidate-prop list. */
  propertySchemaIds: readonly string[]
  /** Default false: leave roam:isa refs on each instance for review. */
  rewriteIsaReferences?: boolean
  /** Caller cancellation signal. Aborting between Phase A and Phase B
   *  leaves the type-definition block committed but instances un-retagged;
   *  the caller can re-run `promoteToType` to finish retagging. */
  signal?: AbortSignal
  /** Sanity bound on the Phase-A→Phase-B handoff. Default 10s. */
  registrationTimeoutMs?: number
}

export class PromotionRegistrationTimeout extends Error {
  constructor(
    public readonly targetBlockId: string,
    public readonly typeLabel: string,
    public readonly timeoutMs: number,
  ) {
    super(
      `promoteToType: type-definition block for "${typeLabel}" was committed ` +
      `but did not appear in the runtime registry within ${timeoutMs}ms. ` +
      `Phase A committed; Phase B (instance retag) was not run. ` +
      `Re-run promoteToType to finish retagging — Phase A is idempotent ` +
      `(addType no-ops on already-typed blocks; setProperty overwrites ` +
      `label/properties to repair any stale values) so a second call ` +
      `safely re-runs both phases.`,
    )
    this.name = 'PromotionRegistrationTimeout'
  }
}

export class PromotionTypeUnregistered extends Error {
  constructor(
    public readonly targetBlockId: string,
    public readonly typeLabel: string,
  ) {
    super(
      `promoteToType: type "${typeLabel}" (${targetBlockId}) is no longer ` +
      `registered when Phase B opened the retag tx. Likely a sync-applied ` +
      `delete of the type-definition block from another device between ` +
      `Phase A and Phase B. Phase A committed; Phase B aborted before ` +
      `writing any retag.`,
    )
    this.name = 'PromotionTypeUnregistered'
  }
}

export async function promoteToType(
  repo: Repo,
  args: PromoteToTypeArgs,
): Promise<void> {
  args.signal?.throwIfAborted()

  const trimmedLabel = args.label.trim()
  if (trimmedLabel === '') {
    throw new Error(
      `promoteToType: label must be a non-empty string (got ${JSON.stringify(args.label)}). ` +
      `UserTypesService.tryBuildType silently skips a block-type block with an empty label.`,
    )
  }

  // repo.load returns BlockData | null for live rows only (filters
  // deleted = 0), so a non-null result is implicitly live.
  const target = await repo.load(args.targetBlockId)
  if (!target) {
    throw new Error(`promoteToType: target ${args.targetBlockId} not found or tombstoned`)
  }
  const workspaceId = target.workspaceId

  // Pre-tx validation: every property-schema ref must survive the
  // invariants tryBuildType applies at runtime. Validating here
  // surfaces the failure before Phase A commits anything.
  for (const schemaId of args.propertySchemaIds) {
    const schemaBlock = await repo.load(schemaId)
    if (!schemaBlock) {
      throw new Error(
        `promoteToType: property-schema ref ${schemaId} doesn't resolve to a live block. ` +
        `Drop it from propertySchemaIds before retrying.`,
      )
    }
    if (schemaBlock.workspaceId !== workspaceId) {
      throw new Error(
        `promoteToType: property-schema ref ${schemaId} is in workspace ` +
        `${schemaBlock.workspaceId} but the target is in ${workspaceId}. ` +
        `Cross-workspace property-schema refs aren't supported.`,
      )
    }
    if (!hasBlockType(schemaBlock, PROPERTY_SCHEMA_TYPE)) {
      throw new Error(
        `promoteToType: ref ${schemaId} is not a property-schema block ` +
        `(missing the ${PROPERTY_SCHEMA_TYPE} type tag).`,
      )
    }
    const rawName = schemaBlock.properties[propertyNameProp.name]
    const name = typeof rawName === 'string' ? rawName : ''
    if (name.trim() === '') {
      throw new Error(
        `promoteToType: property-schema block ${schemaId} has empty ` +
        `${propertyNameProp.name}; tryBuildType would silently drop it.`,
      )
    }
    const resolved = repo.userSchemas.getSchemaForBlockId(schemaId)
    if (!resolved) {
      throw new Error(
        `promoteToType: property-schema block ${schemaId} ("${name}") isn't ` +
        `published by UserSchemasService — e.g. its preset isn't loaded, its ` +
        `config didn't validate, or the block hasn't synced yet. Fix the ` +
        `schema block before retrying.`,
      )
    }
  }

  args.signal?.throwIfAborted()

  // Phase A: turn the target page into a block-type block.
  const typeSnapshot = repo.snapshotTypeRegistries()
  await repo.tx(async tx => {
    // In-tx re-check of every schema ref to close the gap between
    // pre-tx loads and tx-open (sync-applied writes could have deleted
    // or moved a schema block).
    for (const schemaId of args.propertySchemaIds) {
      const row = await tx.get(schemaId)
      if (!row || row.deleted) {
        throw new Error(`promoteToType: schema block ${schemaId} no longer exists`)
      }
      if (row.workspaceId !== workspaceId) {
        throw new Error(`promoteToType: schema block ${schemaId} moved to a different workspace`)
      }
      if (!hasBlockType(row, PROPERTY_SCHEMA_TYPE)) {
        throw new Error(`promoteToType: schema block ${schemaId} no longer carries ${PROPERTY_SCHEMA_TYPE}`)
      }
    }

    await repo.addTypeInTx(tx, args.targetBlockId, BLOCK_TYPE_TYPE, {}, typeSnapshot)
    // The target also gets PAGE_TYPE so it stays navigable as a page.
    await repo.addTypeInTx(tx, args.targetBlockId, PAGE_TYPE, {}, typeSnapshot)
    // setProperty unconditionally — on retry with a corrected label or
    // different property set the existing values get overwritten,
    // unlike initialValues' init-if-missing semantics.
    await tx.setProperty(args.targetBlockId, blockTypeLabelProp, trimmedLabel)
    await tx.setProperty(args.targetBlockId, blockTypePropertiesProp, args.propertySchemaIds)
  }, {scope: ChangeScope.BlockDefault, description: `promoteToType:create ${trimmedLabel}`})

  // Bridge: wait for UserTypesService's subscription to publish the
  // new type into the typesFacet runtime bucket.
  await waitForTypeRegistrationBounded(
    repo,
    args.targetBlockId,
    trimmedLabel,
    args.signal,
    args.registrationTimeoutMs ?? 10_000,
  )

  // Phase B: query candidates outside the tx (avoids the
  // bare-DB-read-inside-tx deadlock), retag in-tx with strict
  // existence guards.
  args.signal?.throwIfAborted()
  const candidates = await repo.queryBlocks({
    workspaceId,
    referencedBy: {id: args.targetBlockId, sourceField: ROAM_ISA_PROP},
  })
  args.signal?.throwIfAborted()

  await repo.tx(async tx => {
    // Capture the registry snapshot INSIDE the tx body. A pre-tx
    // snapshot could still carry the type even if a sync-applied
    // delete dropped the contribution between Phase A and Phase B,
    // which would write orphan ids into instance types arrays.
    const snapshotInTx = repo.snapshotTypeRegistries()

    if (!snapshotInTx.types.has(args.targetBlockId)) {
      throw new PromotionTypeUnregistered(args.targetBlockId, trimmedLabel)
    }

    for (const candidate of candidates) {
      const row = await tx.get(candidate.id)
      if (!row || row.deleted) continue
      const rawIsa = row.properties[ROAM_ISA_PROP]
      // roam:isa is a refList — codec-encoded as a JSON array of block
      // ids. queryBlocks already filtered by `referencedBy`, but the
      // candidate may have lost the ref between the pre-tx query and
      // the tx open; re-check here.
      if (!referencesTarget(rawIsa, args.targetBlockId)) continue
      await repo.addTypeInTx(tx, candidate.id, args.targetBlockId, {}, snapshotInTx)

      if (args.rewriteIsaReferences) {
        const next = stripTargetFromIsa(rawIsa, args.targetBlockId)
        await tx.update(candidate.id, {
          properties: {...row.properties, [ROAM_ISA_PROP]: next},
        })
      }
    }
  }, {scope: ChangeScope.BlockDefault, description: `promoteToType:retag ${trimmedLabel}`})
}

const referencesTarget = (rawIsa: unknown, targetId: string): boolean => {
  if (!Array.isArray(rawIsa)) return false
  return rawIsa.includes(targetId)
}

const stripTargetFromIsa = (rawIsa: unknown, targetId: string): unknown => {
  if (!Array.isArray(rawIsa)) return rawIsa
  return rawIsa.filter(id => id !== targetId)
}

async function waitForTypeRegistrationBounded(
  repo: Repo,
  typeId: string,
  typeLabel: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  if (repo.types.has(typeId)) return
  if (signal?.aborted) throw signal.reason

  await new Promise<void>((resolve, reject) => {
    let settled = false
    // Mutable holder so eslint's prefer-const stays quiet — the timer
    // is set after the early-return check below, so an inline init
    // would force the no-op cancel path through a discarded handle.
    const timerRef: {handle: ReturnType<typeof setTimeout> | null} = {handle: null}
    const dispose = repo.onTypesChange(() => {
      if (repo.types.has(typeId)) settle(resolve)
    })
    const onAbort = () => settle(() => reject(signal!.reason))
    const settle = (cb: () => void) => {
      if (settled) return
      settled = true
      if (timerRef.handle !== null) clearTimeout(timerRef.handle)
      dispose()
      signal?.removeEventListener('abort', onAbort)
      cb()
    }
    // Re-check after attaching the listener — the registration may
    // have landed in the gap between the early-return check at the
    // top and the dispose-assignment above, in which case no future
    // onTypesChange event fires for it and we'd hang until timeout.
    if (repo.types.has(typeId)) {
      settle(resolve)
      return
    }
    timerRef.handle = setTimeout(
      () => settle(() => reject(new PromotionRegistrationTimeout(typeId, typeLabel, timeoutMs))),
      timeoutMs,
    )
    signal?.addEventListener('abort', onAbort)
    // Re-check abort after attaching the listener (same race shape).
    if (signal?.aborted) settle(() => reject(signal.reason))
  })
}
