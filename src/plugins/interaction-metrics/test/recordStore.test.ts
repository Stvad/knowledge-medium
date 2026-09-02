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
import { getDeviceLabel, resetClientIdCache } from '@/utils/clientId'
import { pluginUIStateBlockId } from '@/data/stateBlocks'
import { ChangeScope, type User } from '@/data/api'
import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets'
import {
  interactionMetricsUIStateType,
  interactionRecordProp,
  interactionRecordType,
  type InteractionRecordData,
} from '../record'
import { keyAtStart } from '@/data/orderKey'
import { appendClientRecord, clientGroupId, type ClientRecordSpec } from '../recordStore'
import { NoLongerEligible } from '../sessionContext'

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
  deviceLabel: getDeviceLabel(), sessionMs: 1, blockCount: 1, writes: 1,
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

const append = (retain: number) => appendClientRecord(repo, spec(retain))

const liveIds = async (): Promise<string[]> =>
  (await sharedDb.db.getAll<{ id: string }>(
    'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key',
    [clientGroupId(repo, WS, interactionMetricsUIStateType)],
  )).map((r) => r.id)

/** A child of the group that is NOT one of ours — the hand-created block these
 *  inspectable subtrees are allowed to hold. */
const insertForeign = async (id: string): Promise<void> => {
  const groupId = clientGroupId(repo, WS, interactionMetricsUIStateType)
  // Ordered ahead of every existing child, derived rather than guessed — the
  // keys are fractional and jittered, so a literal cannot be relied on to sort
  // first.
  const first = await sharedDb.db.getOptional<{ order_key: string }>(
    'SELECT order_key FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key LIMIT 1',
    [groupId],
  )
  await sharedDb.db.execute(
    `INSERT INTO blocks
       (id, workspace_id, parent_id, order_key, content, properties_json, deleted,
        created_at, updated_at, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, '{}', 0, 1, 1, ?, ?)`,
    [id, WS, groupId, keyAtStart(first?.order_key ?? null),
     'a note someone made here', USER.id, USER.id],
  )
}

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

  // Clearing the record through the property codec leaves the KEY present
  // holding JSON null (`optionalIdentity.encode(undefined)` is `null`), which
  // `json_extract` reports as absent. A re-take testing `=== undefined` reads
  // that as still ours and deletes a block a person just repurposed.
  it('leaves a row alone when its record is cleared to null after selection', async () => {
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await append(3)).blockId)
    const victim = ids[0]
    duringRetention(async () => {
      await sharedDb.db.execute(
        'UPDATE blocks SET properties_json = ? WHERE id = ?',
        [JSON.stringify({ [interactionRecordProp.name]: null }), victim],
      )
    })
    const fresh = (await append(1)).blockId
    expect(await liveIds()).toEqual([fresh, ids[2], victim])
  })

  // A record dragged out of the group is invisible to the reader, so it is no
  // longer ours to collect — and deleting it would take it from wherever the
  // person put it.
  it('leaves a row alone when it is moved out of the group after selection', async () => {
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await append(3)).blockId)
    const victim = ids[0]
    await repo.tx(async (tx) => {
      await tx.create({ id: 'elsewhere', workspaceId: WS, parentId: null, orderKey: 'a0',
        content: 'a page', properties: {} }, { systemMint: true })
    }, { scope: ChangeScope.Automation })
    duringRetention(async () => {
      await sharedDb.db.execute(
        'UPDATE blocks SET parent_id = ? WHERE id = ?', ['elsewhere', victim])
    })
    const fresh = (await append(1)).blockId

    expect(await liveIds()).toEqual([fresh, ids[2]])
    const moved = await sharedDb.db.getOptional<{ deleted: number }>(
      'SELECT deleted FROM blocks WHERE id = ?', [victim])
    expect(moved?.deleted).toBe(0)
  })

  // The record filter is applied to the SELECT as well as to each deletion, and
  // only the SELECT can keep a foreign row out of the OFFSET. Counting one
  // toward the bound pushes a genuine record past it, and the per-row re-take
  // cannot see that: the row it is handed is unambiguously ours.
  it('does not let a foreign child consume a retention slot', async () => {
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await append(3)).blockId)
    // Ordered ahead of every record, so an unfiltered SELECT spends the single
    // retained slot on it and evicts the newest real record instead.
    await insertForeign('hand-written')
    const fresh = (await append(1)).blockId

    const live = await liveIds()
    expect(live).toContain('hand-written')
    expect(live).toContain(ids[2])
    expect(live).toEqual([fresh, 'hand-written', ids[2]])
  })

  // Deletes here are non-undoable, and the pass is several awaits past the
  // create's own gate — including a scan of the whole group.
  it('refuses to prune once the workspace stops being writable', async () => {
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await append(3)).blockId)
    duringRetention(async () => { repo.setReadOnly(true) })
    const fresh = (await append(1)).blockId

    expect(await liveIds()).toEqual([fresh, ...[...ids].reverse()])
  })

  // The append commits the record and then AWAITS a retention scan, so a caller
  // that claims ownership from the return value leaves the row readable but
  // unclaimed for the length of that scan. The reader excludes this session's
  // record by id, so anything reading in that window counts the live session
  // twice — once live, once as its own stored copy.
  it('reports the record before yielding to the retention pass', async () => {
    const order: string[] = []
    const realTx = repo.tx.bind(repo)
    vi.spyOn(repo, 'tx').mockImplementation(async (fn, opts) => {
      if (opts?.description?.endsWith('retention')) order.push('prune')
      return realTx(fn, opts)
    })
    for (let i = 0; i < 3; i++) await append(3)
    await appendClientRecord(repo, {
      ...spec(1),
      onCommitted: () => order.push('claimed'),
    })
    expect(order).toEqual(['claimed', 'prune'])
  })

  // Records are updated IN PLACE, so tree position is creation order and not
  // recency. `loadRecords` pages by the record's own timestamp; retention
  // ordering by position would evict the row a long-lived tab is still writing
  // to — the reader's newest sample — while keeping rows it considers older.
  it('keeps the most recently stamped record, not the most recently created', async () => {
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await append(3)).blockId)
    // The OLDEST-created row, re-stamped as the newest sample — a tab that has
    // stayed open across the sessions that created the others.
    await sharedDb.db.execute(
      'UPDATE blocks SET properties_json = ? WHERE id = ?',
      [JSON.stringify({ [interactionRecordProp.name]: { ...DATA, recordedAt: 9_000_000 } }), ids[0]],
    )
    const fresh = (await append(1)).blockId

    const live = await liveIds()
    expect(live).toContain(ids[0])
    // And it really did prune, so this is not a vacuous pass.
    expect(live).toEqual([fresh, ids[0]])
  })

  // `ensureClientGroup` is memoized per Repo, so a group deleted during this
  // page session still resolves. `tx.create` accepts a tombstoned parent, and
  // the reader matches on the derived group id — so the record would be written
  // somewhere nothing can ever read it, forever.
  it('refuses to append under a group that was deleted this session', async () => {
    const first = (await append(3)).blockId
    const groupId = clientGroupId(repo, WS, interactionMetricsUIStateType)
    await repo.tx(async (tx) => { await tx.delete(groupId) },
      { scope: ChangeScope.Automation, telemetry: true })

    await expect(append(3)).rejects.toBeInstanceOf(NoLongerEligible)

    // Only what was there before. A soft-deleted parent does not cascade, so
    // the earlier record stays live under it — the point is that nothing NEW
    // was added somewhere the reader can never look.
    const children = await sharedDb.db.getAll<{ id: string }>(
      'SELECT id FROM blocks WHERE parent_id = ?', [groupId])
    expect(children.map((c) => c.id)).toEqual([first])
  })

  // Deleting the plugin root leaves the memoized client group live, and a record
  // under a live group whose own parent is a tombstone is just as unreachable.
  it('refuses to append under a group whose root was deleted', async () => {
    await append(3)
    const rootId = pluginUIStateBlockId(WS, USER.id, interactionMetricsUIStateType.id)
    await repo.tx(async (tx) => { await tx.delete(rootId) },
      { scope: ChangeScope.Automation, telemetry: true })

    await expect(append(3)).rejects.toBeInstanceOf(NoLongerEligible)
  })

  // Rank is what put a row past the bound, and rank belongs to the whole
  // series — it cannot be re-derived for one row inside the writing
  // transaction. A stamp that moved means another tab wrote to the row after
  // the selection, which is exactly when it may no longer be the oldest.
  it('leaves a row alone when its timestamp moved after selection', async () => {
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await append(3)).blockId)
    const victim = ids[0]
    duringRetention(async () => {
      await sharedDb.db.execute(
        'UPDATE blocks SET properties_json = ? WHERE id = ?',
        [JSON.stringify({ [interactionRecordProp.name]: { ...DATA, recordedAt: 9e12 } }), victim],
      )
    })
    const fresh = (await append(1)).blockId

    const live = await liveIds()
    expect(live).toContain(victim)
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
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const { blockId } = await append(1)

    expect(await liveIds()).toContain(blockId)
    const stored = repo.block(blockId)
    await stored.load()
    expect(stored.peekProperty(interactionRecordProp)).toMatchObject({ appSha: 'sha' })
  })
})

/**
 * Eligibility is re-taken inside the writing transaction, but the containers
 * are minted BEFORE it — so a check that only guards the write leaves two
 * hidden blocks behind in a workspace the recorder was no longer allowed to
 * target. In a read-only workspace those are Automation writes that RLS refuses
 * and parks in the quarantine, which is the outcome the rule exists to prevent.
 */
describe('appendClientRecord eligibility', () => {
  const blockCount = async (): Promise<number> =>
    (await sharedDb.db.getAll<{ n: number }>(
      'SELECT COUNT(*) AS n FROM blocks WHERE deleted = 0'))[0].n

  it('mints no container when the recorder is already ineligible', async () => {
    const before = await blockCount()
    // The shape a workspace switch during the awaits leaves behind: the spec's
    // workspace is no longer the active one.
    repo.setActiveWorkspaceId('ws-2')

    await expect(appendClientRecord(repo, spec(5))).rejects.toBeInstanceOf(NoLongerEligible)

    expect(await blockCount()).toBe(before)
  })

  // The recorder-specific rule, not just the shared default: the interaction
  // recorder's is strictly stronger, and the ensure must be behind THAT one.
  it('honours a stronger rule than the shared default', async () => {
    const before = await blockCount()
    await expect(appendClientRecord(repo, {
      ...spec(5),
      assertEligible: () => { throw new NoLongerEligible() },
    })).rejects.toBeInstanceOf(NoLongerEligible)
    expect(await blockCount()).toBe(before)
  })
})
