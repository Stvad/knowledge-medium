// Design sketch for the user-defined types system.
//
// Companion to design.html. The prose describes; this file specifies.
// The typechecker — not a human reviewer — rejects drift between the
// design pieces and the codebase.
//
// Not a build artifact. Function bodies are skeletons; types reference
// real codebase paths so renames in src/ break this file too.
//
// Typecheck (along with every other docs/**/*.ts sketch) with:
//   pnpm tsc --noEmit --project docs/tsconfig.json

import type {Block} from '@/data/block'
import type {Repo} from '@/data/repo'
import type {UserSchemasService} from '@/data/userSchemasService'
import type {Tx} from '@/data/api/tx'
import type {
  AnyPropertySchema,
  TypeContribution,
  TypeRegistrySnapshot,
} from '@/data/api'
import type {SameTxEvent, SameTxCtx} from '@/data/api/sameTxProcessor'
import {
  ChangeScope,
  codecs,
  defineBlockType,
  defineProperty,
  defineSameTxProcessor,
} from '@/data/api'
import {addedTypes, aliasesProp, hasBlockType, propertyNameProp} from '@/data/properties'
import {PAGE_TYPE, PROPERTY_SCHEMA_TYPE} from '@/data/blockTypes'
import {propertySchemasFacet, typesFacet} from '@/data/facets'
import {createChild} from '@/data/mutators'

// ──────────────────────────────────────────────────────────────────────
// Phase 1 API addition: Repo.onTypesChange
//
// Symmetric to the existing `onPropertySchemasChange` /
// `onValuePresetsChange` listeners (src/data/repo.ts:1402, :1415).
// Fires when the rebuild step republishes the merged `_types` map —
// after a typesFacet contribution change (e.g. UserTypesService's
// setRuntimeContributions publish lands and the step re-runs).
//
// Used by the extract-type flow's `createTypeBlock` to bridge the
// commit of the type-definition block and the registration of its
// contribution into the live `typesFacet` bucket without polling.
//
// Module augmentation here is intentional — the design file declares
// the API addition concretely so consumers can compile against the
// shape now; the kernel implementation lands in Phase 1.
// ──────────────────────────────────────────────────────────────────────

declare module '@/data/repo' {
  interface Repo {
    onTypesChange(listener: () => void): () => void
  }
}

// ──────────────────────────────────────────────────────────────────────
// Phase 1 API addition: UserSchemasService.getSchemaForBlockId
//
// Routes UserTypesService's `block-type:properties` ref resolution
// through the existing schemas service rather than peeking the
// referenced schema blocks directly. Avoids two cold-start footguns:
//
//   1. BlockCache hydration race — peek() on an unloaded row returns
//      undefined, so valid refs would silently drop on first rebuild
//      until something else triggered hydration.
//   2. Cross-block invariant duplication — UserSchemasService already
//      validates schemas pass workspace/type/name/preset checks
//      before publishing; a successful getSchemaForBlockId proves
//      those invariants hold, no re-derivation needed.
//
// Implementation: UserSchemasService grows a private blockIdToName
// map populated alongside the existing nameToBlockId in rebuild and
// appendUserSchema. getSchemaForBlockId(blockId) reads blockIdToName,
// then this.contributions for the matching schema. O(1).
// ──────────────────────────────────────────────────────────────────────

declare module '@/data/userSchemasService' {
  interface UserSchemasService {
    getSchemaForBlockId(blockId: string): AnyPropertySchema | undefined
  }
}

// ──────────────────────────────────────────────────────────────────────
// 1. Kernel `block-type` type and its slots
//
// Symmetric to the `property-schema` kernel type already in
// src/data/blockTypes.ts. User-defined types persist as blocks of this
// type, hosted on a per-workspace Types page.
//
// The type-definition block is the user's block, not a hidden shadow.
// When a user marks a block as a type (via the type-system UI or by
// the future recurring-tasks template flow), that same block becomes
// the type definition AND remains a navigable, editable page. One
// block, dual role. The block's id is the persisted type id (see §3).
// ──────────────────────────────────────────────────────────────────────

export const BLOCK_TYPE_TYPE = 'block-type'
export const TYPES_PAGE_TYPE = 'panel:types'

export const blockTypeLabelProp = defineProperty<string>('block-type:label', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

export const blockTypeDescriptionProp = defineProperty<string>('block-type:description', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

export const blockTypePropertiesProp = defineProperty<readonly string[]>('block-type:properties', {
  // RefList over `property-schema` blocks. The runtime dereferences each
  // ref, reads `propertyName` from the schema block, and joins to the
  // merged `repo.propertySchemas` map for the lifted schema entry.
  codec: codecs.refList({targetTypes: ['property-schema']}),
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})

export const blockTypeKernelType = defineBlockType({
  id: BLOCK_TYPE_TYPE,
  label: 'Type',
  properties: [
    blockTypeLabelProp,
    blockTypeDescriptionProp,
    blockTypePropertiesProp,
  ],
})

// ──────────────────────────────────────────────────────────────────────
// Phase 4 (templates, deferred): block-type:template — NOT declared here
//
// The prop is intentionally absent from this spec file. Phase 1 ships
// only label / description / properties[] on the kernel block-type
// contribution; the template field, the materializer (§5), and the
// cycle guard (§5b) all land together in Phase 4 against a real
// consumer (the recurring-tasks template flow). design.ts is the typed
// spec, not a sketchpad — declaring the prop now would lead the
// implementation by an entire phase. §5a / §5b below preserve the
// descendants-only and tx-time-cycle-detection rationale so the Phase 4
// implementation has a clear contract to land against.
//
// Also deferred (see design.html §What's deferred): `block-type:extends`
// and the TypeOverride / mergeTypeOverrides merge step (§4). Not
// declared here for the same reason.
// ──────────────────────────────────────────────────────────────────────

/** The Types page itself follows the "type flow" pattern landed in
 *  the merged kernel: it carries both PAGE_TYPE (for normal page
 *  affordances — open, alias, navigate) AND a marker type so
 *  `block_types`-keyed lookups can find it. Mirrors how the
 *  Properties page now carries both PAGE_TYPE and PROPERTIES_PAGE_TYPE
 *  (src/data/propertiesPage.ts). */
export const typesPageKernelType = defineBlockType({
  id: TYPES_PAGE_TYPE,
  label: 'Types page',
})

// ──────────────────────────────────────────────────────────────────────
// 2. UserTypesService — subscription + synchronous-append + rollback
//
// Mirrors UserSchemasService (src/data/userSchemasService.ts) in
// shape: subscribe to `block-type` blocks via repo.subscribeBlocks,
// build TypeContribution[], publish into the `'user-data'` source
// bucket on typesFacet via setRuntimeContributions. Re-resolve when
// the merged schema map changes (a newly-loaded property schema makes
// a previously-unresolvable ref in block-type:properties suddenly
// resolvable).
//
// Concurrency model deliberately narrowed (see §6, "Lessons from
// withProvisionalSchema"): the service supports the single-caller-
// per-name flow. The complex provisional/rollback semantics that
// withProvisionalSchema chased through PR #50 are NOT mirrored here;
// callers needing in-tx dependents commit the type-definition block
// in its own tx and let the subscription rebuild register the type
// before opening the dependent tx (see §7 extract-type flow).
// ──────────────────────────────────────────────────────────────────────

export class UserTypesService {
  private contributions: readonly TypeContribution[] = []
  private nameToBlockId = new Map<string, string>()
  private subscriptionDisposer: (() => void) | null = null

  constructor(
    private readonly repo: Repo,
    // Phase 1 addition: UserSchemasService grows getSchemaForBlockId
    // (with internal blockIdToName mirror) so UserTypesService can
    // resolve block-type:properties refs without peek-based cache-
    // hydration races. See design.html §Phase 1 checklist.
    private readonly userSchemas: UserSchemasService,
  ) {}

  start(_workspaceId: string): () => void {
    // Pin the workspace at start() time. The React provider restarts
    // this service on workspace switch, so capturing here pairs the
    // subscription's lifetime to one workspace explicitly (the same
    // shape UserSchemasService landed on PR #48).
    //
    // ...subscription wiring follows UserSchemasService exactly...
    return () => this.dispose()
  }

  dispose(): void {
    this.subscriptionDisposer?.()
    this.subscriptionDisposer = null
  }

  /** Build a TypeContribution from a user-authored block-type block.
   *  Returns null + diagnostic when the label is empty. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private tryBuildType(
    block: Block,
    _schemas: ReadonlyMap<string, AnyPropertySchema>,
  ): TypeContribution | null {
    // ... read blockTypeLabelProp / blockTypePropertiesProp / etc.
    // ... resolve blockTypePropertiesProp refList → schema name → merged schemas map ...
    // ... return TypeContribution
    return null
  }

  /** Look up the user-data type contribution for a block id. */
  getTypeBlockId(typeId: string): string | undefined {
    return this.nameToBlockId.get(typeId)
  }
}

// ──────────────────────────────────────────────────────────────────────
// 3. Type id = block id
//
// User-defined types persist their id IN the typesProp array of every
// instance block. The id is the type-definition block's id (a uuid),
// not a slug from the label. Two reasons:
//
//   - Renaming the label doesn't invalidate every instance's typesProp.
//   - retagBlocks is mechanical: append the type-definition block's id
//     to typesProp on each picked candidate (see §7).
//
// The picker / panel UI shows blockTypeLabelProp, never the id.
// ──────────────────────────────────────────────────────────────────────

// (No code shape needed here — the id space is just the string union
// of kernel ids and block-uuid strings.)

// ──────────────────────────────────────────────────────────────────────
// 4. Override merge (extends) — DEFERRED
//
// `block-type:extends` and the merge step that folds overrides into
// the base TypeContribution are deferred (see design.html §What's
// deferred). No concrete consumer today. The cut keeps v1 simple;
// adding the override mechanism later is mechanical and the
// design.html section preserves the full spec (property name, merge
// rules, renderer affordance).
// ──────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────
// 5. Behavior replacement: same-tx processor, not setup
//
// Per `docs/type-system.md` §3a-setup the original design carried
// behavior on `TypeContribution.setup`. Replacing that with a field-
// watching same-tx processor (per `src/data/api/sameTxProcessor.ts`)
// removes the bypass footgun across raw / plan / orchestrated write
// paths — every property write goes through commit pipeline
// regardless of who wrote it.
//
// Local-only constraint: sync-applied writes still bypass repo.tx
// per src/data/internals/rowEventsTail.ts (the gap the design.html
// "Sync-apply gap" subsection covers). Type-add behaviors that MUST
// run on cross-device tagging use a separate post-commit processor
// wired to the row_events tail.
// ──────────────────────────────────────────────────────────────────────

/** Delta helpers shipped in src/data/properties.ts (Phase 2 — landed).
 *  Re-imported here so the design's example processor (below) keeps
 *  compiling against the real helpers, not a local stub. */
export { addedTypes, removedTypes } from '@/data/properties'

/** Example: a type-defined per-instance template materializer. Runs
 *  inside the same tx as the type-add via the same-tx processor
 *  pipeline. Idempotent per row (init-if-missing semantics so a
 *  re-add doesn't duplicate template children). */
export const typeTemplateMaterializer = defineSameTxProcessor({
  name: 'userTypes.materializeTemplate',
  watches: {kind: 'field', table: 'blocks', fields: ['properties']},
  apply: async (event: SameTxEvent, _ctx: SameTxCtx) => {
    for (const row of event.changedRows) {
      const added = addedTypes(row)
      if (added.length === 0) continue
      // ... for each added typeId, look up its block-type:template
      // refList in ctx.propertySchemas-resolved registry, clone the
      // descendants under row.after.id ...
    }
  },
})

// ──────────────────────────────────────────────────────────────────────
// 5a. Template materialization: descendants only
//
// `block-type:template` is a refList of root blocks. When the type is
// added to an instance, the children of each referenced root are
// attached under the instance — the root itself is NOT cloned.
//
// Rationale: matches the shape of every other code path that adds
// children today (createChild appending under a parent), and avoids
// the surprise of an instance having a duplicate root block. If a
// future use case needs root-included clone, add a separate slot
// (e.g. `block-type:template-root-included`) with explicit naming.

// ──────────────────────────────────────────────────────────────────────
// 5b. Cycle detection on block-type:template
//
// A footgun: if a block-type block at id T1 lists a root R1 in its
// template, and R1's subtree contains a block tagged with type T1,
// materialization recurses indefinitely on instantiation. Easily
// constructed accidentally (user drags an instance back into a
// template).
//
// Reject at tx-time, not at materialization-time. A same-tx
// processor watching `properties` (for typesProp changes) and
// `parent_id` (for moves) checks the would-be-resulting state and
// throws ProcessorRejection if it'd create a self-referential cycle.
// Cleaner error surface (the user sees "this block can't be moved
// into its own type's template") than a depth-guard surface ("hit
// recursion limit during materialization").
// ──────────────────────────────────────────────────────────────────────

export const templateCycleGuard = defineSameTxProcessor({
  name: 'userTypes.templateCycleGuard',
  watches: {kind: 'field', table: 'blocks', fields: ['properties', 'parentId']},
  apply: async (_event: SameTxEvent, _ctx: SameTxCtx) => {
    // For each row whose typesProp gained types or whose parent_id
    // changed: walk up the parent chain from row.after looking for
    // an ancestor B such that any of row.after's types appears in
    // B's blockTypeTemplateProp refList. If found, throw
    // ProcessorRejection('userTypes.templateCycle').
  },
})

// ──────────────────────────────────────────────────────────────────────
// 6. Lessons from withProvisionalSchema (PR #50)
//
// withProvisionalSchema started as "register synchronously, run tx,
// rollback on failure." The shape compounded under review into per-
// call CAS tokens, committed-only mirrors, etc. — each fix valid,
// but the scope kept widening for a use case (concurrent overlapping
// calls for the same name) that doesn't exist in the codebase today.
//
// The lesson: when in-tx dependents need a fresh registration, the
// simpler shape is two txs — commit the type-definition block first,
// let the subscription rebuild register the contribution, then open
// the dependent tx. Two undo entries instead of one, but the
// concurrency model stays trivial.
//
// UserTypesService deliberately does NOT mirror UserSchemasService's
// withProvisionalSchema. The extract-type flow uses two txs (see §7).
// If a future caller genuinely needs single-tx atomicity
// AND can prove single-caller-per-name semantics, a narrowly-scoped
// withProvisionalType can be added then, with documented contract.
// ──────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────
// 7. Extract type from a prototype — three composable primitives
//
// User mental model: pick a prototype block that has the property shape
// the user wants to canonize (a Task with `status` / `due` / `priority`
// set), invoke "Extract type", pick a name + property subset (+ optional
// per-property value constraint), confirm the candidate list, retag.
//
// The Roam-isa "promote referenced page" flow shipped as the original
// Phase 3 was deliberately dropped — it required the user to already
// have a tagging convention in place (the `isa::` reference). Property-
// shape extraction is the right primary surface; reference-based
// promotion can be added back later as a separate discovery wrapper if
// a real migration use case arrives.
//
// Three primitives, split deliberately (not bundled into a single
// orchestrator) because the candidate-confirmation step is interactive
// and the UI owns the loop:
//
//   1. createTypeBlock — materializes a fresh `block-type` block on the
//      Types page, awaits UserTypesService registration. Returns the
//      new id (== type id).
//   2. findCandidatesByPropertyShape — query for blocks whose
//      `properties_json` carries the requested subset of property names
//      (optionally constrained to specific values). Built on
//      `repo.queryBlocks`; no new index needed.
//   3. retagBlocks — apply a registered type to an explicit list of
//      block ids in one tx. Idempotent per row.
//
// The commit→registration bridge between createTypeBlock and retagBlocks
// still uses the §6 lesson (two txs, subscription rebuild bridges).
// ──────────────────────────────────────────────────────────────────────

export interface CreateTypeBlockArgs {
  /** Workspace the new type lives in (and where the Types page must
   *  already exist via getOrCreateTypesPage). */
  workspaceId: string
  /** Display label. Required non-empty — UserTypesService.tryBuildType
   *  silently drops empty-label blocks, which would surface as a
   *  registration timeout instead of a clear pre-tx error. */
  label: string
  /** Property-schema block ids the new type's panel section surfaces.
   *  Each is validated pre-tx + re-checked in-tx (same invariants
   *  tryBuildType applies at runtime). */
  propertySchemaIds: readonly string[]
  signal?: AbortSignal
  /** Bound on the commit→registration handoff. Default 10s. */
  registrationTimeoutMs?: number
}

export class TypeRegistrationTimeout extends Error {
  constructor(
    public readonly typeBlockId: string,
    public readonly typeLabel: string,
    public readonly timeoutMs: number,
  ) {
    super(
      `createTypeBlock: type-definition block for "${typeLabel}" was committed ` +
      `but did not appear in the runtime registry within ${timeoutMs}ms. ` +
      `Likely cause: UserTypesService.tryBuildType rejected the block ` +
      `(e.g. a referenced property-schema id doesn't resolve in the live ` +
      `registry, or the workspace bucket hasn't reset since the last switch).`,
    )
    this.name = 'TypeRegistrationTimeout'
  }
}

/** Materialize a fresh block-type block on the workspace's Types page
 *  + wait for `UserTypesService` to publish the contribution. Returns
 *  the new block id (== type id, per the block-id-as-type-id rule). */
export async function createTypeBlock(
  repo: Repo,
  userSchemas: UserSchemasService,
  args: CreateTypeBlockArgs,
): Promise<string> {
  args.signal?.throwIfAborted()

  const trimmedLabel = args.label.trim()
  if (trimmedLabel === '') {
    throw new Error(
      `createTypeBlock: label must be a non-empty string (got ${JSON.stringify(args.label)}). ` +
      `UserTypesService.tryBuildType silently drops a block-type block with an empty label.`,
    )
  }

  if (!repo.typesPageId) {
    throw new Error(
      `createTypeBlock: no Types page for workspace ${args.workspaceId}. ` +
      `Call getOrCreateTypesPage during workspace bootstrap.`,
    )
  }
  const typesPageId = repo.typesPageId

  // Pre-tx validation: each property-schema ref must survive every
  // invariant tryBuildType applies. Validating upfront surfaces the
  // failure pre-commit instead of as a registration timeout 10s
  // after the partial type is already persisted.
  for (const schemaId of args.propertySchemaIds) {
    const schemaBlock = await repo.load(schemaId)
    if (!schemaBlock) {
      throw new Error(
        `createTypeBlock: property-schema ref ${schemaId} doesn't resolve ` +
        `to a live block. Drop it before retrying.`,
      )
    }
    if (schemaBlock.workspaceId !== args.workspaceId) {
      throw new Error(
        `createTypeBlock: property-schema ref ${schemaId} is in workspace ` +
        `${schemaBlock.workspaceId} but the new type is in ${args.workspaceId}. ` +
        `Cross-workspace property-schema refs aren't supported.`,
      )
    }
    if (!hasBlockType(schemaBlock, PROPERTY_SCHEMA_TYPE)) {
      throw new Error(
        `createTypeBlock: ref ${schemaId} is not a property-schema block ` +
        `(missing the ${PROPERTY_SCHEMA_TYPE} type tag).`,
      )
    }
    const rawName = schemaBlock.properties[propertyNameProp.name]
    const name = typeof rawName === 'string' ? rawName : ''
    if (name.trim() === '') {
      throw new Error(
        `createTypeBlock: property-schema block ${schemaId} has empty ` +
        `${propertyNameProp.name}; tryBuildType would silently drop it.`,
      )
    }
    // Resolve by block id (same path tryBuildType uses at runtime),
    // not by name — name-only lookup would let a kernel schema with
    // the same name pass while the block-id lookup at runtime drops
    // the ref because UserSchemasService never published this id.
    const resolved = userSchemas.getSchemaForBlockId(schemaId)
    if (!resolved) {
      throw new Error(
        `createTypeBlock: property-schema block ${schemaId} ("${name}") isn't ` +
        `published by UserSchemasService — e.g. its preset isn't loaded, its ` +
        `config didn't validate, or the block hasn't synced yet. Fix the ` +
        `schema block before retrying.`,
      )
    }
  }

  args.signal?.throwIfAborted()

  const typeSnapshot: TypeRegistrySnapshot = repo.snapshotTypeRegistries()
  let newId = ''
  await repo.tx(async (tx: Tx) => {
    // In-tx re-check of every schema ref — closes the gap between
    // pre-tx reads and tx-open (a sync-applied delete could land in
    // that window).
    for (const schemaId of args.propertySchemaIds) {
      const row = await tx.get(schemaId)
      if (!row || row.deleted) {
        throw new Error(`createTypeBlock: schema block ${schemaId} no longer exists`)
      }
      if (row.workspaceId !== args.workspaceId) {
        throw new Error(`createTypeBlock: schema block ${schemaId} moved to a different workspace`)
      }
      if (!hasBlockType(row, PROPERTY_SCHEMA_TYPE)) {
        throw new Error(`createTypeBlock: schema block ${schemaId} no longer carries ${PROPERTY_SCHEMA_TYPE}`)
      }
    }

    // Materialize a fresh block under the Types page — the new id IS
    // the type id (block-id = type-id rule). The prototype the UI
    // extracted FROM is left untouched.
    newId = await tx.run(createChild, {parentId: typesPageId, content: trimmedLabel})
    await repo.addTypeInTx(tx, newId, BLOCK_TYPE_TYPE, {}, typeSnapshot)
    await repo.addTypeInTx(tx, newId, PAGE_TYPE, {}, typeSnapshot)
    await tx.setProperty(newId, blockTypeLabelProp, trimmedLabel)
    await tx.setProperty(newId, blockTypePropertiesProp, args.propertySchemaIds)
    // The type doubles as its `[[label]]` page: claim the label as an
    // alias so references resolve to THIS block (§3, block-id = type-id:
    // the id `[[Person]]` resolves to). The label is therefore
    // workspace-unique and this tx rejects (`alias.collision`) on a
    // duplicate; rename parity is self-maintaining afterwards via the
    // alias-sync same-tx processor (content → alias).
    await tx.setProperty(newId, aliasesProp, [trimmedLabel])
  }, {scope: ChangeScope.BlockDefault, description: `createTypeBlock ${trimmedLabel}`})

  await waitForTypeRegistrationBounded(
    repo,
    newId,
    trimmedLabel,
    args.signal,
    args.registrationTimeoutMs ?? 10_000,
  )

  return newId
}

export interface RetagBlocksArgs {
  typeId: string
  instanceIds: readonly string[]
  signal?: AbortSignal
}

/** Apply an already-registered type to every block in `instanceIds`
 *  in a single tx. Idempotent per row; silently skips ids that are
 *  missing or tombstoned. */
export async function retagBlocks(
  repo: Repo,
  args: RetagBlocksArgs,
): Promise<void> {
  args.signal?.throwIfAborted()
  if (!repo.types.has(args.typeId)) {
    throw new Error(`retagBlocks: type ${args.typeId} is not registered`)
  }
  if (args.instanceIds.length === 0) return

  await repo.tx(async (tx: Tx) => {
    const snapshotInTx = repo.snapshotTypeRegistries()
    if (!snapshotInTx.types.has(args.typeId)) {
      throw new Error(
        `retagBlocks: type ${args.typeId} was unregistered between caller ` +
        `check and tx open — likely a sync-applied delete of the ` +
        `type-definition block.`,
      )
    }
    for (const instanceId of args.instanceIds) {
      const row = await tx.get(instanceId)
      if (!row || row.deleted) continue
      await repo.addTypeInTx(tx, instanceId, args.typeId, {}, snapshotInTx)
    }
  }, {scope: ChangeScope.BlockDefault, description: `retagBlocks ${args.typeId}`})
}

export interface PropertyShapeFilter {
  name: string
  /** Optional equality filter; when omitted, any value is acceptable
   *  as long as the property is set. */
  value?: unknown
}

export interface FindCandidatesByPropertyShapeArgs {
  workspaceId: string
  shape: readonly PropertyShapeFilter[]
  /** Typical: the prototype block the user is extracting FROM. */
  exclude?: ReadonlyArray<string>
  /** Default 1000. */
  limit?: number
}

/** Query for blocks whose `properties_json` carries every name in
 *  `shape`, optionally constrained by per-property equality. Built
 *  on `repo.queryBlocks` with `{exists: true}` / scalar-equality
 *  where-operators — no new index. */
export async function findCandidatesByPropertyShape(
  repo: Repo,
  args: FindCandidatesByPropertyShapeArgs,
): Promise<readonly string[]> {
  if (args.shape.length === 0) return []
  const where: Record<string, unknown> = {}
  for (const filter of args.shape) {
    where[filter.name] = filter.value === undefined ? {exists: true} : filter.value
  }
  const rows = await repo.queryBlocks({workspaceId: args.workspaceId, where})
  const excluded = new Set(args.exclude ?? [])
  const limit = args.limit ?? 1000
  const out: string[] = []
  for (const row of rows) {
    if (excluded.has(row.id)) continue
    out.push(row.id)
    if (out.length >= limit) break
  }
  return out
}

/** Wait for UserTypesService's subscription to publish `typeId` into
 *  the typesFacet runtime bucket. Event-driven via `repo.onTypesChange`
 *  — fires when the rebuild step republishes after the subscription
 *  tick. Three exit paths: registration appears → resolve; signal
 *  aborts → reject with `signal.reason`; timeout elapses → reject
 *  with `TypeRegistrationTimeout`. Every exit path disposes the
 *  listener and clears the timer. */
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
    if (repo.types.has(typeId)) { settle(resolve); return }
    timerRef.handle = setTimeout(
      () => settle(() => reject(new TypeRegistrationTimeout(typeId, typeLabel, timeoutMs))),
      timeoutMs,
    )
    signal?.addEventListener('abort', onAbort)
    if (signal?.aborted) settle(() => reject(signal.reason))
  })
}

// ──────────────────────────────────────────────────────────────────────
// 8. Phasing (see §Phases in design.html)
//
// Phase 1: BLOCK_TYPE_TYPE + TYPES_PAGE_TYPE + UserTypesService + Types page bootstrap
// Phase 2: setup → same-tx processor migration + addedTypes/removedTypes helpers
// Phase 3: extract-type-from-prototype — createTypeBlock + retagBlocks +
//          findCandidatesByPropertyShape primitives, plus the multi-step
//          dialog UI the user invokes from any block.
// Phase 4 (optional): block-type:template + materializer + cycle guard
//
// Deferred: extends overrides (see design.html §What's deferred). The cut
// keeps v1 simple; adding the override mechanism is mechanical when a
// real consumer arrives.
// ──────────────────────────────────────────────────────────────────────

// Compile-only references to make this file fail if anything moves:
const _refs = {
  propertyNameProp,
  propertySchemasFacet,
  typesFacet,
  blockTypeKernelType,
  typesPageKernelType,
} as const
void _refs
