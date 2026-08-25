// @vitest-environment node
/**
 * The shared record-store write path, and the two ways its retention pass can
 * reach past what it is allowed to touch: deleting a row that stopped being
 * telemetry while the pass was awaiting, and reporting a committed record as
 * failed because the cleanup after it threw.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { resetClientIdCache } from '@/utils/clientId'
import { type User } from '@/data/api'
import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets'
import {
  interactionMetricsUIStateType,
  interactionRecordProp,
  interactionRecordType,
  type InteractionRecordData,
} from '../record'
import { appendClientRecord, clientGroupId, type ClientRecordSpec } from '../recordStore'

const WS = 'ws-1'
const USER: User = { id: 'user-1', name: 'Alice' }

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  resetClientIdCache()
  repo = createTestRepo({
    db: sharedDb.db,
    user: USER,
    extensions: [
      definitionSeedsFacet.of(interactionRecordProp, { source: 'test' }),
      typeSeedsFacet.of(interactionRecordType, { source: 'test' }),
    ],
  }).repo
  repo.setActiveWorkspaceId(WS)
})
afterEach(() => { vi.restoreAllMocks() })

const DATA = {
  recordedAt: 1, startedAt: 0, appVersion: 'v', appSha: 'sha', clientId: 'c',
  deviceLabel: 'd', sessionMs: 1, blockCount: 1, writes: 1,
  queries: {}, fanout: {}, db: {},
  handles: { count: 0, totalDeps: 0, maxDeps: 0, p50Deps: 0, p95Deps: 0, topHeavy: [] },
} satisfies InteractionRecordData

const spec = (retain: number): ClientRecordSpec => ({
  workspaceId: WS,
  containerType: interactionMetricsUIStateType,
  recordType: interactionRecordType,
  description: 'test metrics record',
  retain,
  recordName: interactionRecordProp.name,
  content: 'record',
  setProperty: async (tx, id) => {
    await tx.setProperty(id, interactionRecordProp, DATA, { skipMetadata: true })
  },
})

const append = (retain: number) => appendClientRecord(repo, repo.tx.bind(repo), spec(retain))

const liveIds = async (): Promise<string[]> =>
  (await sharedDb.db.getAll<{ id: string }>(
    'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key',
    [clientGroupId(repo, WS, interactionMetricsUIStateType)],
  )).map((r) => r.id)

/** Run `during` as the retention transaction is entered — the window between
 *  the pass selecting its rows and it obtaining the write lock. */
const duringRetention = (during: () => Promise<void>): void => {
  const realTx = repo.tx.bind(repo)
  vi.spyOn(repo, 'tx').mockImplementation(async (fn, opts) => {
    if (opts?.description?.endsWith('retention')) await during()
    return realTx(fn, opts)
  })
}

describe('appendClientRecord retention', () => {
  it('drops this client\'s own records past the bound', async () => {
    const ids: string[] = []
    for (let i = 0; i < 4; i++) ids.push((await append(1)).blockId)
    // Newest first, and the row just written is never a candidate: the bound
    // keeps `retain` older rows alongside it.
    expect(await liveIds()).toEqual([ids[3], ids[2]])
  })

  // These rows are deliberately hand-editable, and the selection is separated
  // from the deletion by an await. A row whose record was stripped in that
  // window — by a person, or by an edit synced in from another device — is user
  // content by the time the pass gets its lock.
  it('leaves a row alone when its record is stripped after selection', async () => {
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await append(3)).blockId)
    // Oldest, so it is squarely inside the set a retain of 1 selects.
    const victim = ids[0]
    duringRetention(async () => {
      await sharedDb.db.execute('UPDATE blocks SET properties_json = ? WHERE id = ?', ['{}', victim])
    })
    const fresh = (await append(1)).blockId

    const live = await liveIds()
    expect(live).toContain(victim)
    // Precondition: the pass really did delete, so a green result cannot mean
    // the deletion branch was never reached.
    expect(live).toEqual([fresh, ids[2], victim])
  })

  // The record is already committed when the pass runs. Routing its failure
  // through the caller's failure path retries a write that landed: the startup
  // recorder appends up to three records for one boot, and the interaction
  // recorder forgets the row it owns and opens a second.
  it('reports the committed record even when the retention pass throws', async () => {
    for (let i = 0; i < 3; i++) await append(3)
    const realTx = repo.tx.bind(repo)
    vi.spyOn(repo, 'tx').mockImplementation(async (fn, opts) => {
      if (opts?.description?.endsWith('retention')) throw new Error('prune failed')
      return realTx(fn, opts)
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { blockId } = await append(1)

    expect(await liveIds()).toContain(blockId)
    const stored = repo.block(blockId)
    await stored.load()
    expect(stored.peekProperty(interactionRecordProp)).toMatchObject({ appSha: 'sha' })
  })
})
