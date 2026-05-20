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
//   yarn tsc --noEmit --project docs/tsconfig.json

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
import type {ChangedRow} from '@/data/api/processor'
import {
  ChangeScope,
  codecs,
  defineBlockType,
  defineProperty,
  defineSameTxProcessor,
} from '@/data/api'
import {hasBlockType, propertyNameProp} from '@/data/properties'
import {PAGE_TYPE, PROPERTY_SCHEMA_TYPE} from '@/data/blockTypes'
import {propertySchemasFacet, typesFacet} from '@/data/facets'

// ──────────────────────────────────────────────────────────────────────
// Phase 1 API addition: Repo.onTypesChange
//
// Symmetric to the existing `onPropertySchemasChange` /
// `onValuePresetsChange` listeners (src/data/repo.ts:1402, :1415).
// Fires when the rebuild step republishes the merged `_types` map —
// after a typesFacet contribution change (e.g. UserTypesService's
// setRuntimeContributions publish lands and the step re-runs).
//
// Used by the Roam-isa promotion flow's `waitForTypeRegistration`
// helper to bridge Phase A (commit type-definition block) and Phase B
// (retag instances) without polling.
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
// before opening the dependent tx (see §7 Roam-isa adoption).
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
//   - Roam-isa adoption is mechanical: `roam:isa = [[Person]]` already
//     refs the Person block by id, so promotion just appends that id
//     to typesProp on each instance (see §7).
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

/** Delta helpers added to src/data/properties.ts (or equivalent).
 *  Null-safe on both ends — hard-deletes have row.after=null,
 *  inserts have row.before=null. */
export const addedTypes = (_row: ChangedRow): readonly string[] => []
export const removedTypes = (_row: ChangedRow): readonly string[] => []

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
// withProvisionalSchema. The Roam-isa adoption flow uses two txs
// (see §7). If a future caller genuinely needs single-tx atomicity
// AND can prove single-caller-per-name semantics, a narrowly-scoped
// withProvisionalType can be added then, with documented contract.
// ──────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────
// 7. Roam-isa adoption — two-tx flow
//
// Promote a Roam-isa target page (e.g. the [[Person]] page that's
// referenced by N blocks via roam:isa) into a user-defined type AND
// retag the referencing blocks.
//
// Two-tx flow (see §6 lesson): the subscription rebuild bridges the
// txs by registering the new type into the runtime bucket between
// them. No appendUserType / withProvisionalType primitive needed.
// ──────────────────────────────────────────────────────────────────────

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
   *  the caller can re-run `promoteToType` to finish retagging (the
   *  subscription will have registered the type by then, so the second
   *  run skips the wait and goes straight to Phase B). */
  signal?: AbortSignal
  /** Sanity bound on the Phase-A→Phase-B handoff. If the subscription
   *  doesn't register the new type within this window, throw a clear
   *  PromotionRegistrationTimeout so the caller can surface a recovery
   *  prompt instead of hanging indefinitely. Default 10s — long enough
   *  to absorb event-loop load / inactive-tab throttling spikes, short
   *  enough that a genuine "the type-definition block didn't parse"
   *  bug surfaces within an interactive UI window. */
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

/** Thrown by Phase B's in-tx guard when the target type is no longer
 *  in the live registry at the moment the retag tx opens. The
 *  realistic trigger is a sync-applied delete of the type-definition
 *  block between Phase A's commit and Phase B's tx-open that
 *  UserTypesService reacted to by dropping the user-data contribution.
 *  Distinct from PromotionRegistrationTimeout (which fires before
 *  Phase B's tx opens) so callers can branch on the recovery path:
 *  for this case the type was deleted from another device, so retry
 *  with the same args would just re-trigger the same race; the
 *  surface to the user is "the type was deleted while promotion was
 *  in progress; verify with the other device." */
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
      `writing any retag. Verify whether the type-definition block should ` +
      `still exist before retrying.`,
    )
    this.name = 'PromotionTypeUnregistered'
  }
}

export async function promoteToType(
  repo: Repo,
  userTypes: UserTypesService,
  userSchemas: UserSchemasService,
  args: PromoteToTypeArgs,
): Promise<void> {
  // Preflight: if the caller's signal is already aborted, return before
  // touching the DB. waitForTypeRegistrationBounded handles abort during
  // the Phase A→B wait, but doesn't help if abort happened before Phase
  // A wrote anything — without this guard, an already-aborted call still
  // commits the type-definition block and then throws, leaving an
  // unexpected partial mutation despite cancellation.
  args.signal?.throwIfAborted()

  // Pre-tx validation — fail fast on inputs that UserTypesService's
  // tryBuildType will silently reject, before Phase A writes anything.
  // Without this, a blank label (etc.) commits a block-type block,
  // tryBuildType drops it, and Phase B's bounded wait surfaces
  // PromotionRegistrationTimeout 10s later — a half-promotion the
  // caller has to clean up manually. Validating upfront keeps the
  // failure pre-commit so there's nothing to clean up.
  const trimmedLabel = args.label.trim()
  if (trimmedLabel === '') {
    throw new Error(
      `promoteToType: label must be a non-empty string (got ${JSON.stringify(args.label)}). ` +
      `UserTypesService.tryBuildType would silently skip a block-type block with an empty label, ` +
      `so committing one would leave a half-promotion.`,
    )
  }
  // Load the target first so workspaceId is available for cross-workspace
  // checks below.
  const target = await repo.load(args.targetBlockId)
  if (!target) {
    throw new Error(`promoteToType: target ${args.targetBlockId} not found`)
  }
  if (target.deleted) {
    throw new Error(`promoteToType: target ${args.targetBlockId} is tombstoned`)
  }
  const workspaceId = target.workspaceId

  // propertySchemaIds: every ref must survive the full set of invariants
  // that UserTypesService.tryBuildType applies. tryBuildType silently
  // drops a ref that fails any of these checks, which would leave the
  // promoted type with missing panel slots — instances retag fine but
  // the property panel surfaces nothing. The pre-tx validation enforces
  // each invariant explicitly so the failure is loud and pre-commit:
  //
  //   - block exists and isn't tombstoned
  //   - block carries the `property-schema` type tag (a plain block
  //     wouldn't be a property-schema even if it had a propertyName)
  //   - block is in the same workspace as the promotion target (refs
  //     across workspaces would deference to nothing at materialization)
  //   - the schema's name is non-empty (tryBuildType drops empty-name
  //     blocks via UserSchemasService's same diagnostic path)
  //   - the resolved name is registered in the merged propertySchemas
  //     map (e.g. user-data schema hasn't been published yet because
  //     its preset isn't loaded, or a typo'd kernel name)
  const mergedSchemas = repo.propertySchemas
  for (const schemaId of args.propertySchemaIds) {
    const schemaBlock = await repo.load(schemaId)
    if (!schemaBlock || schemaBlock.deleted) {
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
    const name = schemaBlock.properties[propertyNameProp.name]
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error(
        `promoteToType: property-schema block ${schemaId} has empty ` +
        `${propertyNameProp.name}; tryBuildType would silently drop it.`,
      )
    }
    // Resolve by block id, not by name. tryBuildType uses
    // userSchemas.getSchemaForBlockId(refId) — checking
    // mergedSchemas.has(name) would let a name-match-only ref pass
    // (e.g. a kernel schema with the same name as a user-defined
    // one whose block is malformed/unpublished). The name-by-name
    // check would say "registered" while the block-id lookup at
    // runtime would silently drop the ref because UserSchemasService
    // never published a contribution mapped to THIS block id.
    // Validating via the same path tryBuildType uses keeps the
    // preflight in lockstep with runtime resolution.
    const resolved = userSchemas.getSchemaForBlockId(schemaId)
    if (!resolved) {
      throw new Error(
        `promoteToType: property-schema block ${schemaId} ("${name}") isn't ` +
        `published by UserSchemasService — e.g. its preset isn't loaded, its ` +
        `config didn't validate, or the block hasn't synced yet. Fix the ` +
        `schema block before retrying.`,
      )
    }
  }

  // Re-check abort after the async validation reads — if the caller
  // cancelled during schema-resolution awaits we still want to bail
  // before committing anything.
  args.signal?.throwIfAborted()

  // Phase A (tx A): turn the target page into a block-type block.
  //   - In-tx existence guard: addTypeInTx is strict-by-default per
  //     merged PR #49 — throws BlockNotFoundForTypeError if the target
  //     was deleted concurrently between the pre-tx load() and tx-open.

  const typeSnapshot: TypeRegistrySnapshot = repo.snapshotTypeRegistries()
  await repo.tx(async (tx: Tx) => {
    // In-tx re-check of every schema ref. Mirrors the target's
    // strict-addTypeInTx existence guard but for the schema refs:
    // sync-applied writes between the preflight loop and tx-open can
    // delete a schema block, move it to another workspace, or strip
    // its property-schema type tag. Without re-checking, Phase A
    // would commit block-type:properties referencing a now-stale
    // schema id; tryBuildType would silently drop it at runtime,
    // leaving the promoted type with missing panel slots. tx.get is
    // cheap and same-tick (no interleaving possible during this
    // synchronous body).
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

    // Tag with BLOCK_TYPE_TYPE (idempotent on retry; addTypeInTx
    // no-ops when the type is already present).
    await repo.addTypeInTx(tx, args.targetBlockId, BLOCK_TYPE_TYPE, {}, typeSnapshot)
    // The page also gets PAGE_TYPE so it stays navigable as a page —
    // matches the "type flow" pattern (properties page / readwise
    // root / plugin state / alias user pages).
    await repo.addTypeInTx(tx, args.targetBlockId, PAGE_TYPE, {}, typeSnapshot)
    // Set the type's metadata explicitly with tx.setProperty rather
    // than via addTypeInTx's initialValues. initialValues is
    // init-if-missing (per type-system.md §3a) — on a retry with a
    // corrected label or different property set, the existing
    // values would silently persist and the retry would never
    // repair the type. setProperty unconditionally overwrites, which
    // is what every retry actually wants.
    await tx.setProperty(args.targetBlockId, blockTypeLabelProp, trimmedLabel)
    await tx.setProperty(args.targetBlockId, blockTypePropertiesProp, args.propertySchemaIds)
  }, {scope: ChangeScope.BlockDefault, description: `promoteToType:create ${trimmedLabel}`})

  // The subscription on `block-type` blocks fires between txs and
  // registers args.targetBlockId in the user-data bucket on typesFacet.
  // The next snapshotTypeRegistries() sees it. No synchronous-append
  // dance — that was the withProvisional approach, deliberately
  // dropped (§6).
  //
  // Bounded wait: if the subscription doesn't fire within the timeout
  // (real cause: tryBuildType returned null, e.g. the block-type block
  // failed to parse against current presets/schemas), surface
  // PromotionRegistrationTimeout with a clear recovery message rather
  // than hanging on the unbounded wait. The caller's AbortSignal
  // composes with the internal timeout.
  await waitForTypeRegistrationBounded(
    repo,
    args.targetBlockId,
    trimmedLabel,
    args.signal,
    args.registrationTimeoutMs ?? 10_000,
  )

  // Phase B (tx B): query candidates outside the tx (avoids the
  // bare-DB-read-inside-tx deadlock documented in
  // tasks/processor-tx-deadlock.md), retag each in-tx with strict
  // existence guards on every row.
  args.signal?.throwIfAborted()
  const candidates = await repo.queryBlocks({
    workspaceId,
    referencedBy: {id: args.targetBlockId, sourceField: 'roam:isa'},
  })
  args.signal?.throwIfAborted()

  await repo.tx(async (tx: Tx) => {
    // Capture the registry snapshot INSIDE the tx body, not before.
    // Sync-applied writes between Phase A and Phase B could in
    // principle delete the type-definition block on another device,
    // which UserTypesService would react to by dropping the contribution
    // from the user-data bucket. A pre-tx snapshot would still carry
    // the type and pass addTypeInTx's existence check, then write
    // orphan ids into instance block:types. Capturing inside the tx
    // narrows the staleness window to a single event-loop tick (no
    // other writer can interleave during the synchronous tx body).
    const snapshotInTx = repo.snapshotTypeRegistries()

    // Belt-and-suspenders: even with the in-tx snapshot, sanity-check
    // the target is still registered before fanning out tags. The
    // realistic cause for this firing is a sync-applied delete of the
    // type-definition block between Phase A and Phase B that
    // UserTypesService reacted to by dropping the contribution. The
    // tx body's first read settles whether the registry still has the
    // type; if not, abort the retag rather than write orphan ids.
    if (!snapshotInTx.types.has(args.targetBlockId)) {
      throw new PromotionTypeUnregistered(args.targetBlockId, trimmedLabel)
    }

    for (const candidate of candidates) {
      // tx.get re-check closes the TOCTOU window: the candidate may
      // have been deleted or had its roam:isa rewritten between the
      // pre-tx query and the tx open. (tx.get returns tombstoned
      // rows as non-null, so check row.deleted too — a soft-deleted
      // candidate that gets restored later shouldn't carry the
      // promoted type id retroactively.)
      const row = await tx.get(candidate.id)
      if (!row || row.deleted) continue
      const isaRefs = row.properties['roam:isa']
      if (!Array.isArray(isaRefs) || !isaRefs.includes(args.targetBlockId)) continue
      await repo.addTypeInTx(tx, candidate.id, args.targetBlockId, {}, snapshotInTx)
    }
    if (args.rewriteIsaReferences) {
      // ... rewrite roam:isa per instance, dropping the promoted alias
    }
  }, {scope: ChangeScope.BlockDefault, description: `promoteToType:retag ${trimmedLabel}`})
}

/** Wait for UserTypesService's subscription to publish `typeId` into
 *  the typesFacet runtime bucket. Event-driven via `repo.onTypesChange`
 *  (added in Phase 1, symmetric to the existing
 *  `onPropertySchemasChange` / `onValuePresetsChange`). The listener
 *  fires when the rebuild step republishes after the subscription
 *  tick, which can be delayed by event-loop load or inactive-tab
 *  throttling without harming correctness.
 *
 *  Three exit paths:
 *  1. Registration appears → resolve.
 *  2. Caller aborts via signal → reject with the abort reason.
 *  3. Timeout elapses → reject with PromotionRegistrationTimeout
 *     (the type-definition block committed but tryBuildType is rejecting
 *     it, e.g. because a referenced property-schema id doesn't resolve).
 *     The error message instructs the caller's recovery path (re-run
 *     promoteToType once the underlying issue is fixed; the second run
 *     skips Phase A and goes straight to Phase B).
 *
 *  Cleanup invariant: every exit path disposes the onTypesChange
 *  listener and clears the timer so a leaked listener can't accumulate
 *  across retries.
 *
 *  Declared on Repo as part of Phase 1 (alongside onPropertySchemasChange):
 *
 *    onTypesChange(listener: () => void): () => void
 *
 *  Fires when the rebuild step republishes the merged _types map. */
async function waitForTypeRegistrationBounded(
  repo: Repo,
  typeId: string,
  typeLabel: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  if (repo.types.has(typeId)) return
  // Use signal.reason (standard AbortSignal API) so callers that pass
  // a typed reason (DOMException, custom error class) get their typed
  // value back instead of an opaque "promoteToType: aborted" string.
  // throwIfAborted at the call sites uses the same convention.
  if (signal?.aborted) throw signal.reason

  await new Promise<void>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const dispose = repo.onTypesChange(() => {
      if (repo.types.has(typeId)) settle(resolve)
    })
    const onAbort = () => settle(() => reject(signal!.reason))
    const settle = (cb: () => void) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      dispose()
      signal?.removeEventListener('abort', onAbort)
      cb()
    }
    // Re-check AFTER attaching the listener. The registration can
    // land in the gap between the early-return check at the top and
    // the dispose-assignment above; if it does, no future
    // onTypesChange event fires for it and we'd hang until timeout.
    // Checking now closes the race — if the type is already there,
    // settle immediately; if not, the listener catches the next
    // event.
    if (repo.types.has(typeId)) {
      settle(resolve)
      return
    }
    timer = setTimeout(
      () => settle(() => reject(new PromotionRegistrationTimeout(typeId, typeLabel, timeoutMs))),
      timeoutMs,
    )
    signal?.addEventListener('abort', onAbort)
    // Re-check abort AFTER attaching the listener — same race shape
    // as the type-registration check above. If signal.aborted flipped
    // true in the window between the top-of-function check and the
    // addEventListener call, the 'abort' event already fired and our
    // listener missed it. Without this re-check we'd wait until the
    // 10s timeout (or resolve on a real registration) despite the
    // caller having cancelled. Re-checking now closes the race; if
    // already aborted, settle synchronously.
    if (signal?.aborted) settle(() => reject(signal.reason))
  })
}

// ──────────────────────────────────────────────────────────────────────
// 8. Phasing (see §Phases in design.html)
//
// Phase 1: BLOCK_TYPE_TYPE + TYPES_PAGE_TYPE + UserTypesService + Types page bootstrap
// Phase 2: setup → same-tx processor migration + addedTypes/removedTypes helpers
// Phase 3: Roam-isa promoteToType
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
