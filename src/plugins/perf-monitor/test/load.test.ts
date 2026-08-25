// @vitest-environment node
/**
 * Reading the series back. Two invariants, both of which fail silently rather
 * than loudly if broken: the derived container id must agree with the one the
 * recorder actually wrote under, and the read must not CREATE that container.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { User } from '@/data/api'
import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets'
import {
  interactionMetricsUIStateType,
  interactionRecordProp,
  interactionRecordType,
  resetInteractionSessions,
  writeInteractionSample,
  type InteractionRecordData,
} from '@/plugins/interaction-metrics/record'
import { loadRecords } from '../load'

const WS = 'ws-1'
const USER: User = { id: 'user-1', name: 'Alice' }
const PATH = '$.interactionRecord'

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  resetInteractionSessions()
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

const blockCount = async (): Promise<number> =>
  (await sharedDb.db.getAll<{ n: number }>('SELECT COUNT(*) AS n FROM blocks'))[0].n

describe('loadRecords', () => {
  // Pins the derived container id against the `ensure` chain the recorder uses.
  // If those drift, the reader silently returns nothing and every verdict
  // becomes "building a baseline" forever.
  it('finds what the recorder wrote', async () => {
    await writeInteractionSample(repo, WS)
    const records = await loadRecords<InteractionRecordData>(
      repo, WS, interactionMetricsUIStateType.id, PATH,
    )
    expect(records).toHaveLength(1)
    expect(records[0].record.clientId).toBeTruthy()
    expect(records[0].id).toBeTruthy()
  })

  // A reader that used `getPluginUIStateBlock` would mint the whole ui-state
  // subtree as a side effect of finding out it is empty -- on every session, in
  // every workspace, including ones where the recorders are switched off.
  it('creates nothing when there is no history', async () => {
    const before = await blockCount()
    const records = await loadRecords(repo, WS, interactionMetricsUIStateType.id, PATH)
    expect(records).toEqual([])
    expect(await blockCount()).toBe(before)
  })

  it('returns newest first', async () => {
    await writeInteractionSample(repo, WS)
    resetInteractionSessions() // simulate a second page session
    await writeInteractionSample(repo, WS)
    const records = await loadRecords<InteractionRecordData>(
      repo, WS, interactionMetricsUIStateType.id, PATH,
    )
    expect(records).toHaveLength(2)
    expect(records[0].record.recordedAt).toBeGreaterThanOrEqual(records[1].record.recordedAt)
  })
})
