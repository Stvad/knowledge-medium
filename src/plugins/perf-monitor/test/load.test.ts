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
} from '@/plugins/interaction-metrics/record'
import { resetMetricsSession } from '@/plugins/interaction-metrics/sessionContext'
import { getClientId, getDeviceLabel } from '@/utils/clientId'
import { jsonPathForProperty } from '@/data/internals/typedBlockQuery'
import { clientGroupId } from '@/plugins/interaction-metrics/recordStore'
import {
  HISTORY_LIMIT,
  countRecords,
  INTERACTION_SERIES,
  CANDIDATE_LIMIT,
  isUsableInteractionRecord,
  isUsableStartupRecord,
  loadRecords,
} from '../load'

const WS = 'ws-1'
const USER: User = { id: 'user-1', name: 'Alice' }
const PATH = jsonPathForProperty(interactionRecordProp.name)

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
/** Spread at WRITE time via `mine()`: the client id is minted per test, and
 *  the series query admits only this client's rows. */
const RECORD = {
  startedAt: 0, appVersion: 'v', appSha: 'sha', clientId: 'set-per-test',
  deviceLabel: getDeviceLabel(),
  sessionMs: 1, blockCount: 1, writes: 1, queries: {}, fanout: {}, db: {},
  handles: { count: 0, totalDeps: 0, maxDeps: 0, p50Deps: 0, p95Deps: 0, topHeavy: [] },
}

/** `RECORD` for THIS test's client. */
const ourRecord = () => ({ ...RECORD, clientId: getClientId() })

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
         JSON.stringify({ [interactionRecordProp.name]: { ...ourRecord(), recordedAt } }),
         USER.id, USER.id],
      )
    }
    // The long-lived tab's row, created FIRST (largest order key, since records
    // are prepended) and re-stamped most recently.
    await insert('long-lived', 'z999', 9_000_000)
    // Enough newer-created siblings to fill every page the reader will read.
    const buried = CANDIDATE_LIMIT + 5
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
         ...ourRecord(), recordedAt: 5_000_000, deviceLabel: 'installed:OtherSurface' } }),
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

  // The candidate window is wider than the comparison window, so the read can
  // return more usable records than the baseline should use. Over-long history
  // biases it toward older, smaller-graph sessions, which reads as a regression
  // that never happened.
  it('stops at the comparison window even with more usable records', async () => {
    const groupId = clientGroupId(repo, WS, interactionMetricsUIStateType)
    const row = async (id: string, orderKey: string, props: object): Promise<void> => {
      await sharedDb.db.execute(
        `INSERT INTO blocks
           (id, workspace_id, parent_id, order_key, content, properties_json, deleted,
            created_at, updated_at, created_by, updated_by)
         VALUES (?, ?, ?, ?, '', ?, 0, 1, 1, ?, ?)`,
        [id, WS, groupId, orderKey, JSON.stringify(props), USER.id, USER.id],
      )
    }
    // One unusable row inside page 0, so that page yields 39 and a second runs.
    await row('bad', 'a0000', { [interactionRecordProp.name]: { ...ourRecord(), recordedAt: 9e9 } })
    await sharedDb.db.execute(
      `UPDATE blocks SET properties_json = json_set(properties_json, ?, 'not-a-number') WHERE id = ?`,
      [`${PATH}.writes`, 'bad'],
    )
    for (let i = 0; i < HISTORY_LIMIT + 2; i++) {
      await row(`ok-${i}`, `a${String(i + 1).padStart(4, '0')}`,
        { [interactionRecordProp.name]: { ...ourRecord(), recordedAt: 9e9 - i } })
    }

    const records = await loadRecords(repo, WS, INTERACTION_SERIES)
    expect(records).toHaveLength(HISTORY_LIMIT)
  })

  // The progress note means records ON DISK, so it must not be taken from the
  // loaded window — which is capped at HISTORY_LIMIT and would report the cap.
  it('counts every record on disk, past the loaded window', async () => {
    const groupId = clientGroupId(repo, WS, interactionMetricsUIStateType)
    const total = HISTORY_LIMIT + 5
    for (let i = 0; i < total; i++) {
      await sharedDb.db.execute(
        `INSERT INTO blocks
           (id, workspace_id, parent_id, order_key, content, properties_json, deleted,
            created_at, updated_at, created_by, updated_by)
         VALUES (?, ?, ?, ?, '', ?, 0, 1, 1, ?, ?)`,
        [`rec-${i}`, WS, groupId, `a${String(i).padStart(4, '0')}`,
         JSON.stringify({ [interactionRecordProp.name]: { ...ourRecord(), recordedAt: 9e9 - i } }),
         USER.id, USER.id],
      )
    }

    expect(await countRecords(repo, WS, INTERACTION_SERIES)).toBe(total)
    // ...while the comparison still reads only its window.
    expect(await loadRecords(repo, WS, INTERACTION_SERIES)).toHaveLength(HISTORY_LIMIT)
  })

  // Marks stay optional, but a PRESENT one has to be finite: the comparison
  // subtracts them, and NaN takes neither the steady nor the regressed branch,
  // so one hand-edited row could publish a NaN comparison to the chip.
  it('rejects a startup record whose present marks are not finite', () => {
    expect(isUsableStartupRecord({ timeOriginMs: 1 })).toBe(true)
    expect(isUsableStartupRecord({ timeOriginMs: 1, repoReadyMs: 5 })).toBe(true)
    expect(isUsableStartupRecord({ timeOriginMs: 1, repoReadyMs: 'x' })).toBe(false)
    expect(isUsableStartupRecord({ timeOriginMs: 1, firstContentPaintMs: NaN })).toBe(false)
    // Every field the trend table renders, not a chosen few.
    expect(isUsableStartupRecord({ timeOriginMs: 1, interactiveMs: NaN })).toBe(false)
    expect(isUsableStartupRecord({ timeOriginMs: NaN })).toBe(false)
  })

  // Finiteness does not catch a REVERSED pair — both values are perfectly
  // finite — and the consequence is worse than a nonsense number in the dialog:
  // the negative gap falls under the comparison's absolute floor, so it is
  // reported STEADY and a corrupt row contributes to a clean bill of health.
  it('rejects a startup record whose paint mark precedes repo-ready', () => {
    expect(isUsableStartupRecord({ timeOriginMs: 1, repoReadyMs: 900, firstContentPaintMs: 400 }))
      .toBe(false)
    // The ordinary shape, and the degenerate-but-possible equal one.
    expect(isUsableStartupRecord({ timeOriginMs: 1, repoReadyMs: 400, firstContentPaintMs: 900 }))
      .toBe(true)
    expect(isUsableStartupRecord({ timeOriginMs: 1, repoReadyMs: 400, firstContentPaintMs: 400 }))
      .toBe(true)
    // Only when BOTH are present: a mark the session never reached is absent by
    // design, and one of the two alone is not an ordering claim.
    expect(isUsableStartupRecord({ timeOriginMs: 1, firstContentPaintMs: 400 })).toBe(true)
    expect(isUsableStartupRecord({ timeOriginMs: 1, repoReadyMs: 900 })).toBe(true)
  })

  // These are the clauses whose absence is silent-but-visible: the record is a
  // hand-inspectable blob, so a wrong type does not produce a wrong number, it
  // produces a NaN verdict on the chip or a throw inside the dialog's render.
  it('rejects the field types that would reach a reader as NaN or a throw', () => {
    const ok = {
      recordedAt: 1, writes: 1, blockCount: 1, queries: {}, fanout: {},
    }
    expect(isUsableInteractionRecord(ok)).toBe(true)
    // `appSha` is rendered with `.slice(0, 8)` — a number throws mid-`.map` and
    // takes the whole dialog down, not one row.
    expect(isUsableInteractionRecord({ ...ok, appSha: 12345678 })).toBe(false)
    expect(isUsableStartupRecord({ timeOriginMs: 1, appSha: 12345678 })).toBe(false)
    // A fanout VALUE, not just the map: it is consumed as a number, and a
    // string yields NaN, which takes neither the steady nor the regressed
    // branch — the chip then reads "NaN× higher than baseline".
    expect(isUsableInteractionRecord({ ...ok, fanout: { loaderInvalidations: 'oops' } })).toBe(false)
    // ...and a query sample inside the nested map, which a shallow check misses.
    expect(isUsableInteractionRecord({ ...ok, queries: { q: null } })).toBe(false)
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
