// @vitest-environment node
/**
 * Fuzz suite for `decideStagingRow` (`../reconcile.ts`) — see
 * `src/test/fuzz.ts` for the smoke/deep tier mechanics.
 *
 * `decideStagingRow` is the pure Layout B reconcile gate: given a
 * workspace's `Materializability`, an incoming staging row's
 * `updated_at` stamp, and the local `blocks` row-version state for that
 * id, it decides `defer` / `skip-stale` / `apply`. Its soundness rests
 * on a ground-truth invariant enforced server-side by
 * `supabase/migrations/20260612000000_add_user_updated_at_monotonic_clamp.sql`
 * (`blocks_clamp_updated_at`, lines 52-74): on every UPDATE the stamp is
 * floored to `greatest(NEW.updated_at, OLD.updated_at)`, and bumped by
 * an extra `+1` over the floored `OLD.updated_at` iff a content column
 * (`parent_id`/`order_key`/`content`/`properties_json`/`references_json`/
 * `deleted`) actually changed. That gives two properties the gate leans
 * on:
 *   (a) the stamp is non-decreasing across writes to the same row, and
 *   (b) two writes can only share an equal NONZERO stamp if neither
 *       changed content (a content-changing write is always strictly
 *       newer than what it floored from).
 * `0` is never produced by the clamp (it only applies on UPDATE, and a
 * fresh deterministic-id INSERT mints at `0` client-side) — it is a
 * dedicated "pristine, unwritten" sentinel, which is why reconcile.ts
 * carves it out as invariant I2.
 *
 * Oracles below (each cites the reconcile.ts lines it encodes):
 *
 * 1. Case analysis over the full single-call input space:
 *    - never throws, result.kind is always one of the three ReconcileAction
 *      kinds (reconcile.ts:50-57)
 *    - defer ⟺ materializability === 'defer', independent of local state:
 *      the `defer` check (reconcile.ts:76-78) is the FIRST thing the
 *      function does and returns unconditionally, before `local` is even
 *      read — confirmed by the existing unit test "defer takes precedence
 *      over any local state" (reconcile.test.ts:90-94).
 *    - when the decision is `apply`, `decrypt` ⟺ materializability ===
 *      'decrypt' (reconcile.ts:137: `decrypt: materializability ===
 *      'decrypt'`, unconditional on the apply branch — 'copy' is the only
 *      other non-defer value, so this is exhaustive).
 *    - `hasPendingUpload` (given non-defer) ⟹ skip-stale: this is the
 *      SECOND check, before the stamp comparison (reconcile.ts:83-87) — a
 *      pending local edit always wins regardless of stamps, including a
 *      staging stamp of `Number.MAX_SAFE_INTEGER` (mirrors
 *      reconcile.test.ts:45-49).
 *    - an exact-match "characterization" oracle: an independently written
 *      `referenceDecide` (built straight from the I1/I2 prose in
 *      reconcile.ts:88-123, not copy-pasted from the implementation) must
 *      agree with `decideStagingRow` on every input. This subsumes the
 *      four bullets above but is kept as a single strong differential
 *      check across the whole domain (materializability × stamp ×
 *      LocalRowState), including huge stamps (Number.MAX_SAFE_INTEGER)
 *      and the null/0/nonzero LocalRowState variants.
 *
 * 2. A sequence/model property simulating one block id through a random
 *    event stream against a fake "server" that applies the migration's
 *    floor+bump clamp. See the `runModel` docblock below for the per-step
 *    invariants it checks (I1 fixpoint, I2, convergence) and for why the
 *    "staging never applies an older nonzero stamp than local" framing
 *    from a naive reading of the PR spec is WRONG and not asserted here —
 *    reconcile.ts:125-136 documents that strictly-newer-local protection
 *    is deliberately absent.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import { decideStagingRow, type LocalRowState, type ReconcileAction } from '../reconcile.js'
import type { Materializability } from '@/sync/transform.js'

// ──── Domain arbitraries ────

const materializabilityArb: fc.Arbitrary<Materializability> = fc.constantFrom(
  'decrypt',
  'copy',
  'defer',
)

/** Non-defer materializability — the branch where `local` is actually consulted. */
const materializableArb: fc.Arbitrary<Materializability> = fc.constantFrom('decrypt', 'copy')

/** stamps ∈ {0, small ints, huge ints} per the task brief. */
const stampArb = fc.oneof(
  { arbitrary: fc.constant(0), weight: 2 },
  { arbitrary: fc.integer({ min: 1, max: 1_000 }), weight: 3 },
  { arbitrary: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), weight: 2 },
  { arbitrary: fc.constant(Number.MAX_SAFE_INTEGER), weight: 1 },
)

const localUpdatedAtArb = fc.oneof(
  { arbitrary: fc.constant(null), weight: 2 },
  { arbitrary: fc.constant(0), weight: 2 },
  { arbitrary: fc.integer({ min: 1, max: 1_000 }), weight: 3 },
  { arbitrary: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), weight: 2 },
)

const localRowStateArb: fc.Arbitrary<LocalRowState> = fc.record({
  localUpdatedAt: localUpdatedAtArb,
  hasPendingUpload: fc.boolean(),
})

const reconcileActionKinds = ['apply', 'defer', 'skip-stale']

// ──── Section 1: totality + case analysis ────

describe('decideStagingRow: totality', () => {
  it('never throws, result.kind is always a member of ReconcileAction (reconcile.ts:50-57)', () => {
    fc.assert(
      fc.property(materializabilityArb, stampArb, localRowStateArb, (m, stamp, local) => {
        const action = decideStagingRow(m, stamp, local)
        expect(reconcileActionKinds).toContain(action.kind)
      }),
      fuzzParams(300),
    )
  })
})

describe('decideStagingRow: defer', () => {
  it("defer ⟺ materializability === 'defer', independent of local state (reconcile.ts:76-78, unconditional first check)", () => {
    fc.assert(
      fc.property(materializabilityArb, stampArb, localRowStateArb, (m, stamp, local) => {
        const action = decideStagingRow(m, stamp, local)
        expect(action.kind === 'defer').toBe(m === 'defer')
      }),
      fuzzParams(300),
    )
  })
})

describe('decideStagingRow: decrypt flag', () => {
  it("on apply, decrypt ⟺ materializability === 'decrypt' (reconcile.ts:137)", () => {
    fc.assert(
      fc.property(materializableArb, stampArb, localRowStateArb, (m, stamp, local) => {
        const action = decideStagingRow(m, stamp, local)
        if (action.kind === 'apply') {
          expect(action.decrypt).toBe(m === 'decrypt')
        }
      }),
      fuzzParams(300),
    )
  })
})

describe('decideStagingRow: pending upload always wins', () => {
  it('hasPendingUpload (non-defer) ⟹ skip-stale, regardless of stamps (reconcile.ts:83-87)', () => {
    fc.assert(
      fc.property(
        materializableArb,
        stampArb,
        localUpdatedAtArb,
        (m, stagingUpdatedAt, localUpdatedAt) => {
          const local: LocalRowState = { localUpdatedAt, hasPendingUpload: true }
          const action = decideStagingRow(m, stagingUpdatedAt, local)
          expect(action).toEqual({ kind: 'skip-stale' })
        },
      ),
      fuzzParams(300),
    )
  })
})

/**
 * Independent reference model built directly from the I1/I2 prose
 * (reconcile.ts:88-123), not from the implementation's control flow —
 * an exact-match differential oracle against `decideStagingRow` over the
 * whole input space.
 */
const referenceDecide = (
  m: Materializability,
  stagingUpdatedAt: number,
  local: LocalRowState,
): ReconcileAction => {
  if (m === 'defer') return { kind: 'defer' }
  if (local.hasPendingUpload) return { kind: 'skip-stale' }
  const equalNonzero =
    local.localUpdatedAt !== null &&
    local.localUpdatedAt === stagingUpdatedAt &&
    local.localUpdatedAt !== 0
  if (equalNonzero) return { kind: 'skip-stale' }
  return { kind: 'apply', decrypt: m === 'decrypt' }
}

describe('decideStagingRow: characterization (exact match vs. an independent I1/I2 reference model)', () => {
  it('agrees with referenceDecide on every input', () => {
    fc.assert(
      fc.property(materializabilityArb, stampArb, localRowStateArb, (m, stamp, local) => {
        expect(decideStagingRow(m, stamp, local)).toEqual(referenceDecide(m, stamp, local))
      }),
      fuzzParams(300),
    )
  })
})

// ──── Section 2: sequence/model property ────

/**
 * A fake "server" for one block id, mirroring
 * `blocks_clamp_updated_at` (migration 20260612000000, lines 52-74):
 * on every content-changing UPDATE the stamp becomes
 * `max(candidate, OLD.stamp + 1)` (floor, then +1 bump); on a
 * metadata-only UPDATE it's `max(candidate, OLD.stamp)` (floor only, no
 * bump). `candidate` models a wall-clock write time that can lag behind
 * the server (clock skew / same-ms writes) via a possibly-negative
 * drift — the floor is what makes that safe.
 */
interface ServerState {
  stamp: number
}

const applyContentChange = (server: ServerState, drift: number): number => {
  const candidate = server.stamp + drift
  server.stamp = Math.max(candidate, server.stamp + 1)
  return server.stamp
}

const applyMetaChange = (server: ServerState, drift: number): number => {
  const candidate = server.stamp + drift
  server.stamp = Math.max(candidate, server.stamp)
  return server.stamp
}

type ModelEvent =
  /** Deliver the current server stamp as a staging row and run the gate. */
  | { readonly type: 'delivery' }
  /** A local edit is made; goes into the (unsent) upload queue. */
  | { readonly type: 'localEdit' }
  /** Another writer (peer device / this client's own upload) changes
   *  content server-side. */
  | { readonly type: 'serverContentChange'; readonly drift: number }
  /** A metadata-only server-side write (floor, no bump). */
  | { readonly type: 'serverMetaChange'; readonly drift: number }
  /** The pending local edit's upload lands: a content-changing write,
   *  clears `hasPendingUpload`, and its echo is delivered immediately
   *  (an upload's echo is itself the next staging delivery). */
  | { readonly type: 'uploadAck'; readonly drift: number }

const driftArb = fc.integer({ min: -5, max: 5 })

const eventArb: fc.Arbitrary<ModelEvent> = fc.oneof(
  { arbitrary: fc.record({ type: fc.constant('delivery' as const) }), weight: 4 },
  { arbitrary: fc.record({ type: fc.constant('localEdit' as const) }), weight: 2 },
  {
    arbitrary: fc.record({ type: fc.constant('serverContentChange' as const), drift: driftArb }),
    weight: 3,
  },
  {
    arbitrary: fc.record({ type: fc.constant('serverMetaChange' as const), drift: driftArb }),
    weight: 2,
  },
  {
    arbitrary: fc.record({ type: fc.constant('uploadAck' as const), drift: driftArb }),
    weight: 2,
  },
)

/**
 * Run one random event stream through the gate for a single block id and
 * check the invariants the task asks for. `materializability` is held
 * fixed for the whole run (a workspace flipping locked/unlocked mid-run
 * is a defer-path concern, already covered by section 1's
 * materializability-independence property).
 *
 * Invariants checked inline, each cited against reconcile.ts:
 *
 * - I1 fixpoint (reconcile.ts:93-99, 111-113): immediately re-delivering
 *   the SAME nonzero stamp right after an apply of that stamp (with no
 *   intervening pending edit) must yield skip-stale — re-delivery is
 *   idempotent.
 * - I2 (reconcile.ts:105-107, 109-110): equal-ZERO stamps still apply —
 *   checked whenever a delivery happens to land with
 *   `local.localUpdatedAt === 0 === stagingUpdatedAt` and no pending
 *   upload.
 * - Convergence (reconcile.ts:125-136, "no oscillation" reading of I1):
 *   once the event stream ends and any pending upload is drained, the
 *   final (highest) server stamp — if nonzero — self-heals to a fixpoint
 *   within one extra delivery and then skip-stales forever on repeat
 *   redelivery. (Zero stays a standing exception per I2: a 0-stamped
 *   staging row applies on EVERY redelivery, by design — reconcile.ts:
 *   109-110 — so the "forever skip-stale" half of convergence is only
 *   asserted for a nonzero final stamp.)
 *
 * Deliberately NOT asserted: "the gate never applies a staging stamp
 * strictly older than a nonzero local stamp." reconcile.ts:125-136 says
 * the opposite is intentional — strictly-newer-local protection was
 * removed; an older, non-pending, non-equal delivery still applies
 * (a transient revert the echo/LWW cache self-heals). The `serverStamp
 * can move by a negative drift relative to a stale in-flight delivery`
 * scenario below exercises exactly that path without asserting it's
 * refused.
 */
const runModel = (
  materializability: Materializability,
  startStamp: 0 | 1,
  events: readonly ModelEvent[],
): void => {
  const server: ServerState = { stamp: startStamp }
  let local: LocalRowState = { localUpdatedAt: startStamp, hasPendingUpload: false }

  const deliver = (): ReconcileAction => {
    const stagingUpdatedAt = server.stamp
    const before = local
    const action = decideStagingRow(materializability, stagingUpdatedAt, before)
    expect(reconcileActionKinds).toContain(action.kind)
    expect(action.kind).not.toBe('defer') // materializability is fixed non-defer for this model

    if (action.kind === 'apply') {
      local = { localUpdatedAt: stagingUpdatedAt, hasPendingUpload: before.hasPendingUpload }
      // I1 fixpoint: immediately re-delivering the same nonzero stamp,
      // with local now caught up and no pending edit created in between,
      // must skip.
      if (stagingUpdatedAt !== 0 && !local.hasPendingUpload) {
        const redelivery = decideStagingRow(materializability, stagingUpdatedAt, local)
        expect(redelivery).toEqual({ kind: 'skip-stale' })
      }
    } else {
      // skip-stale: I2 must never produce skip-stale for equal-zero,
      // non-pending stamps.
      if (
        !before.hasPendingUpload &&
        before.localUpdatedAt === 0 &&
        stagingUpdatedAt === 0
      ) {
        throw new Error('I2 violated: equal-zero stamps must apply, not skip')
      }
    }
    return action
  }

  for (const ev of events) {
    switch (ev.type) {
      case 'delivery':
        deliver()
        break
      case 'localEdit':
        local = { ...local, hasPendingUpload: true }
        break
      case 'serverContentChange':
        applyContentChange(server, ev.drift)
        break
      case 'serverMetaChange':
        applyMetaChange(server, ev.drift)
        break
      case 'uploadAck': {
        // The upload always carries a content change (that's what
        // makes it worth uploading), so it goes through the +1-bump
        // path, then clears pending, then its echo is delivered.
        applyContentChange(server, ev.drift)
        local = { ...local, hasPendingUpload: false }
        deliver()
        break
      }
    }
  }

  // ── Drain phase: flush any still-pending edit, then check convergence. ──
  if (local.hasPendingUpload) {
    applyContentChange(server, 0)
    local = { ...local, hasPendingUpload: false }
  }

  const finalStamp = server.stamp
  // One delivery must bring local up to the final server stamp (via
  // apply, or it was already there).
  deliver()
  expect(local.localUpdatedAt).toBe(finalStamp)

  if (finalStamp !== 0) {
    // No-oscillation: redelivering the converged nonzero stamp
    // skip-stales forever (checked a few times, not just once).
    for (let i = 0; i < 3; i++) {
      const again = decideStagingRow(materializability, finalStamp, local)
      expect(again).toEqual({ kind: 'skip-stale' })
    }
  } else {
    // I2 standing exception: a converged ZERO stamp keeps applying,
    // every time, forever — it never reaches a skip-stale fixpoint.
    for (let i = 0; i < 3; i++) {
      const again = decideStagingRow(materializability, finalStamp, local)
      expect(again).toEqual({ kind: 'apply', decrypt: materializability === 'decrypt' })
    }
  }
}

describe('decideStagingRow: sequence model', () => {
  // Third arg = generous timeout: smoke stays well under it, but a
  // FUZZ_TIME_MS deep run can legitimately run past vitest's 5s default
  // (see src/test/fuzz.ts fuzzTestTimeout docblock).
  it(
    'random event streams converge and never violate I1/I2',
    () => {
      fc.assert(
        fc.property(
          materializableArb,
          fc.constantFrom(0 as const, 1 as const),
          fc.array(eventArb, { minLength: 0, maxLength: 60 }),
          (materializability, startStamp, events) => {
            runModel(materializability, startStamp, events)
          },
        ),
        fuzzParams(150),
      )
    },
    fuzzTestTimeout(),
  )
})
