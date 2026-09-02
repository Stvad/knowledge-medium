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
  INTERACTION_RECORD_PATH,
  interactionMetricsUIStateType,
  interactionRecordProp,
  interactionRecordType,
  writeInteractionSample,
} from '@/plugins/interaction-metrics/record'
import { resetMetricsSession } from '@/plugins/interaction-metrics/sessionContext'
import { getDeviceLabel } from '@/utils/clientId'
import { clientGroupId } from '@/plugins/interaction-metrics/recordStore'
import {
  HISTORY_LIMIT,
  INTERACTION_SERIES,
  MAX_PAGES,
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

/** The fields `isUsableInteractionRecord` and the comparison dereference. */
const RECORD = {
  startedAt: 0, appVersion: 'v', appSha: 'sha', clientId: 'c',
  deviceLabel: getDeviceLabel(),
  sessionMs: 1, blockCount: 1, writes: 1, queries: {}, fanout: {}, db: {},
  handles: { count: 0, totalDeps: 0, maxDeps: 0, p50Deps: 0, p95Deps: 0, topHeavy: [] },
}

const blockCount = async (): Promise<number> =>
  (await sharedDb.db.getAll<{ n: number }>('SELECT COUNT(*) AS n FROM blocks'))[0].n

describe('loadRecords', () => {
  // Pins the derived container id against the `ensure` chain the recorder uses.
  // If those drift, the reader silently returns nothing and every verdict
  // becomes "building a baseline" forever.
  it('finds what the recorder wrote', async () => {
    await writeInteractionSample(repo, WS)
    const records = await loadRecords(repo, WS, INTERACTION_SERIES)
    expect(records).toHaveLength(1)
    expect(records[0].record.clientId).toBeTruthy()
    expect(records[0].id).toBeTruthy()
  })

  // A reader that used `getPluginUIStateBlock` would mint the whole ui-state
  // subtree as a side effect of finding out it is empty -- on every session, in
  // every workspace, including ones where the recorders are switched off.
  it('creates nothing when there is no history', async () => {
    const before = await blockCount()
    const records = await loadRecords(repo, WS, INTERACTION_SERIES)
    expect(records).toEqual([])
    expect(await blockCount()).toBe(before)
  })

  // A session's record is UPDATED IN PLACE, so a long-lived tab's row keeps the
  // tree position it was created at while its timestamp advances past every row
  // created since. Paged by tree position, that row falls out of the window once
  // enough newer siblings exist, and the in-memory sort cannot recover a row the
  // paging already excluded — the reader then silently analyses a stale
  // baseline while the newest sample sits in the group unread.
  it('reads a record whose timestamp advanced after newer siblings were created', async () => {
    const groupId = clientGroupId(repo, WS, interactionMetricsUIStateType)
    const insert = async (id: string, orderKey: string, recordedAt: number): Promise<void> => {
      await sharedDb.db.execute(
        `INSERT INTO blocks
           (id, workspace_id, parent_id, order_key, content, properties_json, deleted,
            created_at, updated_at, created_by, updated_by)
         VALUES (?, ?, ?, ?, '', ?, 0, 1, 1, ?, ?)`,
        [id, WS, groupId, orderKey,
         JSON.stringify({ [interactionRecordProp.name]: { ...RECORD, recordedAt } }),
         USER.id, USER.id],
      )
    }
    // The long-lived tab's row, created FIRST (largest order key, since records
    // are prepended) and re-stamped most recently.
    await insert('long-lived', 'z999', 9_000_000)
    // Enough newer-created siblings to fill every page the reader will read.
    const buried = HISTORY_LIMIT * MAX_PAGES + 5
    for (let i = 0; i < buried; i++) {
      await insert(`later-${i}`, `a${String(i).padStart(4, '0')}`, 1_000_000 + i)
    }

    const records = await loadRecords(repo, WS, INTERACTION_SERIES)
    expect(records[0].id).toBe('long-lived')
  })

  // An installed PWA and an ordinary tab on one browser profile share
  // `km:client-id`, so they share this group — but their timings differ for
  // reasons the code did not cause. Comparing across them invents regressions.
  it('reads only the records this device surface wrote', async () => {
    const mine = (await writeInteractionSample(repo, WS))!
    const groupId = clientGroupId(repo, WS, interactionMetricsUIStateType)
    await sharedDb.db.execute(
      `INSERT INTO blocks
         (id, workspace_id, parent_id, order_key, content, properties_json, deleted,
          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, 'z9', '', ?, 0, 1, 1, ?, ?)`,
      ['other-surface', WS, groupId,
       JSON.stringify({ [interactionRecordProp.name]: {
         ...RECORD, recordedAt: 5_000_000, deviceLabel: 'installed:OtherSurface' } }),
       USER.id, USER.id],
    )

    const records = await loadRecords(repo, WS, INTERACTION_SERIES)
    expect(records.map((r) => r.id)).toEqual([mine])
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
    const records = await loadRecords(repo, WS, INTERACTION_SERIES)
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
    const records = await loadRecords(repo, WS, INTERACTION_SERIES)
    expect(records.map((r) => r.id)).toEqual([blockId])
  })

  it('returns newest first', async () => {
    await writeInteractionSample(repo, WS)
    resetMetricsSession(repo) // simulate a second page session
    await writeInteractionSample(repo, WS)
    const records = await loadRecords(repo, WS, INTERACTION_SERIES)
    expect(records).toHaveLength(2)
    expect(records[0].record.recordedAt).toBeGreaterThanOrEqual(records[1].record.recordedAt)
  })
})
