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
    // runtime, so it has to fail loudly here.
    const source = {value: null as string | null}
    const offender: ArrivalProcessor = {
      name: 'test.stampsSource',
      apply: async () => { source.value = 'user' },
    }
    await expect(
      runArrivalProcessors(fakeTx(source), snapshotsWith('b1'), deps, [offender]),
    ).rejects.toThrow(/test\.stampsSource left tx_context\.source/)
  })

  it('accepts a processor that leaves the source alone', async () => {
    const source = {value: null as string | null}
    let seen = 0
    const wellBehaved: ArrivalProcessor = {
      name: 'test.wellBehaved',
      apply: async (rows) => { seen = rows.length },
    }
    await runArrivalProcessors(fakeTx(source), snapshotsWith('b1', 'b2'), deps, [wellBehaved])
    expect(seen).toBe(2)
  })

  it('skips rows whose arrival was a hard-delete, and runs nothing when none remain', async () => {
    // `after: null` entries are the `removed` loop's; they must never reach a
    // processor. With only those present there are no rows at all, so `apply`
    // must not be called — which is also what keeps a processor from having to
    // defend against an empty window itself.
    const source = {value: null as string | null}
    const snapshots = new Map<string, SyncSnapshot>([
      ['gone', {before: block('gone', 'x'), after: null} as unknown as SyncSnapshot],
    ])
    let called = false
    const processor: ArrivalProcessor = {
      name: 'test.neverCalled',
      apply: async () => { called = true },
    }
    await runArrivalProcessors(fakeTx(source), snapshots, deps, [processor])
    expect(called).toBe(false)
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
      apply: async (_rows, snaps) => {
        snaps.set('b1', {before: null, after: block('b1', 'rewritten')} as unknown as SyncSnapshot)
      },
    }
    let secondSaw = ''
    const second: ArrivalProcessor = {
      name: 'test.second',
      apply: async (rows) => { secondSaw = rows[0]!.after.content },
    }
    await runArrivalProcessors(fakeTx(source), snapshots, deps, [first, second])
    expect(secondSaw).toBe('rewritten')
  })
})
