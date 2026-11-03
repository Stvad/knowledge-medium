// @vitest-environment node
/**
 * Fuzz suite for the pure Layout B reconcile gate (`../reconcile.ts`) — see
 * `src/test/fuzz.ts` for the smoke/deep tier mechanics.
 *
 * The rule under test: a staged row is never skipped on the strength of its
 * `updated_at` stamp. `decideStagingRow` only defers (workspace not
 * materializable) or lets a pending local edit win; whether a decoded staged
 * row is a no-op is a COMPARISON of every synced column
 * (`localHoldsStagedRow`). Equal stamps prove nothing — the server merges
 * columns independently, so one version can carry different columns than a
 * device holding the same stamp (#1163), and stamp 0 is shared by
 * construction across independent deterministic-id mints. A reader that
 * cannot decode (`blocksAlreadyReflects`) compares the clear columns and
 * lets a nonzero stamp vouch for the sealed ones it cannot read.
 *
 * Oracles:
 *
 * 1. `decideStagingRow`: totality, defer / decrypt-flag / pending-wins
 *    properties, and an exact-match differential against an independently
 *    written `referenceDecide`.
 *
 * 2. The two row predicates over generated row PAIRS (a base row plus a
 *    random subset of the 12 compared columns perturbed on one side, with
 *    equal-stamp-but-other-columns-differ — the #1163 shape — deliberately
 *    common): exact agreement with references written from the contract
 *    (`localHoldsStagedRow`: every compared column but `id` is `===`;
 *    `blocksAlreadyReflects`: clear columns equal AND (local stamp nonzero OR
 *    sealed equal), OR the tombstone arm), the #1163 property stated
 *    directly, soundness (`localHoldsStagedRow` ⇒ `blocksAlreadyReflects`),
 *    and a divergent clear column never reading as reflected.
 *
 * 3. A sequence model of one block id (server row vs local row, each
 *    carrying `updated_at` / `content` / `user_updated_at`) whose delivery
 *    step is the drain's: pending → skip; else identical → no write; else
 *    local := staged. See `runModel` for its invariants and for what is
 *    deliberately not asserted.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import {
  blocksAlreadyReflects,
  decideStagingRow,
  localHoldsStagedRow,
  type LocalRowState,
  type ReconcileAction,
} from '../reconcile.js'
import { BLOCK_STORAGE_COLUMNS, type BlockRow } from '@/data/blockSchema.js'
import { SEALED_COLUMNS, type Materializability } from '@/sync/transform.js'

// ──── Domain arbitraries ────

const materializabilityArb: fc.Arbitrary<Materializability> = fc.constantFrom(
  'decrypt',
  'copy',
  'defer',
)

/** Non-defer materializability — the branch where `local` is actually consulted. */
const materializableArb: fc.Arbitrary<Materializability> = fc.constantFrom('decrypt', 'copy')

const localRowStateArb: fc.Arbitrary<LocalRowState> = fc.record({
  hasPendingUpload: fc.boolean(),
})

const reconcileActionKinds = ['apply', 'defer', 'skip-stale']

// ──── Section 1: decideStagingRow ────

describe('decideStagingRow: totality', () => {
  it('never throws, result.kind is always a member of ReconcileAction', () => {
    fc.assert(
      fc.property(materializabilityArb, localRowStateArb, (m, local) => {
        expect(reconcileActionKinds).toContain(decideStagingRow(m, local).kind)
      }),
      fuzzParams(100),
    )
  })
})

describe('decideStagingRow: defer', () => {
  it("defer ⟺ materializability === 'defer', independent of pending state", () => {
    fc.assert(
      fc.property(materializabilityArb, localRowStateArb, (m, local) => {
        expect(decideStagingRow(m, local).kind === 'defer').toBe(m === 'defer')
      }),
      fuzzParams(100),
    )
  })
})

describe('decideStagingRow: decrypt flag', () => {
  it("on apply, decrypt ⟺ materializability === 'decrypt'", () => {
    fc.assert(
      fc.property(materializableArb, localRowStateArb, (m, local) => {
        const action = decideStagingRow(m, local)
        if (action.kind === 'apply') {
          expect(action.decrypt).toBe(m === 'decrypt')
        }
      }),
      fuzzParams(100),
    )
  })
})

describe('decideStagingRow: pending upload always wins', () => {
  it('hasPendingUpload (non-defer) ⟹ skip-stale', () => {
    fc.assert(
      fc.property(materializableArb, m => {
        expect(decideStagingRow(m, { hasPendingUpload: true })).toEqual({ kind: 'skip-stale' })
      }),
      fuzzParams(50),
    )
  })

  it('no pending upload (non-defer) ⟹ apply — there is no stamp-based skip', () => {
    fc.assert(
      fc.property(materializableArb, m => {
        expect(decideStagingRow(m, { hasPendingUpload: false }))
          .toEqual({ kind: 'apply', decrypt: m === 'decrypt' })
      }),
      fuzzParams(50),
    )
  })
})

/** Independent reference written from the contract: defer wins, then a pending
 *  edit, else apply. */
const referenceDecide = (m: Materializability, local: LocalRowState): ReconcileAction => {
  if (m === 'defer') return { kind: 'defer' }
  if (local.hasPendingUpload) return { kind: 'skip-stale' }
  return { kind: 'apply', decrypt: m === 'decrypt' }
}

describe('decideStagingRow: characterization (exact match vs. an independent reference)', () => {
  it('agrees with referenceDecide on every input', () => {
    fc.assert(
      fc.property(materializabilityArb, localRowStateArb, (m, local) => {
        expect(decideStagingRow(m, local)).toEqual(referenceDecide(m, local))
      }),
      fuzzParams(100),
    )
  })
})

// ──── Section 2: the row predicates ────

/** The 12 compared columns, written out by hand so the references do not
 *  derive from the implementation's `BLOCK_STORAGE_COLUMNS` walk. */
const COMPARED = [
  'workspace_id', 'parent_id', 'order_key', 'content', 'properties_json',
  'references_json', 'created_at', 'updated_at', 'user_updated_at',
  'created_by', 'updated_by', 'deleted',
] as const satisfies readonly (keyof BlockRow)[]
const SEALED = ['content', 'properties_json', 'references_json'] as const
const CLEAR = COMPARED.filter(c => !(SEALED as readonly string[]).includes(c))

describe('reference column lists', () => {
  it('match the schema (a new storage column must be considered by this suite)', () => {
    expect([...COMPARED].sort())
      .toEqual(BLOCK_STORAGE_COLUMNS.map(c => c.name).filter(n => n !== 'id').sort())
    expect([...SEALED].sort()).toEqual([...SEALED_COLUMNS].sort())
  })
})

/** Small domains so independently drawn values collide often. */
const stampArb = fc.oneof(
  { arbitrary: fc.constant(0), weight: 3 },
  { arbitrary: fc.integer({ min: 1, max: 4 }), weight: 4 },
  { arbitrary: fc.constant(Number.MAX_SAFE_INTEGER), weight: 1 },
)

const rowArb: fc.Arbitrary<BlockRow> = fc.record({
  id: fc.constant('b1'),
  workspace_id: fc.constantFrom('w1', 'w2'),
  parent_id: fc.constantFrom(null, 'p1', 'p2'),
  order_key: fc.constantFrom('a0', 'a1'),
  content: fc.constantFrom('', 'x', 'y'),
  properties_json: fc.constantFrom('{}', '{"k":1}'),
  references_json: fc.constantFrom('[]', '[{"id":"r"}]'),
  created_at: fc.integer({ min: 0, max: 2 }),
  updated_at: stampArb,
  user_updated_at: fc.constantFrom(null, 0, 1, 2),
  created_by: fc.constantFrom('u1', 'u2'),
  updated_by: fc.constantFrom('u1', 'u2'),
  deleted: fc.constantFrom(0, 1),
}) as fc.Arbitrary<BlockRow>

interface RowPair {
  /** Present local row, or null/undefined (absent). */
  readonly local: BlockRow | null | undefined
  readonly staged: BlockRow
}

/**
 * Base row + a random subset of the compared columns taken from a second row
 * on the staged side. `stamp` decides what happens to `updated_at` afterwards:
 *  - `equal`: forced equal to local's regardless of the mask — with other
 *    columns perturbed this is the #1163 shape (weighted heavily);
 *  - `free`: whatever the mask produced;
 *  - `differ`: forced different.
 */
const rowPairArb: fc.Arbitrary<RowPair> = fc
  .record({
    base: rowArb,
    alt: rowArb,
    mask: fc.array(fc.boolean(), { minLength: COMPARED.length, maxLength: COMPARED.length }),
    stamp: fc.oneof(
      { arbitrary: fc.constant('equal' as const), weight: 5 },
      { arbitrary: fc.constant('free' as const), weight: 3 },
      { arbitrary: fc.constant('differ' as const), weight: 2 },
    ),
    presence: fc.oneof(
      { arbitrary: fc.constant('row' as const), weight: 9 },
      { arbitrary: fc.constant('null' as const), weight: 1 },
      { arbitrary: fc.constant('undefined' as const), weight: 1 },
    ),
  })
  .map(({ base, alt, mask, stamp, presence }): RowPair => {
    const staged: Record<string, unknown> = { ...base }
    COMPARED.forEach((column, i) => {
      if (mask[i]) staged[column] = alt[column]
    })
    if (stamp === 'equal') staged.updated_at = base.updated_at
    else if (stamp === 'differ' && staged.updated_at === base.updated_at) {
      staged.updated_at = base.updated_at === 0 ? 1 : base.updated_at - 1
    }
    const local = presence === 'row' ? base : presence === 'null' ? null : undefined
    return { local, staged: staged as unknown as BlockRow }
  })

const sameOn = (columns: readonly (keyof BlockRow)[], a: BlockRow, b: BlockRow): boolean =>
  columns.every(c => a[c] === b[c])

const referenceHolds = (local: BlockRow | null | undefined, staged: BlockRow): boolean =>
  local != null && sameOn(COMPARED, local, staged)

const referenceReflects = (staged: BlockRow, local: BlockRow | undefined): boolean => {
  const clearMatch = local !== undefined && sameOn(CLEAR, local, staged)
  const vouched = local !== undefined && (local.updated_at !== 0 || sameOn(SEALED, local, staged))
  const tombstoneArm = staged.deleted === 1 && (local === undefined || local.deleted === 1)
  return (clearMatch && vouched) || tombstoneArm
}

const asReflectsLocal = (local: BlockRow | null | undefined): BlockRow | undefined =>
  local ?? undefined

describe('localHoldsStagedRow', () => {
  it('agrees exactly with a every-compared-column-equal reference', () => {
    fc.assert(
      fc.property(rowPairArb, ({ local, staged }) => {
        expect(localHoldsStagedRow(local, staged)).toBe(referenceHolds(local, staged))
      }),
      fuzzParams(400),
    )
  })

  it('#1163: equal NONZERO stamps with any other compared column differing ⟹ not held', () => {
    fc.assert(
      fc.property(rowPairArb, ({ local, staged }) => {
        fc.pre(local != null && local.updated_at !== 0 && local.updated_at === staged.updated_at)
        const others = COMPARED.filter(c => c !== 'updated_at')
        fc.pre(others.some(c => local![c] !== staged[c]))
        expect(localHoldsStagedRow(local, staged)).toBe(false)
      }),
      fuzzParams(400),
    )
  })

  it('an identical row is held at ANY stamp, including 0; an absent row never is', () => {
    fc.assert(
      fc.property(rowArb, row => {
        expect(localHoldsStagedRow({ ...row }, row)).toBe(true)
        expect(localHoldsStagedRow(null, row)).toBe(false)
        expect(localHoldsStagedRow(undefined, row)).toBe(false)
      }),
      fuzzParams(100),
    )
  })
})

describe('blocksAlreadyReflects', () => {
  it('agrees exactly with a reference written from the clear/sealed/vouch/tombstone contract', () => {
    fc.assert(
      fc.property(rowPairArb, ({ local, staged }) => {
        const l = asReflectsLocal(local)
        expect(blocksAlreadyReflects(staged, l)).toBe(referenceReflects(staged, l))
      }),
      fuzzParams(400),
    )
  })

  it('soundness: localHoldsStagedRow ⟹ blocksAlreadyReflects (no gap reported for a drain no-op)', () => {
    fc.assert(
      fc.property(rowPairArb, ({ local, staged }) => {
        if (localHoldsStagedRow(local, staged)) {
          expect(blocksAlreadyReflects(staged, asReflectsLocal(local))).toBe(true)
        }
      }),
      fuzzParams(400),
    )
  })

  it('a divergent CLEAR column is never reflected, unless the tombstone arm applies', () => {
    fc.assert(
      fc.property(rowPairArb, ({ local, staged }) => {
        const l = asReflectsLocal(local)
        fc.pre(l !== undefined && CLEAR.some(c => l[c] !== staged[c]))
        const tombstoneArm = staged.deleted === 1 && l!.deleted === 1
        expect(blocksAlreadyReflects(staged, l)).toBe(tombstoneArm)
      }),
      fuzzParams(400),
    )
  })

  it('a stamp-0 local row only reflects when the sealed columns match too; a nonzero stamp vouches', () => {
    fc.assert(
      fc.property(rowPairArb, ({ local, staged }) => {
        const l = asReflectsLocal(local)
        fc.pre(l !== undefined && sameOn(CLEAR, l, staged) && !sameOn(SEALED, l, staged))
        fc.pre(!(staged.deleted === 1 && l!.deleted === 1))
        expect(blocksAlreadyReflects(staged, l)).toBe(l!.updated_at !== 0)
      }),
      fuzzParams(400),
    )
  })

  it('the tombstone arm: a staged tombstone is reflected over an absent or tombstoned local, never over a live one by that arm', () => {
    fc.assert(
      fc.property(rowArb, rowArb, (a, b) => {
        const staged: BlockRow = { ...a, deleted: 1 }
        expect(blocksAlreadyReflects(staged, undefined)).toBe(true)
        expect(blocksAlreadyReflects(staged, { ...b, deleted: 1 })).toBe(true)
        // Absent local and a LIVE staged row is a gap.
        expect(blocksAlreadyReflects({ ...a, deleted: 0 }, undefined)).toBe(false)
      }),
      fuzzParams(100),
    )
  })
})

// ──── Section 3: sequence/model property ────

/** The modelled slice of a row. Everything else is held constant. */
interface ModelRow {
  readonly updated_at: number
  readonly content: string
  readonly user_updated_at: number
}

const toBlockRow = (m: ModelRow): BlockRow => ({
  id: 'b1',
  workspace_id: 'w1',
  parent_id: null,
  order_key: 'a0',
  content: m.content,
  properties_json: '{}',
  references_json: '[]',
  created_at: 0,
  updated_at: m.updated_at,
  user_updated_at: m.user_updated_at,
  created_by: 'u1',
  updated_by: 'u1',
  deleted: 0,
})

const sameModelRow = (a: ModelRow, b: ModelRow): boolean =>
  a.updated_at === b.updated_at && a.content === b.content && a.user_updated_at === b.user_updated_at

type ModelEvent =
  /** Deliver the current server row as a staging row and run the drain step. */
  | { readonly type: 'delivery' }
  /** A local edit: local row changes and goes into the (unsent) upload queue. */
  | { readonly type: 'localEdit' }
  /** Another writer changes content server-side: floor + bump on the stamp. */
  | { readonly type: 'serverContentChange'; readonly drift: number }
  /** A metadata-only server write: floor, no bump, no content change. */
  | { readonly type: 'serverMetaChange'; readonly drift: number }
  /** The pending local edit's upload lands (content-changing, floor + bump),
   *  clears pending, and its echo is delivered immediately. */
  | { readonly type: 'uploadAck'; readonly drift: number }
  /** The #1163 shape: the server row's columns change while its `updated_at`
   *  lands EXACTLY on the stamp the local row holds — a peer write on this
   *  device's stamp, or an author's un-drifted ack below its own local stamp. */
  | { readonly type: 'serverWriteOnLocalStamp'; readonly content: boolean; readonly userStamp: boolean }
  /** Deliver a RECORDED PAST server row (rescan / delayed round-trip). */
  | { readonly type: 'deliverStale'; readonly pick: number }

const driftArb = fc.integer({ min: -5, max: 5 })

const eventArb: fc.Arbitrary<ModelEvent> = fc.oneof(
  { arbitrary: fc.record({ type: fc.constant('delivery' as const) }), weight: 4 },
  { arbitrary: fc.record({ type: fc.constant('localEdit' as const) }), weight: 2 },
  {
    arbitrary: fc.record({ type: fc.constant('serverContentChange' as const), drift: driftArb }),
    weight: 2,
  },
  {
    arbitrary: fc.record({ type: fc.constant('serverMetaChange' as const), drift: driftArb }),
    weight: 2,
  },
  {
    arbitrary: fc.record({ type: fc.constant('uploadAck' as const), drift: driftArb }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      type: fc.constant('serverWriteOnLocalStamp' as const),
      content: fc.boolean(),
      userStamp: fc.boolean(),
    }),
    weight: 3,
  },
  { arbitrary: fc.record({ type: fc.constant('deliverStale' as const), pick: fc.nat() }), weight: 2 },
)

/**
 * Run one random event stream for a single block id: a fake server row
 * (floor+bump clamp on `updated_at`, mirroring `blocks_clamp_updated_at`)
 * against a local row, with the drain's per-row step as the delivery:
 * `decideStagingRow` (pending → skip), then `localHoldsStagedRow` (identical →
 * no write), else local := staged.
 *
 * Invariants checked inline at every delivery:
 *  - a pending edit leaves local untouched;
 *  - otherwise the drain's no-op test says "held" exactly when every modelled
 *    column already matches (an equal stamp with other columns differing is
 *    NOT held — #1163), and afterwards local equals the delivered row;
 *  - re-delivering that row at once is a no-op (held), at any stamp including 0.
 * After the stream ends and any pending upload drains, one delivery makes
 * local equal the server on every modelled column, and re-delivering the
 * converged row stays a no-op forever.
 *
 * Deliberately NOT asserted: "a delivery never applies a row strictly older
 * than local." There is no strictly-newer-local protection (see
 * `decideStagingRow`): an older, non-pending delivery still applies, a
 * transient revert the echo re-asserts. `deliverStale` makes that region
 * reachable in the sequence dimension; `deliver()`'s checks are a function of
 * the delivered row, not of its being current, so they apply to it unchanged.
 */
const runModel = (
  materializability: Materializability,
  start: ModelRow,
  events: readonly ModelEvent[],
): void => {
  let server: ModelRow = start
  let local: ModelRow = start
  let pending = false
  let seq = 0
  const history: ModelRow[] = [start]
  const setServer = (next: ModelRow): void => {
    server = next
    history.push(next)
  }
  const fresh = (prefix: string): string => `${prefix}${++seq}`

  const deliver = (staged: ModelRow = server): void => {
    const action = decideStagingRow(materializability, { hasPendingUpload: pending })
    expect(action.kind).not.toBe('defer') // fixed non-defer for this model
    if (action.kind === 'skip-stale') {
      expect(pending).toBe(true)
      return
    }
    const held = localHoldsStagedRow(toBlockRow(local), toBlockRow(staged))
    expect(held).toBe(sameModelRow(local, staged))
    if (!held) local = staged
    expect(sameModelRow(local, staged)).toBe(true)
    // Immediate re-delivery of the same row writes nothing, at any stamp.
    expect(localHoldsStagedRow(toBlockRow(local), toBlockRow(staged))).toBe(true)
  }

  const contentChange = (drift: number, content: string, userStamp: number): void => {
    const candidate = server.updated_at + drift
    setServer({
      updated_at: Math.max(candidate, server.updated_at + 1),
      content,
      user_updated_at: userStamp,
    })
  }

  for (const ev of events) {
    switch (ev.type) {
      case 'delivery':
        deliver()
        break
      case 'localEdit':
        local = {
          updated_at: local.updated_at + 1,
          content: fresh('local'),
          user_updated_at: local.user_updated_at + 1,
        }
        pending = true
        break
      case 'serverContentChange':
        contentChange(ev.drift, fresh('srv'), server.user_updated_at + 1)
        break
      case 'serverMetaChange':
        setServer({ ...server, updated_at: Math.max(server.updated_at + ev.drift, server.updated_at) })
        break
      case 'uploadAck':
        // The upload carries the local edit's content when there is one.
        contentChange(
          ev.drift,
          pending ? local.content : fresh('srv'),
          pending ? local.user_updated_at : server.user_updated_at + 1,
        )
        pending = false
        deliver()
        break
      case 'serverWriteOnLocalStamp':
        setServer({
          updated_at: local.updated_at,
          content: ev.content ? fresh('peer') : server.content,
          user_updated_at: ev.userStamp ? server.user_updated_at + 1 : server.user_updated_at,
        })
        break
      case 'deliverStale':
        deliver(history[ev.pick % history.length]!)
        break
    }
  }

  // ── Drain phase: flush any still-pending edit, then check convergence. ──
  if (pending) {
    contentChange(0, local.content, local.user_updated_at)
    pending = false
  }
  deliver()
  expect(local).toEqual(server)

  // No oscillation: the converged row is a no-op forever, stamp 0 included.
  for (let i = 0; i < 3; i++) {
    expect(decideStagingRow(materializability, { hasPendingUpload: false }).kind).toBe('apply')
    expect(localHoldsStagedRow(toBlockRow(local), toBlockRow(server))).toBe(true)
  }
}

describe('drain step: sequence model', () => {
  // Generous timeout: smoke stays well under it, but a FUZZ_TIME_MS deep run
  // can legitimately run past vitest's 5s default (see src/test/fuzz.ts).
  it(
    'random event streams converge to the server row and re-delivery is a no-op',
    () => {
      fc.assert(
        fc.property(
          materializableArb,
          fc.record({
            updated_at: fc.constantFrom(0, 1, 2),
            content: fc.constantFrom('init', 'other'),
            user_updated_at: fc.constantFrom(0, 1),
          }),
          fc.array(eventArb, { minLength: 0, maxLength: 60 }),
          (materializability, start, events) => {
            runModel(materializability, start, events)
          },
        ),
        fuzzParams(150),
      )
    },
    fuzzTestTimeout(),
  )
})
