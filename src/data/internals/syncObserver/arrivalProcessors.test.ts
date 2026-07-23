import { describe, expect, it } from 'vitest'
import type { BlockData } from '@/data/api'
import type { TxDb } from '@/data/internals/txEngine.js'
import {
  runArrivalProcessors,
  type ArrivalProcessor,
} from './arrivalProcessors.ts'
import type { MaterializeDeps, SyncSnapshot } from './materialize.ts'

/**
 * Runner-level tests. The registered processor's own behavior is covered
 * end-to-end in `referenceTargetArrival.test.ts`; what's pinned HERE is the
 * runner's contract — which the seam's single member exercises only
 * incidentally, and which becomes load-bearing the moment a second member
 * lands.
 */

const block = (id: string, content: string): BlockData => ({
  id,
  workspaceId: 'ws',
  parentId: null,
  orderKey: 'a0',
  content,
  properties: {},
  references: [],
  createdAt: 0,
  updatedAt: 0,
  userUpdatedAt: null,
  createdBy: null,
  updatedBy: null,
  deleted: false,
  referenceTargetId: null,
} as unknown as BlockData)

/** Minimal TxDb whose `tx_context.source` answer the test controls — enough
 *  for the runner's invariant probe; processors here never touch real rows. */
const fakeTx = (sourceRef: {value: string | null}): TxDb => ({
  execute: async () => undefined,
  getAll: async () => [],
  get: async () => { throw new Error('not used') },
  getOptional: async (sql: string) =>
    (sql.includes('tx_context') ? {source: sourceRef.value} : null),
} as unknown as TxDb)

const deps = {} as MaterializeDeps

const snapshotsWith = (...ids: string[]): Map<string, SyncSnapshot> =>
  new Map(ids.map(id => [id, {before: null, after: block(id, id)}] as const))

describe('runArrivalProcessors', () => {
  it('refuses a processor that stamps tx_context.source', async () => {
    // The CRITICAL INVARIANT, enforced rather than documented: a stamped
    // source turns every later write in the window into an upload, echoing
    // sync-applied rows back to the server as fresh local edits. Silent at
    // runtime, so it has to fail loudly here — and OUTSIDE the per-row
    // quarantine, so it's fatal even though the stamp itself didn't throw.
    const source = {value: null as string | null}
    const offender: ArrivalProcessor = {
      name: 'test.stampsSource',
      prepare: async () => async () => { source.value = 'user' },
    }
    await expect(
      runArrivalProcessors(fakeTx(source), snapshotsWith('b1'), deps, [offender]),
    ).rejects.toThrow(/test\.stampsSource left tx_context\.source/)
  })

  it('accepts a processor that leaves the source alone, running its handler per row', async () => {
    const source = {value: null as string | null}
    let seen = 0
    const wellBehaved: ArrivalProcessor = {
      name: 'test.wellBehaved',
      prepare: async () => async () => { seen += 1 },
    }
    const quarantined = await runArrivalProcessors(
      fakeTx(source), snapshotsWith('b1', 'b2'), deps, [wellBehaved],
    )
    expect(seen).toBe(2)
    expect(quarantined).toEqual([])
  })

  it('quarantines a throwing row and still processes the rest', async () => {
    // A deterministic poison row must not abort the pass — else the whole
    // window rolls back, retries, and throws again, wedging the drain and
    // starving every row after it. The bad row is skipped and named; the
    // others run.
    const source = {value: null as string | null}
    const processed: string[] = []
    const processor: ArrivalProcessor = {
      name: 'test.throwsOnBad',
      prepare: async () => async (row) => {
        if (row.id === 'bad') throw new Error('boom')
        processed.push(row.id)
      },
    }
    const quarantined = await runArrivalProcessors(
      fakeTx(source), snapshotsWith('good1', 'bad', 'good2'), deps, [processor],
    )
    expect(processed).toEqual(['good1', 'good2'])
    expect(quarantined).toEqual(['bad'])
  })

  it('skips a processor whose prepare opts out, and does not even prepare when no rows remain', async () => {
    // prepare → null opts a processor out of the window (a dep is absent): the
    // opt-out decision happens in prepare, and NO per-row handler runs.
    const source = {value: null as string | null}
    let prepareCalls = 0
    let handlerCalls = 0
    const optOut: ArrivalProcessor = {
      name: 'test.optOut',
      prepare: async () => { prepareCalls += 1; return null },
    }
    await runArrivalProcessors(fakeTx(source), snapshotsWith('b1'), deps, [optOut])
    expect(prepareCalls).toBe(1)
    expect(handlerCalls).toBe(0)

    // `after: null` entries (the `removed` loop's) never reach a processor;
    // with only those present there are no rows, so prepare isn't even called.
    const removedOnly = new Map<string, SyncSnapshot>([
      ['gone', {before: block('gone', 'x'), after: null} as unknown as SyncSnapshot],
    ])
    let preparedForEmpty = false
    const neverPrepared: ArrivalProcessor = {
      name: 'test.neverPrepared',
      prepare: async () => { preparedForEmpty = true; return async () => { handlerCalls += 1 } },
    }
    await runArrivalProcessors(fakeTx(source), removedOnly, deps, [neverPrepared])
    expect(preparedForEmpty).toBe(false)
  })

  it('hands each processor the rows present when it runs, including earlier mutations', async () => {
    // The runner rebuilds `rows` per processor from the live snapshots map, so
    // a later member sees an earlier one's amendments. Nothing depends on this
    // with one member registered — pinning it now so the contract is a
    // decision rather than an accident when a second lands.
    const source = {value: null as string | null}
    const snapshots = snapshotsWith('b1')
    const first: ArrivalProcessor = {
      name: 'test.first',
      prepare: async () => async (_row, snaps) => {
        snaps.set('b1', {before: null, after: block('b1', 'rewritten')} as unknown as SyncSnapshot)
      },
    }
    let secondSaw = ''
    const second: ArrivalProcessor = {
      name: 'test.second',
      prepare: async () => async (row) => { secondSaw = row.after.content },
    }
    await runArrivalProcessors(fakeTx(source), snapshots, deps, [first, second])
    expect(secondSaw).toBe('rewritten')
  })
})
