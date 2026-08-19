// @vitest-environment node
/**
 * Fuzz suite for the two pure upload-queue transforms in `powersync.ts` —
 * `compactBlockCrudEntries` (~powersync.ts:211) and `orderedBlockUpserts`
 * (~powersync.ts:300), exported for tests as `__compactBlockCrudEntriesForTest`
 * / `__orderedBlockUpsertsForTest`. See `src/test/fuzz.ts` for the
 * smoke/deep tier mechanics and `docs/fuzzing.md` for conventions.
 *
 * ## `orderedBlockUpserts` (topological create-order for a batch of rows)
 *
 * The function is a post-order DFS over the `parent_id` functional graph
 * (powersync.ts:305-316): `visit(row)` recurses into the parent *before*
 * pushing `row`, so a resolved parent is always pushed before its child —
 * except the cycle guard (`if (current === 'visiting') return`,
 * powersync.ts:308) short-circuits a re-entrant visit of a node already on
 * the current DFS stack. For a cycle of size 1 (self-loop, `parent_id ===
 * id`) that guard fires immediately and the row is pushed like any
 * childless row — no violation. For a cycle of size k>=2, exactly one
 * internal edge is broken: whichever node is reached *first* by the overall
 * traversal (a "top-level" row in input order, or an external row whose
 * parent chain leads in) becomes the entry point; every other cycle member
 * is fully resolved (pushed) before the DFS unwinds back to the entry, and
 * the entry itself is pushed last. So among the k parent-edges internal to
 * the cycle, exactly k-1 satisfy "parent before child" and exactly 1
 * (the edge whose target is the entry point) does not — proved by
 * hand-tracing both a plain cycle and a cycle reached through an external
 * predecessor (see the property below for the derivation). This is the
 * "exact guarantee for cycle members" the property encodes, rather than
 * asserting a specific relative order among cycle members (which depends on
 * input order and isn't part of the function's contract).
 *
 * Oracles:
 *  - Permutation: output has the same length and the same set of row
 *    *references* as the input (no row invented, dropped, or copied).
 *  - Non-cycle edges: for every row R whose `parent_id` resolves to another
 *    row P in the batch, if R and P are not members of the same cycle, P
 *    appears before R.
 *  - Cycle edges: for every cycle of size >= 2, exactly one of its internal
 *    edges is reversed (see derivation above). Size-1 self-loops are
 *    excluded (vacuous — the only "edge" is a row pointing at itself).
 *  - Never throws (implicit: the property calls the function unguarded, so
 *    a thrown error or a stack overflow from infinite recursion — which the
 *    cycle guard is specifically there to prevent — fails the property).
 *
 * ## `compactBlockCrudEntries` (collapse a raw CRUD log to one op per id)
 *
 * Oracles:
 *  - Differential replay: applying the compacted ops (in emitted order)
 *    to an empty per-id column map yields the same final per-id state
 *    (absent / deleted / columns) as applying the raw entries (in order)
 *    to the same kind of map, using PUT = full replace, PATCH = column
 *    merge (dropped as a no-op if the id was deleted with no intervening
 *    PUT — powersync.ts:240), DELETE = clear (powersync.ts:268-277).
 *    This oracle is scoped to inputs where entries sharing a
 *    `transactionId` are *contiguous* — the real precondition established
 *    by the call sites (`transactions.flatMap(t => t.crud)` /
 *    `transaction.crud`, powersync.ts:638/672): `getCrudTransactions()`'s
 *    recursive-CTE iterator (`@powersync/common`) can only ever yield a
 *    `CrudTransaction` whose `.crud` entries share one `tx_id`, and
 *    successive transactions get strictly increasing, never-reused ids —
 *    so a later entry can never legitimately share a `transactionId` with
 *    an *earlier, already-closed* run. Feeding the function a
 *    non-contiguous same-tx pattern (e.g. tx1, tx2, tx1) is off the
 *    function's real domain and — because the same-tx PATCH-fusion branch
 *    keys purely off `entry.transactionId` regardless of position — can
 *    make a chronologically-later cross-tx PATCH lose to a
 *    chronologically-earlier same-tx one at the value level (fusion bakes
 *    into `create`, which the two-phase apply in
 *    `applyCompactedBlockOperations` always ships before `patch`,
 *    powersync.ts:421-428). That's not reachable from real callers, so the
 *    replay oracle only runs over contiguous-transaction batches.
 *  - Same-tx PATCH fusion: a PATCH sharing its create's `transactionId`
 *    never survives as a separate `patch` op (powersync.ts:246-256) — for
 *    a single id touched by one PUT followed only by same-tx PATCHes, the
 *    compacted output is exactly one `create` op with all columns merged.
 *  - DELETE cancellation: a DELETE clears any prior create/patch state for
 *    that id (powersync.ts:268-277) — for a single id touched by an
 *    arbitrary create/patch prefix followed by a DELETE as the last touch,
 *    the compacted output is exactly one `delete` op.
 *  - First-appearance order preserved (powersync.ts:226-297): the `order`
 *    field driving the final sort is the position of the row's most recent
 *    PUT if any occurred, else the position of its first touch, reset by
 *    any DELETE to the DELETE's own position. Verified against an
 *    independent derivation of that same rule from the raw entry sequence.
 *  - Non-`blocks` table entries throw the documented `Error` immediately
 *    (powersync.ts:215-217), never a different failure mode.
 */
import { CrudEntry, UpdateType } from '@powersync/common'
import { describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { fuzzParams } from '@/test/fuzz'

const supabaseRef = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
}))

vi.mock('@/services/supabase.js', () => ({
  supabase: supabaseRef,
  hasSupabaseAuthConfig: true,
}))

import {
  __compactBlockCrudEntriesForTest,
  __orderedBlockUpsertsForTest,
  type CompactedBlockOperation,
} from './powersync'

// ──── Shared generators ────

const idPool = ['blk-a', 'blk-b', 'blk-c'] as const
const columnKeys = ['content', 'order_key', 'updated_at', 'workspace_id', 'flag'] as const

const columnValueArb = fc.oneof(
  fc.string({maxLength: 6}),
  fc.integer({min: -1000, max: 1000}),
  fc.boolean(),
  fc.constant(null),
)

const opDataArb = fc.dictionary(fc.constantFrom(...columnKeys), columnValueArb, {maxKeys: columnKeys.length})

const put = (id: string, data: Record<string, unknown>, txId: number, clientId = 0) =>
  new CrudEntry(clientId, UpdateType.PUT, 'blocks', id, txId, data)
const patch = (id: string, data: Record<string, unknown>, txId: number, clientId = 0) =>
  new CrudEntry(clientId, UpdateType.PATCH, 'blocks', id, txId, data)
const del = (id: string, txId: number, clientId = 0) =>
  new CrudEntry(clientId, UpdateType.DELETE, 'blocks', id, txId)

// ──────────────────────────────────────────────────────────────────────
// orderedBlockUpserts
// ──────────────────────────────────────────────────────────────────────

type Row = {id: string; parent_id: string | null}

const idsArb = fc.uniqueArray(fc.constantFrom(...idPool), {maxLength: idPool.length})
const parentArb = fc.constantFrom<string | null>(...idPool, null, 'external-id')
const rowsArb: fc.Arbitrary<Row[]> = idsArb.chain(ids =>
  ids.length === 0
    ? fc.constant([])
    : fc.tuple(...ids.map(() => parentArb)).map(parents => ids.map((id, i) => ({id, parent_id: parents[i]}))),
)

/** Independent cycle detector for the `parent_id` functional graph: follow
 *  each row's parent chain (through the batch's own ids only) until it
 *  terminates (no resolvable parent) or revisits a node already on the
 *  current chain, in which case every node from that repeat point onward is
 *  a member of one cycle. Assigns each detected cycle a distinct group id
 *  so multiple disjoint cycles in one batch can be told apart. This is a
 *  standard functional-graph cycle check, computed independently of
 *  `orderedBlockUpserts`'s own push order — it only establishes set
 *  membership, never an ordering. */
const detectCycleGroups = (rows: readonly Row[]): Map<string, number> => {
  const byId = new Map(rows.map(r => [r.id, r]))
  const parentOf = (id: string): string | undefined => {
    const row = byId.get(id)
    if (!row) return undefined
    return typeof row.parent_id === 'string' && byId.has(row.parent_id) ? row.parent_id : undefined
  }

  const groupOf = new Map<string, number>()
  let nextGroup = 0
  for (const row of rows) {
    if (groupOf.has(row.id)) continue
    const path: string[] = []
    const posInPath = new Map<string, number>()
    let cur: string | undefined = row.id
    while (cur !== undefined && !posInPath.has(cur)) {
      posInPath.set(cur, path.length)
      path.push(cur)
      cur = parentOf(cur)
    }
    if (cur !== undefined) {
      const startIdx = posInPath.get(cur)!
      const group = nextGroup++
      for (let i = startIdx; i < path.length; i++) groupOf.set(path[i], group)
    }
  }
  return groupOf
}

describe('orderedBlockUpserts', () => {
  it('is a permutation; non-cycle parents precede children; exactly one reversed edge per cycle (size >= 2)', () => {
    fc.assert(
      fc.property(rowsArb, rows => {
        const ordered = __orderedBlockUpsertsForTest(rows)

        // Permutation: same size, same set of row *references* (not copies).
        expect(ordered.length).toBe(rows.length)
        const orderedSet = new Set(ordered)
        expect(orderedSet.size).toBe(rows.length)
        for (const row of rows) expect(orderedSet.has(row)).toBe(true)
        expect([...ordered].map(r => r.id).sort()).toEqual([...rows].map(r => r.id).sort())

        const byId = new Map(rows.map(r => [r.id, r]))
        const indexOf = new Map(ordered.map((r, i) => [r.id, i]))
        const cycleGroup = detectCycleGroups(rows)

        const violationsByGroup = new Map<number, number>()
        for (const row of rows) {
          const parentId = typeof row.parent_id === 'string' ? row.parent_id : undefined
          if (parentId === undefined || parentId === row.id) continue // no edge, or vacuous self-loop
          if (!byId.has(parentId)) continue // external parent -- no ordering constraint
          const reversed = indexOf.get(parentId)! > indexOf.get(row.id)!
          const sameCycle = cycleGroup.has(row.id) && cycleGroup.get(row.id) === cycleGroup.get(parentId)
          if (!sameCycle) {
            expect(reversed).toBe(false)
          } else {
            const g = cycleGroup.get(row.id)!
            violationsByGroup.set(g, (violationsByGroup.get(g) ?? 0) + (reversed ? 1 : 0))
          }
        }
        for (const count of violationsByGroup.values()) expect(count).toBe(1)
      }),
      fuzzParams(200),
    )
  })
})

// ──────────────────────────────────────────────────────────────────────
// compactBlockCrudEntries
// ──────────────────────────────────────────────────────────────────────

type RawStatus = 'untouched' | 'deleted' | 'exists'
type RawState = {status: RawStatus; columns?: Record<string, unknown>}

const UNTOUCHED: RawState = {status: 'untouched'}

/** Black-box per-id state transition mirroring the DB-level contract (see
 *  docblock): PUT replaces, PATCH merges (no-op once deleted), DELETE
 *  clears. */
const applyRawOp = (
  state: RawState,
  op: UpdateType,
  id: string,
  opData: Record<string, unknown> | undefined,
): RawState => {
  if (op === UpdateType.PUT) return {status: 'exists', columns: {...(opData ?? {}), id}}
  if (op === UpdateType.PATCH) {
    if (state.status === 'deleted') return state // dropped -- powersync.ts:240
    return {status: 'exists', columns: {...(state.columns ?? {}), ...(opData ?? {})}}
  }
  return {status: 'deleted'} // DELETE
}

const replayRaw = (
  stubs: readonly {op: UpdateType; id: string; opData: Record<string, unknown>}[],
): Map<string, RawState> => {
  const byId = new Map<string, RawState>()
  for (const s of stubs) {
    byId.set(s.id, applyRawOp(byId.get(s.id) ?? UNTOUCHED, s.op, s.id, s.opData))
  }
  return byId
}

const replayCompacted = (ops: readonly CompactedBlockOperation[]): Map<string, RawState> => {
  const byId = new Map<string, RawState>()
  for (const op of ops) {
    if (op.kind === 'create') {
      byId.set(op.id, {status: 'exists', columns: {...op.payload}})
    } else if (op.kind === 'patch') {
      const current = byId.get(op.id) ?? UNTOUCHED
      byId.set(op.id, {status: 'exists', columns: {...(current.columns ?? {}), ...op.payload}})
    } else {
      byId.set(op.id, {status: 'deleted'})
    }
  }
  return byId
}

/** Position-only re-derivation of the `order` bookkeeping in
 *  `compactBlockCrudEntries` (powersync.ts:226-297): PUT resets the anchor
 *  to its own index; PATCH keeps the existing anchor (or takes its own
 *  index if untouched), unless the id is currently deleted, in which case
 *  it's dropped and the anchor is untouched; DELETE always resets the
 *  anchor to its own index. Independent of `opData`/payload logic entirely
 *  — this checks only the ordering contract, not fusion or replay
 *  correctness (those have their own oracles above/below). */
const computeExpectedOrder = (
  stubs: readonly {op: UpdateType; id: string}[],
): Map<string, number> => {
  const anchor = new Map<string, {order: number; deleted: boolean}>()
  stubs.forEach((s, idx) => {
    if (s.op === UpdateType.PUT) {
      anchor.set(s.id, {order: idx, deleted: false})
    } else if (s.op === UpdateType.PATCH) {
      const existing = anchor.get(s.id)
      if (existing?.deleted) return
      anchor.set(s.id, {order: existing?.order ?? idx, deleted: false})
    } else {
      anchor.set(s.id, {order: idx, deleted: true})
    }
  })
  return new Map([...anchor].map(([id, a]) => [id, a.order]))
}

// Contiguous-transaction generator for the differential-replay oracle: each
// "transaction group" gets its own unique, monotonically increasing
// transactionId and contributes a contiguous run of entries (possibly
// touching several distinct ids, mirroring a repo.tx that edits several
// blocks) -- matching the real precondition established by the call sites
// (see docblock).
const groupEntryArb = fc.record({
  op: fc.constantFrom(UpdateType.PUT, UpdateType.PATCH, UpdateType.DELETE),
  id: fc.constantFrom(...idPool),
  opData: opDataArb,
})
const txGroupArb = fc.array(groupEntryArb, {minLength: 1, maxLength: 4})
const contiguousStubsArb = fc.array(txGroupArb, {minLength: 0, maxLength: 5}).map(groups =>
  groups.flatMap((group, groupIdx) => group.map(e => ({...e, transactionId: groupIdx + 1}))),
)

// Free-form generator (no contiguity constraint) for the oracles that hold
// unconditionally regardless of transaction interleaving: ordering,
// never-throws, and the table-guard.
const freeEntryArb = fc.record({
  op: fc.constantFrom(UpdateType.PUT, UpdateType.PATCH, UpdateType.DELETE),
  id: fc.constantFrom(...idPool),
  transactionId: fc.constantFrom(1, 2, 3),
  opData: opDataArb,
})
const freeStubsArb = fc.array(freeEntryArb, {minLength: 0, maxLength: 15})

const toCrudEntries = (
  stubs: readonly {op: UpdateType; id: string; transactionId: number; opData: Record<string, unknown>}[],
): CrudEntry[] => stubs.map((s, i) => new CrudEntry(i, s.op, 'blocks', s.id, s.transactionId, s.opData))

describe('compactBlockCrudEntries', () => {
  it('differential replay: compacted ops and raw entries reach the same per-id final state (contiguous-tx batches)', () => {
    fc.assert(
      fc.property(contiguousStubsArb, stubs => {
        const operations = __compactBlockCrudEntriesForTest(toCrudEntries(stubs))

        const rawFinal = replayRaw(stubs)
        const compactedFinal = replayCompacted(operations)

        const allIds = new Set([...rawFinal.keys(), ...compactedFinal.keys()])
        for (const id of allIds) {
          const raw = rawFinal.get(id) ?? UNTOUCHED
          const compacted = compactedFinal.get(id) ?? UNTOUCHED
          expect(compacted.status).toBe(raw.status)
          if (raw.status === 'exists') {
            expect(compacted.columns).toEqual(raw.columns)
          }
        }
      }),
      fuzzParams(150),
    )
  })

  it('same-tx PATCH fusion: PUT + only same-tx PATCHes for one id compacts to a single create op', () => {
    fc.assert(
      fc.property(
        fc.record({
          id: fc.constantFrom(...idPool),
          txId: fc.integer({min: 1, max: 1000}),
          putData: opDataArb,
          patches: fc.array(opDataArb, {minLength: 0, maxLength: 4}),
        }),
        ({id, txId, putData, patches}) => {
          const entries = [
            put(id, putData, txId),
            ...patches.map(p => patch(id, p, txId)),
          ]
          const operations = __compactBlockCrudEntriesForTest(entries)

          expect(operations).toHaveLength(1)
          const [op] = operations
          expect(op.kind).toBe('create')
          expect(op.id).toBe(id)
          expect(op.order).toBe(0)
          const expectedPayload = patches.reduce(
            (acc, p) => ({...acc, ...p}),
            {...putData, id},
          )
          expect((op as {payload: Record<string, unknown>}).payload).toEqual(expectedPayload)
        },
      ),
      fuzzParams(120),
    )
  })

  it('DELETE cancellation: any create/patch prefix for one id followed by a DELETE compacts to a single delete op', () => {
    fc.assert(
      fc.property(
        fc.record({
          id: fc.constantFrom(...idPool),
          prefix: fc.array(
            fc.record({
              isPut: fc.boolean(),
              txId: fc.integer({min: 1, max: 1000}),
              data: opDataArb,
            }),
            {minLength: 0, maxLength: 4},
          ),
          deleteTx: fc.integer({min: 1, max: 1000}),
        }),
        ({id, prefix, deleteTx}) => {
          const entries = [
            ...prefix.map(p => (p.isPut ? put(id, p.data, p.txId) : patch(id, p.data, p.txId))),
            del(id, deleteTx),
          ]
          const operations = __compactBlockCrudEntriesForTest(entries)

          expect(operations).toHaveLength(1)
          const [op] = operations
          expect(op.kind).toBe('delete')
          expect(op.id).toBe(id)
          expect(op.order).toBe(entries.length - 1)
        },
      ),
      fuzzParams(120),
    )
  })

  it('order: the sort key equals the independently-derived first-appearance/most-recent-PUT anchor', () => {
    fc.assert(
      fc.property(freeStubsArb, stubs => {
        const operations = __compactBlockCrudEntriesForTest(toCrudEntries(stubs))
        const expected = computeExpectedOrder(stubs)

        for (const op of operations) {
          expect(op.order).toBe(expected.get(op.id))
        }
        // The output is sorted by `order` (the function's own contract).
        for (let i = 1; i < operations.length; i++) {
          expect(operations[i].order).toBeGreaterThanOrEqual(operations[i - 1].order)
        }
      }),
      fuzzParams(150),
    )
  })

  it('never throws (or hangs) on well-formed "blocks" entries', () => {
    fc.assert(
      fc.property(freeStubsArb, stubs => {
        expect(() => __compactBlockCrudEntriesForTest(toCrudEntries(stubs))).not.toThrow()
      }),
      fuzzParams(150),
    )
  })

  it('a non-"blocks" table entry throws the documented Error immediately (powersync.ts:215-217)', () => {
    const tableArb = fc.oneof(
      {arbitrary: fc.constant('blocks'), weight: 6},
      {arbitrary: fc.string({minLength: 1, maxLength: 8}).filter(s => s !== 'blocks'), weight: 2},
    )
    const entryWithTableArb = fc.record({
      op: fc.constantFrom(UpdateType.PUT, UpdateType.PATCH, UpdateType.DELETE),
      id: fc.constantFrom(...idPool),
      table: tableArb,
      transactionId: fc.constantFrom(1, 2, 3),
      opData: opDataArb,
    })
    const stubsWithBadTableArb = fc
      .array(entryWithTableArb, {minLength: 1, maxLength: 10})
      .filter(stubs => stubs.some(s => s.table !== 'blocks'))

    fc.assert(
      fc.property(stubsWithBadTableArb, stubs => {
        const entries = stubs.map((s, i) => new CrudEntry(i, s.op, s.table, s.id, s.transactionId, s.opData))
        let thrown: unknown
        try {
          __compactBlockCrudEntriesForTest(entries)
        } catch (e) {
          thrown = e
        }
        expect(thrown).toBeInstanceOf(Error)
        expect((thrown as Error).message).toMatch(/^Unsupported table in upload queue: /)
      }),
      fuzzParams(120),
    )
  })
})
