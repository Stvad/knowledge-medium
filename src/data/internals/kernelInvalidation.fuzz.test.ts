// @vitest-environment node
/**
 * Fuzz suite for `emitKernelInvalidations`
 * (src/data/internals/kernelInvalidation.ts:206-403) — differential
 * against a FROM-SCRATCH reference model of the REQUIRED (channel, key)
 * set, built from the documented channel semantics
 * (kernelInvalidation.ts:9-47) plus the explicit membership-transition
 * judgment call in the source comment (kernelInvalidation.ts:296-306).
 * See `src/test/fuzz.ts` for smoke/deep tier mechanics and
 * `docs/fuzzing.md` for conventions.
 *
 * ──── Why a REQUIRED-set / superset oracle, not an exact-match one ────
 *
 * `collectPluginInvalidationsFromSnapshots` (invalidation.ts:75-77) states
 * the contract explicitly: "over-firing an invalidation is a harmless
 * re-read; under-firing is the bug". So the property this suite checks is
 * `required(snapshot) ⊆ actual(snapshot)` — the model computes a MINIMUM
 * set that the documented contract demands, not a prediction of the exact
 * set `emitKernelInvalidations` produces. Building the model straight from
 * the diff logic (re-deriving each `if` in the target) would make the
 * property tautological — a copy of the implementation checked against
 * itself finds nothing. Instead this model is written independently from
 * the channel-semantics prose and the one documented judgment call, and
 * stays deliberately CONSERVATIVE wherever the prose doesn't pin down an
 * exact trigger condition (see the `refsOf`/duplicate-references case
 * below) — a model that under-requires can only make the property weaker,
 * never wrongly fail it, whereas over-requiring would produce false
 * "product bug" reports that are actually wrong-oracle bugs.
 *
 * ──── Judgment call encoded (kernelInvalidation.ts:296-306) ────
 *
 * On a liveness or workspace-changing transition, the code doesn't diff
 * old vs new — it treats it as "a departure from the old workspace and an
 * arrival in the new one so all per-axis indexed queries wake"
 * (kernelInvalidation.ts:297-298). Concretely: for whichever side (before/
 * after) is live, EVERY axis channel fires unconditionally for that side's
 * data — not gated on whether that axis's value differs from anything (the
 * departing/arriving side has no "other side" to diff against on this
 * path). The model's `emitAllAxesFor` below encodes exactly this.
 *
 * ──── Over-firing observed (informational — not asserted, since
 * over-firing is documented-harmless per invalidation.ts:75-77) ────
 *
 * - The transition path above is the single largest source: e.g.
 *   restoring a block whose `content` happens to already equal what it
 *   was before deletion still fires `kernel.content` + `typedBlocks.label`
 *   for it (kernelInvalidation.ts:289-292) — no value actually changed,
 *   but membership did, and the doc's judgment call chooses simplicity
 *   over precision there.
 * - A same-workspace live→live edit that touches only a non-tracked
 *   property (e.g. `count`) still walks and re-emits every reference
 *   entry's identity into `emittedRefTargets`/`emittedRefFields` — no,
 *   wait: that's gated on an actual before/after reference diff
 *   (kernelInvalidation.ts:368-399), so no over-fire there; the observed
 *   ones are on the `typedBlocks.refsOf` axis instead — see next point.
 * - `typedBlocks.refsOf` over-fires relative to this model whenever the
 *   reference list carries duplicate (id, sourceField) pairs whose COUNT
 *   changes without changing the identity SET (e.g. before
 *   `[{id:'t1'},{id:'t1'}]` → after `[{id:'t1'}]`): the target's
 *   `referenceSetChanged` (kernelInvalidation.ts:191-201) fires on a bare
 *   length mismatch even when the dedup'd sets are equal. This model uses
 *   plain set inequality (conservative — see `requiredInvalidations`'
 *   `refsOf` comment) and deliberately does NOT require the channel in
 *   that case, so it's an intentional gap, not a missed requirement.
 * - A same-object workspace move (both sides live, `workspaceId` differs,
 *   everything else identical) fires the FULL axis set for both the old
 *   and new workspace, even for axes with identical before/after values
 *   (e.g. `content` unchanged) — same transition-path over-fire as above,
 *   doubled because both sides are live.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams } from '@/test/fuzz'
import type { ChangeSnapshot } from '@/data/invalidation'
import {
  KERNEL_ALIASES_CHANNEL,
  KERNEL_CONTENT_CHANNEL,
  TYPED_BLOCKS_LABEL_CHANNEL,
  TYPED_BLOCKS_LIVE_CHANNEL,
  TYPED_BLOCKS_PROPERTY_CHANNEL,
  TYPED_BLOCKS_REFERENCE_CHANNEL,
  TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL,
  TYPED_BLOCKS_REFS_OF_CHANNEL,
  TYPED_BLOCKS_STRUCTURE_CHANNEL,
  TYPED_BLOCKS_TYPE_CHANNEL,
  kernelAliasesKey,
  kernelContentKey,
  typedBlocksLabelKey,
  typedBlocksLiveKey,
  typedBlocksPropertyKey,
  typedBlocksReferenceFieldKey,
  typedBlocksReferenceKey,
  typedBlocksRefsOfKey,
  typedBlocksStructureKey,
  typedBlocksTypeKey,
} from '@/data/invalidation'
import { emitKernelInvalidations } from './kernelInvalidation'

// ──── Generators ────
//
// Small closed pools everywhere so equality/overlap (same type, same
// alias, same reference target on both sides of a diff) is common —
// that's what exercises the "unchanged → no emit" / "changed → emit"
// branches, not just "always different, always emits".

const WORKSPACE_POOL = ['ws-1', 'ws-2'] as const
const ID_POOL = ['b1', 'b2', 'b3'] as const
const TYPE_POOL = ['note', 'task', 'page', 'event'] as const
const ALIAS_POOL = ['alpha', 'beta', ''] as const
const PROP_KEY_POOL = ['status', 'priority', 'count', 'tags', 'flag'] as const
const REF_ID_POOL = ['t1', 't2', 't3'] as const
const SOURCE_FIELD_POOL = ['rel', 'embed', ''] as const

// Occasional '' workspaceId exercises the falsy-workspace no-op guards
// (kernelInvalidation.ts:267, 314) — a real ChangeSnapshotSide always
// carries a real workspace id, so this is weighted low.
const workspaceIdArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom(...WORKSPACE_POOL) },
  { weight: 1, arbitrary: fc.constant('') },
)

const genericValueArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.string({ maxLength: 5 }),
  fc.integer({ min: -5, max: 5 }),
  fc.boolean(),
  fc.array(fc.string({ maxLength: 3 }), { maxLength: 2 }),
)

// Mostly well-formed string arrays, occasionally malformed (non-array,
// mixed-type array) — exercises `decodeTypes`'/the model's shared decode
// contract (kernelInvalidation.ts:104-111).
const typesValueArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.array(fc.constantFrom(...TYPE_POOL), { maxLength: 3 }),
  fc.array(fc.oneof(fc.constantFrom(...TYPE_POOL), fc.integer()), { maxLength: 3 }),
  fc.string({ maxLength: 4 }),
  fc.integer(),
)

const aliasValueArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.array(fc.constantFrom(...ALIAS_POOL), { maxLength: 3 }),
  fc.array(fc.oneof(fc.constantFrom(...ALIAS_POOL), fc.integer()), { maxLength: 3 }),
  fc.string({ maxLength: 4 }),
  fc.integer(),
)

type PropEntry = readonly [string, unknown]

const propEntryArb: fc.Arbitrary<PropEntry> = fc.oneof(
  fc.tuple(fc.constant('types'), typesValueArb),
  fc.tuple(fc.constant('alias'), aliasValueArb),
  fc.tuple(fc.constantFrom(...PROP_KEY_POOL), genericValueArb),
)

const propertiesArb: fc.Arbitrary<Record<string, unknown>> = fc
  .uniqueArray(propEntryArb, { maxLength: 6, selector: e => e[0] })
  .map(entries => Object.fromEntries(entries))

const referenceArb = fc.record({
  id: fc.constantFrom(...REF_ID_POOL),
  sourceField: fc.option(fc.constantFrom(...SOURCE_FIELD_POOL), { nil: undefined }),
})

const referencesArb = fc.uniqueArray(referenceArb, {
  maxLength: 4,
  selector: r => `${r.id} ${r.sourceField ?? ''}`,
})

interface Side {
  id?: string
  parentId: string | null
  workspaceId: string
  deleted: boolean
  content: string
  references: ReadonlyArray<{ id: string; sourceField?: string }>
  properties: Record<string, unknown>
}

const sideArb: fc.Arbitrary<Side> = fc.record({
  id: fc.option(fc.constantFrom(...ID_POOL), { nil: undefined }),
  parentId: fc.option(fc.constantFrom(...ID_POOL), { nil: null }),
  workspaceId: workspaceIdArb,
  deleted: fc.boolean(),
  content: fc.string({ maxLength: 8 }),
  references: referencesArb,
  properties: propertiesArb,
})

interface Snap {
  before: Side | null
  after: Side | null
}

// A real ChangeSnapshot always has at least one non-null side (it comes
// from a real row event); both-null is out of contract, so it's excluded
// rather than given a (vacuous) required-set of its own.
const snapshotArb: fc.Arbitrary<Snap> = fc
  .tuple(fc.option(sideArb, { nil: null }), fc.option(sideArb, { nil: null }))
  .filter(([before, after]) => before !== null || after !== null)
  .map(([before, after]) => ({ before, after }))

// Mirrors the real call site (kernelInvalidationRule.collectFromSnapshots,
// kernelInvalidation.ts:407-411): fallbackBlockId is normally the
// snapshot map's own id, occasionally absent to hit the no-blockId path.
const fallbackBlockIdArb: fc.Arbitrary<string | undefined> = fc.option(fc.constantFrom(...ID_POOL), {
  nil: undefined,
})

const caseArb = fc.record({
  snapshot: snapshotArb,
  fallbackBlockId: fallbackBlockIdArb,
})

// ──── Reference model ────

// JSON-array encoding avoids any risk of channel/key concatenation
// collisions (unlike a fixed-separator join, which could in principle
// coincide across two distinct (channel, key) pairs).
const encode = (channel: string, key: string): string => JSON.stringify([channel, key])

/** `properties.types` decode: array-of-strings only, non-string entries
 *  dropped, non-array → `[]` — mirrors kernelInvalidation.ts:104-111
 *  (`decodeTypes`). A value-normalization step the doc's `type` axis
 *  (kernelInvalidation.ts:14) is defined in terms of, not part of the
 *  diff DECISION logic itself. */
const modelTypes = (properties: Record<string, unknown>): string[] => {
  const raw = properties.types
  if (!Array.isArray(raw)) return []
  return raw.filter((t): t is string => typeof t === 'string')
}

/** `properties.alias` non-emptiness predicate — mirrors
 *  kernelInvalidation.ts:88-102 (`hasAlias`), including the documented
 *  empty-string-counts-as-present case (the `block_aliases` trigger
 *  indexes `''` too, per the comment there). */
const modelHasAlias = (properties: Record<string, unknown>): boolean => {
  const raw = properties.alias
  if (!Array.isArray(raw)) return false
  return raw.some(v => typeof v === 'string')
}

/** Identity of one outgoing reference edge for set-membership diffing —
 *  the same (target id, sourceField) pair kernelInvalidation.ts:188-189
 *  keys entries by. */
const refIdentity = (r: { id: string; sourceField?: string }): string => `${r.id} ${r.sourceField ?? ''}`

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

const setsEqual = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

/**
 * From-scratch model of the REQUIRED (channel, key) set — see the file
 * docblock for the overall "superset, not exact match" rationale and the
 * membership-transition judgment call this encodes.
 */
const requiredInvalidations = (snapshot: Snap, fallbackBlockId: string | undefined): Set<string> => {
  const required = new Set<string>()
  const add = (channel: string, key: string): void => {
    required.add(encode(channel, key))
  }

  const beforeLive = !!snapshot.before && !snapshot.before.deleted
  const afterLive = !!snapshot.after && !snapshot.after.deleted
  const blockId = snapshot.after?.id ?? snapshot.before?.id ?? fallbackBlockId

  // kernelInvalidation.ts:296-306 — membership transition: full-axis wake
  // for each side that's live, gated only by that side's own workspaceId
  // (kernelInvalidation.ts:267 `if (!workspaceId) return`) and, for the
  // per-block axes, blockId (kernelInvalidation.ts:181 `if (!blockId)
  // return`).
  const emitAllAxesFor = (side: Side): void => {
    const ws = side.workspaceId
    if (!ws) return
    add(TYPED_BLOCKS_LIVE_CHANNEL, typedBlocksLiveKey(ws))
    for (const t of modelTypes(side.properties)) add(TYPED_BLOCKS_TYPE_CHANNEL, typedBlocksTypeKey(ws, t))
    for (const name of Object.keys(side.properties)) {
      add(TYPED_BLOCKS_PROPERTY_CHANNEL, typedBlocksPropertyKey(ws, name))
    }
    for (const r of side.references) {
      add(TYPED_BLOCKS_REFERENCE_CHANNEL, typedBlocksReferenceKey(ws, r.id))
      add(TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL, typedBlocksReferenceFieldKey(ws, r.id, r.sourceField ?? ''))
    }
    add(KERNEL_CONTENT_CHANNEL, kernelContentKey(ws))
    if (blockId) {
      add(TYPED_BLOCKS_STRUCTURE_CHANNEL, typedBlocksStructureKey(ws, blockId))
      add(TYPED_BLOCKS_REFS_OF_CHANNEL, typedBlocksRefsOfKey(ws, blockId))
      add(TYPED_BLOCKS_LABEL_CHANNEL, typedBlocksLabelKey(ws, blockId))
    }
    if (modelHasAlias(side.properties)) add(KERNEL_ALIASES_CHANNEL, kernelAliasesKey(ws))
  }

  const isTransition =
    beforeLive !== afterLive ||
    (beforeLive && afterLive && snapshot.before!.workspaceId !== snapshot.after!.workspaceId)

  if (isTransition) {
    if (beforeLive && snapshot.before) emitAllAxesFor(snapshot.before)
    if (afterLive && snapshot.after) emitAllAxesFor(snapshot.after)
    return required
  }

  // Both dead (e.g. an update on an already-tombstoned row): nothing
  // observable to typed-blocks queries (kernelInvalidation.ts:308-310).
  if (!beforeLive || !afterLive) return required

  const before = snapshot.before!
  const after = snapshot.after!
  const ws = after.workspaceId
  if (!ws) return required

  // structure — kernelInvalidation.ts:18-19 ("parent/.../shape changed"),
  // decided at kernelInvalidation.ts:316-318.
  if (before.parentId !== after.parentId && blockId) {
    add(TYPED_BLOCKS_STRUCTURE_CHANNEL, typedBlocksStructureKey(ws, blockId))
  }

  // type — kernelInvalidation.ts:14, symmetric diff of the decoded type set.
  const beforeTypes = new Set(modelTypes(before.properties))
  const afterTypes = new Set(modelTypes(after.properties))
  for (const t of beforeTypes) if (!afterTypes.has(t)) add(TYPED_BLOCKS_TYPE_CHANNEL, typedBlocksTypeKey(ws, t))
  for (const t of afterTypes) if (!beforeTypes.has(t)) add(TYPED_BLOCKS_TYPE_CHANNEL, typedBlocksTypeKey(ws, t))

  // property + alias/label side effects — kernelInvalidation.ts:15
  // ("a property value changed"), :26-31 ("alias property differs"),
  // :23-24 ("content or alias changed" → label).
  const allNames = new Set([...Object.keys(before.properties), ...Object.keys(after.properties)])
  let aliasChanged = false
  for (const name of allNames) {
    if (!deepEqual(before.properties[name], after.properties[name])) {
      add(TYPED_BLOCKS_PROPERTY_CHANNEL, typedBlocksPropertyKey(ws, name))
      if (name === 'alias') aliasChanged = true
    }
  }
  if (aliasChanged) {
    add(KERNEL_ALIASES_CHANNEL, kernelAliasesKey(ws))
    if (blockId) add(TYPED_BLOCKS_LABEL_CHANNEL, typedBlocksLabelKey(ws, blockId))
  }

  // content — kernelInvalidation.ts:33-39.
  if (before.content !== after.content) {
    add(KERNEL_CONTENT_CHANNEL, kernelContentKey(ws))
    if (blockId) add(TYPED_BLOCKS_LABEL_CHANNEL, typedBlocksLabelKey(ws, blockId))
  }

  // reference / referenceField — kernelInvalidation.ts:16-17, sourceField
  // normalized to '' per kernelInvalidation.ts:158-165.
  const beforeRefIds = new Set(before.references.map(refIdentity))
  const afterRefIds = new Set(after.references.map(refIdentity))
  for (const r of before.references) {
    if (!afterRefIds.has(refIdentity(r))) {
      add(TYPED_BLOCKS_REFERENCE_CHANNEL, typedBlocksReferenceKey(ws, r.id))
      add(TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL, typedBlocksReferenceFieldKey(ws, r.id, r.sourceField ?? ''))
    }
  }
  for (const r of after.references) {
    if (!beforeRefIds.has(refIdentity(r))) {
      add(TYPED_BLOCKS_REFERENCE_CHANNEL, typedBlocksReferenceKey(ws, r.id))
      add(TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL, typedBlocksReferenceFieldKey(ws, r.id, r.sourceField ?? ''))
    }
  }

  // refsOf — kernelInvalidation.ts:20-21 ("outgoing reference set
  // changed"). CONSERVATIVE by design: plain dedup-set inequality is a
  // strict subset of the target's actual `referenceSetChanged`
  // (kernelInvalidation.ts:191-201), which also fires on a bare
  // duplicate-count length change with an unchanged identity set — see
  // the file docblock's "over-firing observed" note. Under-requiring here
  // is safe for a superset property; matching the target's exact
  // multiset semantics would just be re-deriving its diff logic.
  if (blockId && !setsEqual(beforeRefIds, afterRefIds)) {
    add(TYPED_BLOCKS_REFS_OF_CHANNEL, typedBlocksRefsOfKey(ws, blockId))
  }

  return required
}

// ──── Actual (target) ────

const collectActual = (snapshot: Snap, fallbackBlockId: string | undefined): Set<string> => {
  const actual = new Set<string>()
  emitKernelInvalidations(
    snapshot as ChangeSnapshot,
    (channel, key) => {
      actual.add(encode(channel, key))
    },
    fallbackBlockId,
  )
  return actual
}

// ──── Properties ────

describe('emitKernelInvalidations — differential vs a from-scratch reference model', () => {
  it('emits a superset of the documented-required (channel, key) set (kernelInvalidation.ts:9-47, invalidation.ts:75-77 over-firing-harmless contract)', () => {
    fc.assert(
      fc.property(caseArb, ({ snapshot, fallbackBlockId }) => {
        const required = requiredInvalidations(snapshot, fallbackBlockId)
        const actual = collectActual(snapshot, fallbackBlockId)
        for (const req of required) {
          expect(actual.has(req)).toBe(true)
        }
      }),
      fuzzParams(400),
    )
  })

  it('is deterministic: the same (snapshot, fallbackBlockId) always emits the same set', () => {
    fc.assert(
      fc.property(caseArb, ({ snapshot, fallbackBlockId }) => {
        const first = collectActual(snapshot, fallbackBlockId)
        const second = collectActual(snapshot, fallbackBlockId)
        expect(setsEqual(first, second)).toBe(true)
      }),
      fuzzParams(300),
    )
  })

  it('is total: never throws, for any generated snapshot shape (incl. malformed types/alias property values)', () => {
    fc.assert(
      fc.property(caseArb, ({ snapshot, fallbackBlockId }) => {
        expect(() => collectActual(snapshot, fallbackBlockId)).not.toThrow()
      }),
      fuzzParams(300),
    )
  })
})
