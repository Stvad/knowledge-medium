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
  writeInteractionSample,
  type InteractionRecordData,
} from '@/plugins/interaction-metrics/record'
import { resetMetricsSession } from '@/plugins/interaction-metrics/sessionContext'
import {
  HISTORY_LIMIT,
  INTERACTION_RECORD_PATH,
  isUsableInteractionRecord,
  isUsableStartupRecord,
  loadRecords,
} from '../load'

const WS = 'ws-1'
const USER: User = { id: 'user-1', name: 'Alice' }
const PATH = INTERACTION_RECORD_PATH

let sharedDb: TestDb
let repo: Repo


beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  resetMetricsSession()
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
      repo, WS, interactionMetricsUIStateType.id, PATH, isUsableInteractionRecord)
    expect(records).toHaveLength(1)
    expect(records[0].record.clientId).toBeTruthy()
    expect(records[0].id).toBeTruthy()
  })

  // A reader that used `getPluginUIStateBlock` would mint the whole ui-state
  // subtree as a side effect of finding out it is empty -- on every session, in
  // every workspace, including ones where the recorders are switched off.
  it('creates nothing when there is no history', async () => {
    const before = await blockCount()
    const records = await loadRecords<InteractionRecordData>(
      repo, WS, interactionMetricsUIStateType.id, PATH, isUsableInteractionRecord,
    )
    expect(records).toEqual([])
    expect(await blockCount()).toBe(before)
  })

  // A row that parses but is missing what the comparison dereferences would
  // otherwise throw inside the analysis, killing it for the rest of the session
  // rather than costing one skipped sample.
  it('skips a record whose query samples are malformed', async () => {
    const blockId = (await writeInteractionSample(repo, WS))!
    await sharedDb.db.execute(
      `UPDATE blocks SET properties_json = json_set(properties_json, ?, json('{"bad":null}')) WHERE id = ?`,
      [`${PATH}.queries`, blockId],
    )
    const records = await loadRecords<InteractionRecordData>(
      repo, WS, interactionMetricsUIStateType.id, PATH, isUsableInteractionRecord,
    )
    expect(records).toEqual([])
  })

  // Marks stay optional, but a PRESENT one has to be finite: the comparison
  // subtracts them, and NaN takes neither the steady nor the regressed branch,
  // so one hand-edited row could publish a NaN comparison to the chip.
  it('rejects a startup record whose present marks are not finite', () => {
    expect(isUsableStartupRecord({ timeOriginMs: 1 })).toBe(true)
    expect(isUsableStartupRecord({ timeOriginMs: 1, repoReadyMs: 5 })).toBe(true)
    expect(isUsableStartupRecord({ timeOriginMs: 1, repoReadyMs: 'x' })).toBe(false)
    expect(isUsableStartupRecord({ timeOriginMs: 1, firstContentPaintMs: NaN })).toBe(false)
  })

  // Validation happens after the JSON parse, so a limit applied to ROWS lets
  // unreadable ones at the front of the window push real history out of reach —
  // and the monitor reports an insufficient baseline while the group holds
  // plenty of good records.
  it('looks past a window full of unreadable rows', async () => {
    const blockId = (await writeInteractionSample(repo, WS))!
    const parent = (await sharedDb.db.getAll<{ parent_id: string; order_key: string }>(
      'SELECT parent_id, order_key FROM blocks WHERE id = ?', [blockId],
    ))[0]
    // Uppercase keys sort before the real record's, so these occupy the front.
    for (let i = 0; i < HISTORY_LIMIT; i++) {
      await sharedDb.db.execute(
        `INSERT INTO blocks
           (id, workspace_id, parent_id, order_key, content, properties_json, deleted,
            created_at, updated_at, created_by, updated_by)
         VALUES (?, ?, ?, ?, '', ?, 0, 1, 1, ?, ?)`,
        [`junk-${i}`, WS, parent.parent_id, `A${String(i).padStart(3, '0')}`,
         JSON.stringify({ 'interaction-metrics:record': { recordedAt: 1, queries: { bad: null } } }),
         USER.id, USER.id],
      )
    }
    const records = await loadRecords<InteractionRecordData>(
      repo, WS, interactionMetricsUIStateType.id, PATH, isUsableInteractionRecord,
    )
    expect(records.map((r) => r.id)).toEqual([blockId])
  })

  it('returns newest first', async () => {
    await writeInteractionSample(repo, WS)
    resetMetricsSession() // simulate a second page session
    await writeInteractionSample(repo, WS)
    const records = await loadRecords<InteractionRecordData>(
      repo, WS, interactionMetricsUIStateType.id, PATH, isUsableInteractionRecord)
    expect(records).toHaveLength(2)
    expect(records[0].record.recordedAt).toBeGreaterThanOrEqual(records[1].record.recordedAt)
  })
})
