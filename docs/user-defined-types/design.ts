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
import {propertyNameProp} from '@/data/properties'
import {PAGE_TYPE} from '@/data/blockTypes'
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

/** Optional. Present ⇒ this block-type is an override of an existing
 *  type (kernel or user-defined) rather than a fresh definition. Value
 *  is the target type id (kernel semantic id like `'daily-note'`, or a
 *  block id for user-defined). See §4 merge rules. */
export const blockTypeExtendsProp = defineProperty<string>('block-type:extends', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

/** Optional. RefList of blocks whose subtree is materialized under a
 *  new instance when this type is first added to a block (the
 *  `setup`-replacement path; see §5). Descendants-only semantics:
 *  the referenced root is NOT cloned, only its children are attached
 *  as children of the new instance. Cycle detection on this field is
 *  enforced by a same-tx processor (§5b). */
export const blockTypeTemplateProp = defineProperty<readonly string[]>('block-type:template', {
  codec: codecs.refList({}),
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
    blockTypeExtendsProp,
    blockTypeTemplateProp,
  ],
})

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

  constructor(private readonly repo: Repo) {}

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
   *  Returns null + diagnostic when the label is empty (and it's NOT
   *  an extends-override; overrides may legitimately omit label since
   *  the kernel value wins). */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private tryBuildType(
    block: Block,
    _schemas: ReadonlyMap<string, AnyPropertySchema>,
  ): TypeContribution | TypeOverride | null {
    // ... read blockTypeLabelProp / blockTypeExtendsProp / etc.
    // ... resolve blockTypePropertiesProp refList → schema name → merged schemas map ...
    // ... return TypeContribution (full) or TypeOverride (extends-set, see §4)
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
// 4. Override merge (extends)
//
// When a block-type block has blockTypeExtendsProp set, its
// contribution is folded INTO the existing target rather than
// replacing it. The merge happens in the rebuild step that already
// populates the merged `_types` map on Repo (the same site §1a-public
// in type-system.md describes for property schemas).
// ──────────────────────────────────────────────────────────────────────

export interface TypeOverride {
  readonly kind: 'override'
  /** The type id being extended — kernel semantic id or user block id. */
  readonly target: string
  /** undefined ⇒ inherit kernel/base value (`label || undefined`
   *  in tryBuildType so an empty string doesn't clobber the kernel). */
  readonly label?: string
  readonly description?: string
  /** Always-unioned with the target's properties[]; dedup by object identity. */
  readonly properties?: ReadonlyArray<AnyPropertySchema>
  // Template membership is intentionally NOT part of the override
  // merge. `block-type:template` lives on the source block; the
  // materializer (§5) resolves at runtime by reading the type's
  // source block(s) directly via UserTypesService. An earlier draft
  // declared `template` on TypeOverride and noted "always-unioned"
  // but didn't implement the union (because TypeContribution has no
  // template field). Dropping the field avoids the silent-mismatch
  // footgun the design-review caught: an override that declares a
  // template now stores it on its own block-type:template property,
  // and the materializer picks it up at type-add time when v1's
  // single-source-block model is widened to multi-source.
}

/** Fold overrides into base contributions. Called inside the runtime
 *  rebuild step that already populates `_types` on Repo, AFTER
 *  typesFacet.combine has produced the base map. Overrides that
 *  target an unknown id are dropped with a logged diagnostic. */
export function mergeTypeOverrides(
  base: ReadonlyMap<string, TypeContribution>,
  overrides: readonly TypeOverride[],
): Map<string, TypeContribution> {
  const out = new Map(base)
  for (const ov of overrides) {
    const target = out.get(ov.target)
    if (!target) {
      console.warn(`[mergeTypeOverrides] override targets unknown type ${JSON.stringify(ov.target)}; dropping`)
      continue
    }
    // Behavioral fields (setup) are kernel-only. The override merge
    // is metadata-only: properties[] union, label/description
    // user-wins-if-set. setup stays whatever the base contribution
    // declared. Template membership is NOT merged here — it lives on
    // the source block and is resolved at materialization time
    // (§5, see comment on TypeOverride).
    out.set(ov.target, {
      ...target,
      label: ov.label ?? target.label,
      description: ov.description ?? target.description,
      properties: dedupBy(
        [...(target.properties ?? []), ...(ov.properties ?? [])],
        s => s.name,
      ),
    })
  }
  return out
}

function dedupBy<T, K>(xs: readonly T[], key: (x: T) => K): T[] {
  const seen = new Set<K>()
  const out: T[] = []
  for (const x of xs) {
    const k = key(x)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(x)
  }
  return out
}

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
}

export async function promoteToType(
  repo: Repo,
  userTypes: UserTypesService,
  args: PromoteToTypeArgs,
): Promise<void> {
  // Phase 1 (tx A): turn the target page into a block-type block.
  //   - Read workspaceId from the target before opening the tx (avoids
  //     queryActiveWorkspace silent fallback per the merged PR #48).
  //   - In-tx existence guard: addTypeInTx is strict-by-default per
  //     merged PR #49 — throws BlockNotFoundForTypeError if the target
  //     was deleted concurrently between the pre-tx load() and tx-open.
  const target = await repo.load(args.targetBlockId)
  if (!target) {
    throw new Error(`promoteToType: target ${args.targetBlockId} not found`)
  }
  const workspaceId = target.workspaceId

  const typeSnapshot: TypeRegistrySnapshot = repo.snapshotTypeRegistries()
  await repo.tx(async (tx: Tx) => {
    await repo.addTypeInTx(tx, args.targetBlockId, BLOCK_TYPE_TYPE, {
      [blockTypeLabelProp.name]: args.label,
      [blockTypePropertiesProp.name]: args.propertySchemaIds,
    }, typeSnapshot)
    // The page also gets PAGE_TYPE so it stays navigable as a page —
    // matches the "type flow" pattern (properties page / readwise
    // root / plugin state / alias user pages).
    await repo.addTypeInTx(tx, args.targetBlockId, PAGE_TYPE, {}, typeSnapshot)
  }, {scope: ChangeScope.BlockDefault, description: `promoteToType:create ${args.label}`})

  // The subscription on `block-type` blocks fires between txs and
  // registers args.targetBlockId in the user-data bucket on typesFacet.
  // The next snapshotTypeRegistries() sees it. No synchronous-append
  // dance — that was the withProvisional approach, deliberately
  // dropped (§6).
  await waitForTypeRegistration(repo, args.targetBlockId)

  // Phase 2 (tx B): query candidates outside the tx (avoids the
  // bare-DB-read-inside-tx deadlock documented in
  // tasks/processor-tx-deadlock.md), retag each in-tx with strict
  // existence guards on every row.
  const candidates = await repo.queryBlocks({
    workspaceId,
    referencedBy: {id: args.targetBlockId, sourceField: 'roam:isa'},
  })

  const snapshot2 = repo.snapshotTypeRegistries()
  await repo.tx(async (tx: Tx) => {
    for (const candidate of candidates) {
      // tx.get re-check closes the TOCTOU window: the candidate may
      // have been deleted or had its roam:isa rewritten between the
      // pre-tx query and the tx open.
      const row = await tx.get(candidate.id)
      if (!row) continue
      const isaRefs = row.properties['roam:isa']
      if (!Array.isArray(isaRefs) || !isaRefs.includes(args.targetBlockId)) continue
      await repo.addTypeInTx(tx, candidate.id, args.targetBlockId, {}, snapshot2)
    }
    if (args.rewriteIsaReferences) {
      // ... rewrite roam:isa per instance, dropping the promoted alias
    }
  }, {scope: ChangeScope.BlockDefault, description: `promoteToType:retag ${args.label}`})
}

/** Wait for UserTypesService's subscription to publish `typeId` into
 *  the typesFacet runtime bucket. Event-driven via `repo.onTypesChange`
 *  (added in Phase 1, symmetric to the existing
 *  `onPropertySchemasChange` / `onValuePresetsChange`). No polling, no
 *  hard-coded timeout: the listener fires when the rebuild step
 *  republishes after the subscription tick, which can be delayed by
 *  event-loop load or inactive-tab throttling without harming
 *  correctness.
 *
 *  Note on the deferred follow-up: an event-loop deadline can still be
 *  added as a sanity bound (e.g. 30s, AbortSignal-aware) once a real
 *  caller surfaces a "user-cancelled the promotion" UI path. v1 ships
 *  without one — a stuck registration here means tx A wrote a
 *  block-type block that doesn't parse into a valid contribution,
 *  which is a separate bug to surface via diagnostic logs in
 *  UserTypesService.tryBuildType.
 *
 *  Declared on Repo as part of Phase 1 (alongside onPropertySchemasChange):
 *
 *    onTypesChange(listener: () => void): () => void
 *
 *  Fires when the rebuild step republishes the merged _types map. */
async function waitForTypeRegistration(
  repo: Repo,
  typeId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (repo.types.has(typeId)) return
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('promoteToType: aborted'))
      return
    }
    const dispose = repo.onTypesChange(() => {
      if (repo.types.has(typeId)) {
        dispose()
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
    })
    const onAbort = () => {
      dispose()
      signal?.removeEventListener('abort', onAbort)
      reject(new Error('promoteToType: aborted'))
    }
    signal?.addEventListener('abort', onAbort)
  })
}

// ──────────────────────────────────────────────────────────────────────
// 8. Phasing (see §Phases in design.html)
//
// Phase 1: BLOCK_TYPE_TYPE + TYPES_PAGE_TYPE + UserTypesService + Types page bootstrap
// Phase 2: extends overrides (mergeTypeOverrides folded into _types rebuild step)
// Phase 3: setup → same-tx processor migration + addedTypes/removedTypes helpers
// Phase 4: Roam-isa promoteToType
// Phase 5 (optional): block-type:template + materializer + cycle guard
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
