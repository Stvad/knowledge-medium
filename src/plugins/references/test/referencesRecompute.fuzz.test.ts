// @vitest-environment node
/**
 * Stateful fuzz suite for the references pipeline — the incident class
 * that once silently stripped ~10k SRS property backlinks. See
 * `src/test/fuzz.ts` for smoke/deep tier mechanics.
 *
 * Random sequences of content edits (with `[[alias]]` / `((uuid))` /
 * `!((uuid))` / `[label](((uuid)))` marks), ref-typed property writes,
 * alias renames, deletes/restores, and merges run against a repo with
 * the REAL references + daily-notes extensions registered (the kernel
 * fuzzer in `repoMutators.fuzz.test.ts` deliberately runs kernel-only,
 * so `references.parseReferences`, the rename rewriter, the same-tx
 * merge-retarget/inline-deleted processors, and orphan-alias cleanup
 * never execute there — this suite is where they get fuzzed).
 *
 * Oracle: ops run in fc-generated batches of 1-3 (so a processor plan
 * can still be in flight when the next op in the batch lands — the
 * mid-plan-interleaving shape; see caseArb's docblock); after each
 * batch the processor pipeline is drained (`flush` — the fake-timer +
 * awaitReprojections + awaitProcessors pattern from
 * referencesProcessor.test.ts), then the FULL consistency audit must
 * report zero anomalies. That includes the deep checks this exists for
 * (audit.ts):
 *  - `content_link_recompute` — re-parse every live block's content
 *    with the app parser and diff against stored content refs
 *    (stripped/stale detection, audit.ts:496)
 *  - `property_ref_projection` — recompute expected property refs via
 *    `projectPropertyReferences` and diff stored (audit.ts:375)
 *  - `references_index_mirror` + the other lean checks
 * `dangling_refs` reports status 'info' by design (audit.ts:339) —
 * refs to tombstoned targets are legal and expected here.
 *
 * The pipeline's own coherence contracts make the post-flush fixpoint
 * a sound oracle, not an aspiration:
 *  - parseReferences recomputes content refs authoritatively and
 *    retains absent-schema property refs (reconcileDerived's `retain:
 *    isRetainableAbsentRef`, referencesProcessor.ts:217-222)
 *  - delete inlines `((id))` marks in referrers same-tx
 *    (inlineDeletedBlockRefsProcessor.ts), merge retargets refs AND
 *    rewrites content marks same-tx (mergeRetargetProcessor.ts), and
 *    the rename processor rewrites referrers' wikilinks — each is
 *    specified to leave content and references agreeing.
 *
 * Orphan-alias cleanup (`tx.afterCommit(..., {delayMs: 4000})`,
 * referencesProcessor.ts:371) is exercised deterministically: fake
 * timers per case, an `advanceTime` op (and the end-of-sequence flush)
 * advances past the delay.
 *
 * Out of scope, deliberately:
 *  - undo/redo oracles — processor txs run under ChangeScope.References
 *    with their own undo bucket; the kernel suite owns undo round-trips.
 *  - the retain-on-absent-schema path — needs mid-case schema swaps
 *    (repo.setFacetRuntime); covered by referencesProcessor.test.ts
 *    examples instead.
 *
 * Determinism: ids come from a UUID-shaped counter (the block-ref
 * parser only recognises UUIDv4-shaped ids, referenceParser.ts:44);
 * alias-target / daily-note ids are deterministic seat probes; order-key
 * jitter is pinned via a seeded LCG over Math.random. Processor-minted
 * ids (alias seats, daily-note targets) are folded into the op-target
 * pool after each flush via a SQL scan (`collectMintedIds`) rather than
 * derived by hand — the scan result is itself a deterministic function
 * of the ops + seed replayed so far, so shrinking/replay stay exact.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout, statefulFuzzGuard } from '@/test/fuzz'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { assertLegalKernelRejection, pick, pickNonRoot } from '@/data/test/fuzzKernelHarness'
import {
  ChangeScope,
  codecs,
  defineProperty,
} from '@/data/api'
import { aliasesProp } from '@/data/properties'
import { propertySchemasFacet } from '@/data/facets.js'
import { computeAliasSeatId } from '@/data/targets'
import { dailyNoteBlockId, dailyNotesDataExtension } from '@/plugins/daily-notes'
import { runConsistencyAudit } from '@/plugins/data-integrity/audit'
import type { Repo } from '@/data/repo'
import { referencesDataExtension } from '../dataExtension.ts'

const WS = 'ws-1'
// UUID-shaped so `((ROOT))` in generated content parses as a block ref.
const ROOT = '00000000-0000-4000-8000-000000000000'

// ──── property schemas under test ────

const reviewerProp = defineProperty<string>('reviewer', {
  codec: codecs.ref(),
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})
const relatedProp = defineProperty<readonly string[]>('related', {
  codec: codecs.refList(),
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})
const refSchemaExtension = [
  propertySchemasFacet.of(reviewerProp, {source: 'test'}),
  propertySchemasFacet.of(relatedProp, {source: 'test'}),
]

// ──── op + content generators ────

// 'ax'/'Inbox' exercise plain + case-carrying aliases; the ISO date
// routes through the daily-note path (deterministic dailyNoteBlockId,
// exempt from orphan cleanup — the daily branch, referencesProcessor.ts:146-172).
// 'January 5th, 2026' is the LONG-FORM daily title: its literal alias is a
// distinct claimable name from the ISO the daily seat claims, covering the
// per-mark write-phase recheck in applySourcePlan (Codex round 3).
const ALIAS_POOL = ['ax', 'ay', 'Inbox', '2026-01-05', 'January 5th, 2026'] as const

// Bracket shrapnel: content the parser must treat as inert (or not —
// either way the processor and the audit share one parser, so the
// fixpoint oracle is parser-agnostic).
const NOISE_POOL = ['[[', ']]', '((', '))', '[[ax', '((x', '[a](b)'] as const

type Frag =
  | {k: 'text'; s: string}
  | {k: 'noise'; n: number}
  | {k: 'wikilink'; a: number}
  | {k: 'blockref'; t: number; form: 'plain' | 'embed' | 'aliased'}

const fragArb: fc.Arbitrary<Frag> = fc.oneof(
  {weight: 2, arbitrary: fc.record({k: fc.constant('text' as const), s: fc.string({maxLength: 6})})},
  {weight: 1, arbitrary: fc.record({k: fc.constant('noise' as const), n: fc.nat(NOISE_POOL.length - 1)})},
  {weight: 3, arbitrary: fc.record({k: fc.constant('wikilink' as const), a: fc.nat(ALIAS_POOL.length - 1)})},
  {weight: 3, arbitrary: fc.record({
    k: fc.constant('blockref' as const),
    t: fc.nat(31),
    form: fc.constantFrom('plain' as const, 'embed' as const, 'aliased' as const),
  })},
)

const contentArb = fc.array(fragArb, {maxLength: 4})

const renderContent = (frags: readonly Frag[], ids: readonly string[]): string =>
  frags.map(f => {
    switch (f.k) {
      case 'text': return f.s
      case 'noise': return NOISE_POOL[f.n]
      case 'wikilink': return `[[${ALIAS_POOL[f.a]}]]`
      case 'blockref': {
        const id = ids[f.t % ids.length]
        return f.form === 'plain' ? `((${id}))`
          : f.form === 'embed' ? `!((${id}))`
          : `[lbl](((${id})))`
      }
    }
  }).join(' ')

const sel = fc.nat(31)

type OpSpec =
  | {op: 'create'; parent: number; frags: Frag[]}
  | {op: 'setContent'; id: number; frags: Frag[]}
  | {op: 'setReviewer'; id: number; target: number; clear: boolean}
  | {op: 'setRelated'; id: number; targets: number[]}
  | {op: 'setAlias'; id: number; alias: number; clear: boolean}
  | {op: 'deleteBlock' | 'restoreBlock'; id: number}
  | {op: 'merge'; into: number; from: number}
  | {op: 'advanceTime'}

const opArb: fc.Arbitrary<OpSpec> = fc.oneof(
  {weight: 4, arbitrary: fc.record({op: fc.constant('create' as const), parent: sel, frags: contentArb})},
  {weight: 5, arbitrary: fc.record({op: fc.constant('setContent' as const), id: sel, frags: contentArb})},
  {weight: 2, arbitrary: fc.record({op: fc.constant('setReviewer' as const), id: sel, target: sel, clear: fc.boolean()})},
  {weight: 2, arbitrary: fc.record({op: fc.constant('setRelated' as const), id: sel, targets: fc.array(sel, {maxLength: 3})})},
  {weight: 2, arbitrary: fc.record({op: fc.constant('setAlias' as const), id: sel, alias: fc.nat(ALIAS_POOL.length - 1), clear: fc.boolean()})},
  {weight: 2, arbitrary: fc.record({op: fc.constantFrom('deleteBlock' as const, 'restoreBlock' as const), id: sel})},
  {weight: 1, arbitrary: fc.record({op: fc.constant('merge' as const), into: sel, from: sel})},
  {weight: 1, arbitrary: fc.constant({op: 'advanceTime'} as OpSpec)},
)

// Batches, not a flat op list: each batch applies 1-3 ops back-to-back
// BEFORE the single flush+audit that follows it, so a processor plan
// from op[0] can still be in flight (unread committed state, an
// afterCommit not yet drained) when op[1] lands in the same tick — the
// mid-plan-interleaving shape that found the worst bugs this suite
// fixed (a stale plan clobbering a rename; a references-only writer
// clobbered between plan build and apply — see the SourcePlan docblock
// in referencesProcessor.ts). The audit oracle is unaffected: it's a
// post-flush fixpoint, and flush still runs once per batch (and once
// more at end-of-case), never mid-batch.
const caseArb = fc.record({
  batches: fc.array(fc.array(opArb, {minLength: 1, maxLength: 3}), {minLength: 1, maxLength: 12}),
  prngSeed: fc.integer({min: 1, max: 2 ** 31 - 2}),
})

// Domain rejections that are legal outcomes for incoherent op combos —
// via the shared `assertLegalKernelRejection`
// (`@/data/test/fuzzKernelHarness`), same contract as the kernel fuzzer,
// plus alias-collision processor rejections
// (block_aliases_workspace_alias_unique) that the harness itself covers.

// ──── execution ────

interface Env {
  repo: Repo
  /** Drain reprojections + post-commit processors; advance past the
   *  orphan-cleanup delay when asked (referencesProcessor.test.ts:111). */
  flush(delayMs?: number): Promise<void>
}

const applyOp = async (env: Env, op: OpSpec, ids: readonly string[]): Promise<string[]> => {
  const {repo} = env
  switch (op.op) {
    case 'create':
      return [await repo.mutate.createChild({
        parentId: pick(op.parent, ids),
        position: {kind: 'last'},
        content: renderContent(op.frags, ids),
      })]
    case 'setContent':
      await repo.mutate.setContent({id: pick(op.id, ids), content: renderContent(op.frags, ids)})
      return []
    case 'setReviewer':
      await repo.mutate.setProperty({
        id: pick(op.id, ids),
        schema: reviewerProp,
        value: op.clear ? '' : pick(op.target, ids),
      })
      return []
    case 'setRelated':
      await repo.mutate.setProperty({
        id: pick(op.id, ids),
        schema: relatedProp,
        value: op.targets.map(t => pick(t, ids)),
      })
      return []
    case 'setAlias':
      await repo.mutate.setProperty({
        id: pick(op.id, ids),
        schema: aliasesProp,
        value: op.clear ? [] : [ALIAS_POOL[op.alias]],
      })
      return []
    case 'deleteBlock':
      await repo.mutate.delete({id: pickNonRoot(op.id, ids)})
      return []
    case 'restoreBlock':
      await repo.mutate.restore({id: pickNonRoot(op.id, ids)})
      return []
    case 'merge':
      await repo.mutate.merge({intoId: pick(op.into, ids), fromId: pickNonRoot(op.from, ids)})
      return []
    case 'advanceTime':
      await env.flush(4001)
      return []
  }
}

// ──── oracle ────

const auditOrFail = async (db: TestDb['db'], repo: Repo): Promise<void> => {
  const audit = await runConsistencyAudit(db, WS, 0, {
    full: {
      schemas: repo.propertySchemas,
      activeWorkspaceId: repo.activeWorkspaceId,
    },
  })
  expect(audit.anomalies, `consistency audit: ${JSON.stringify(audit.checks)}`).toBe(0)
}

// ──── the property ────

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => {
  await guard.barrier()
  await sharedDb.cleanup()
})

/** Interrupt-barrier + Math.random pin for the shared DB — see
 *  `statefulFuzzGuard` (`@/test/fuzz`, docs/fuzzing.md §6). */
const guard = statefulFuzzGuard()

type CaseArgs = {batches: OpSpec[][]; prngSeed: number}

/** Pull processor-minted ids (alias seats, daily-note targets) into the
 *  op-target pool so later ops can pick them — deletes/restores/merges
 *  were previously blind to them, missing the neighborhood of the
 *  daily-seat collision bug this suite itself found. A SQL scan over
 *  the (workspace-scoped) `blocks` table is deterministic given the
 *  db state, which is itself a deterministic function of the ops +
 *  seeded PRNG replayed so far — so this preserves shrinkability
 *  without deriving seat ids by hand (which needs the probe index,
 *  not just the alias — see `resolveAliasSeatId`, targets.ts:323).
 *  `ORDER BY id` keeps the newly-appended slice's order reproducible. */
const collectMintedIds = async (db: TestDb['db'], ids: string[]): Promise<void> => {
  const rows = await db.getAll<{id: string}>(
    'SELECT id FROM blocks WHERE workspace_id = ? ORDER BY id', [WS])
  const known = new Set(ids)
  for (const row of rows) {
    if (known.has(row.id)) continue
    known.add(row.id)
    ids.push(row.id)
  }
}

const buildEnv = async (): Promise<Env> => {
  await resetTestDb(sharedDb.db)
  // UUID-shaped deterministic ids — the block-ref parser only recognises
  // UUIDv4-shaped ids, so createTestRepo's default `gen-N` ids would make
  // every `((id))` frag inert (the canary below pins this can't regress).
  let idCursor = 0
  const {repo} = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    newId: () => `00000000-0000-4000-8000-${String(++idCursor).padStart(12, '0')}`,
    extensions: [dailyNotesDataExtension, referencesDataExtension, ...refSchemaExtension],
  })
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: ROOT, workspaceId: WS, parentId: null, orderKey: 'a0'})
  }, {scope: ChangeScope.BlockDefault})
  const flush = async (delayMs = 0): Promise<void> => {
    await vi.advanceTimersByTimeAsync(1)
    await repo.awaitReprojections()
    await repo.awaitProcessors()
    if (delayMs > 0) {
      await vi.advanceTimersByTimeAsync(delayMs)
      await repo.awaitReprojections()
      await repo.awaitProcessors()
    }
  }
  return {repo, flush}
}

const runCase = async ({batches}: Omit<CaseArgs, 'prngSeed'>): Promise<void> => {
  // Fake timers so the 4s orphan-cleanup delay is drivable in-case and
  // can never leak a live timeout into a later case (cleared below).
  // No `shouldAdvanceTime`: that option auto-advances fake time in step
  // with the wall clock, so the 4s orphan-cleanup timer could fire at a
  // wall-clock-dependent point — weakening exact shrink/replay. `flush`
  // advances fake time explicitly via `advanceTimersByTimeAsync`, which
  // doesn't need it. Installed inside the guarded body so the barrier
  // (which may await a still-running prior case) precedes it.
  vi.useFakeTimers()
  let env: Env | null = null
  try {
    env = await buildEnv()
    const ids: string[] = [ROOT]
    for (const batch of batches) {
      // All ops in the batch land before the batch's single flush —
      // the mid-plan-interleaving window (see caseArb's docblock).
      for (const op of batch) {
        try {
          ids.push(...await applyOp(env, op, ids))
        } catch (e) {
          assertLegalKernelRejection(e, JSON.stringify(op))
        }
      }
      await env.flush()
      await collectMintedIds(sharedDb.db, ids)
      await auditOrFail(sharedDb.db, env.repo)
    }
    // Fire any pending orphan cleanups, then re-audit the settled state.
    await env.flush(4001)
    await collectMintedIds(sharedDb.db, ids)
    await auditOrFail(sharedDb.db, env.repo)
  } finally {
    // A failing/abandoned case may leave detached processor work — drain
    // it so it can't write into the next case's freshly reset DB.
    if (env !== null) {
      await env.flush().catch(() => {})
    }
    vi.clearAllTimers()
    vi.useRealTimers()
  }
}

describe('references pipeline sequences', () => {
  it('reach a content/property ↔ references fixpoint the full audit certifies', async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, ({batches, prngSeed}) =>
        guard.run(prngSeed, () => runCase({batches}))),
      fuzzParams(8),
    )
  }, fuzzTestTimeout())

  // Non-vacuity canary: the audit oracle only bites if the op set
  // actually drives every pipeline stage. Pins: content-ref parsing +
  // alias/daily target creation, property-ref projection, rename
  // rewriting, delete inlining, and orphan cleanup all observably fire
  // under the harness (fake timers + flush) this suite uses.
  it('op set drives every pipeline stage', async () => {
    await guard.barrier()
    vi.useFakeTimers({shouldAdvanceTime: true})
    try {
      const env = await buildEnv()
      const {repo, flush} = env
      const read = (id: string) =>
        sharedDb.db.getOptional<{content: string; deleted: 0 | 1; references_json: string}>(
          'SELECT content, deleted, references_json FROM blocks WHERE id = ?', [id])

      const src = await repo.mutate.createChild({
        parentId: ROOT,
        position: {kind: 'last'},
        content: `[[ax]] and ((${ROOT})) on [[2026-01-05]]`,
      })
      await flush()
      const axId = computeAliasSeatId('ax', WS)
      const dailyId = dailyNoteBlockId(WS, '2026-01-05')
      expect((await read(axId))?.deleted, 'alias target created').toBe(0)
      expect((await read(dailyId))?.deleted, 'daily-note target created').toBe(0)
      const contentRefs = JSON.parse((await read(src))!.references_json) as Array<{id: string}>
      expect(contentRefs.map(r => r.id).sort(), 'content refs parsed').toEqual(
        [axId, ROOT, dailyId].sort())

      await repo.mutate.setProperty({id: src, schema: reviewerProp, value: ROOT})
      await flush()
      const propRefs = await sharedDb.db.getAll<{n: number}>(
        `SELECT COUNT(*) AS n FROM block_references WHERE source_field = 'reviewer'`)
      expect(propRefs[0].n, 'property ref projected').toBeGreaterThan(0)

      // Rename: the referrer's content must be rewritten [[ax]] → [[bx]].
      await repo.mutate.setProperty({id: axId, schema: aliasesProp, value: ['bx']})
      await flush()
      expect((await read(src))!.content, 'rename rewrote referrer').toContain('[[bx]]')

      // Delete inlining: `((target))` marks in referrers get spliced out.
      const target = await repo.mutate.createChild({
        parentId: ROOT, position: {kind: 'last'}, content: 'inline me',
      })
      await flush()
      const referrer = await repo.mutate.createChild({
        parentId: ROOT, position: {kind: 'last'}, content: `holds ((${target}))`,
      })
      await flush()
      await repo.mutate.delete({id: target})
      await flush()
      expect((await read(referrer))!.content, 'deleted ref inlined').toBe('holds inline me')

      // Orphan cleanup: a freshly minted alias target whose only referrer
      // drops the mark within the 4s window gets soft-deleted.
      const orphanSrc = await repo.mutate.createChild({
        parentId: ROOT, position: {kind: 'last'}, content: '[[zz]]',
      })
      await flush()
      const zzId = computeAliasSeatId('zz', WS)
      expect((await read(zzId))?.deleted, 'orphan-candidate target created').toBe(0)
      await repo.mutate.setContent({id: orphanSrc, content: 'no more link'})
      await flush(4001)
      expect((await read(zzId))?.deleted, 'orphan alias target cleaned up').toBe(1)

      // The deep audit checks must have actually scanned this state.
      const audit = await runConsistencyAudit(sharedDb.db, WS, 0, {
        full: {schemas: repo.propertySchemas, activeWorkspaceId: repo.activeWorkspaceId},
      })
      expect(audit.anomalies, `consistency audit: ${JSON.stringify(audit.checks)}`).toBe(0)
      const recompute = audit.checks.content_link_recompute as {status: string; blocksWithMarks: number}
      expect(recompute.status).toBe('ok')
      expect(recompute.blocksWithMarks, 'recompute check saw marks').toBeGreaterThan(0)
      const projection = audit.checks.property_ref_projection as {status: string; scanned: number}
      expect(projection.status).toBe('ok')
      expect(projection.scanned, 'projection check saw candidates').toBeGreaterThan(0)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })
})
