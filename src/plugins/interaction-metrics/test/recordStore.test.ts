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
import { deviceSurface, getClientId, getDeviceLabel, resetClientIdCache } from '@/utils/clientId'
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
import { appendClientRecord, clientGroupId, updateClientRecord, type ClientRecordSpec } from '../recordStore'
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
  recordedAt: 1, startedAt: 0, appVersion: 'v', appSha: 'sha', clientId: 'set-per-test',
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
  // `getClientId()` is read HERE, per call: `resetClientIdCache` mints a new id
  // per test, and retention refuses to prune another client's records — a
  // module-scope capture would be the wrong client's by the time it lands.
  record: { property: interactionRecordProp, data: { ...DATA, clientId: getClientId() } },
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

/** Put the workspace in the child-backed properties shape, where a property
 *  write materializes field and VALUE blocks under the record — the production
 *  shape, and the one where these rows stop being invisible. */
const useChildBackedProperties = async (): Promise<void> => {
  await sharedDb.db.execute(
    `UPDATE workspaces SET properties_migration = 'children' WHERE id = ?`, [WS])
  if ((await sharedDb.db.getAll('SELECT id FROM workspaces WHERE id = ?', [WS])).length === 0) {
    await sharedDb.db.execute(
      `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time,
         encryption_mode, wk_canary, properties_migration)
       VALUES (?, 'test ws', ?, 1, 1, 'none', NULL, 'children')`, [WS, USER.id])
  }
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
      [JSON.stringify({ [interactionRecordProp.name]:
        { ...DATA, clientId: getClientId(), recordedAt: 9_000_000 } }), ids[0]],
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

  // The record row can outlive its containers: sync tombstones a group or a
  // plugin root without touching the children under it. An update that only
  // checks the record writes fresh telemetry below a dead hierarchy, which no
  // reader will ever look under — the append path already refused this, and the
  // two paths share one owner precisely so they cannot disagree.
  it('refuses to update a record whose group was deleted', async () => {
    const { blockId } = await append(3)
    const groupId = clientGroupId(repo, WS, interactionMetricsUIStateType)
    await repo.tx(async (tx) => { await tx.delete(groupId) },
      { scope: ChangeScope.Automation, telemetry: true })

    await expect(updateClientRecord(repo, {
      workspaceId: WS,
      blockId,
      containerType: interactionMetricsUIStateType,
      description: 'test metrics record',
      assertEligible: () => {},
      isStillOurs: (row) => row !== null && !row.deleted,
      record: { property: interactionRecordProp, data: DATA },
    })).rejects.toBeInstanceOf(NoLongerEligible)
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
        [JSON.stringify({ [interactionRecordProp.name]:
          { ...DATA, clientId: getClientId(), recordedAt: 9e12 } }), victim],
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

/**
 * A record must not surface anywhere a person looks for their own blocks.
 *
 * `core.recentBlocks` is the stand-in for that whole class: live, non-empty
 * rows — the test that these rows carry no content, asserted through a real
 * query rather than by reading the column. The `((` picker itself no longer
 * uses it (it reads user-authored recents, which exclude ui-state), but
 * find-replace still selects any non-empty row in the workspace, and the next
 * such surface will too.
 */
describe('what a record shows the user', () => {
  // The container too, and asserted on its CONTENT: the previous attempt simply
  // omitted the title argument, which `ensureStateChild` defaults to the
  // namespace — so the group was created carrying the client UUID and stayed in
  // every listing. A test that only checked the record row could not see that.
  it('gives the client group no content to index', async () => {
    const { groupId } = await append(1)

    const row = await sharedDb.db.getOptional<{ content: string }>(
      'SELECT content FROM blocks WHERE id = ?', [groupId])

    expect(row?.content).toBe('')
  })

  // The child-backed shape, where the record stops being the only row it
  // creates: the property materializes a field block and a VALUE block whose
  // CONTENT is the serialized record — non-empty, freshly stamped, and sitting
  // in the user's tree. Empty content on the record itself does nothing for
  // those, so the surfaces that offer blocks to a person have to exclude by
  // LOCATION, which is what the authored-recents query does.
  it('keeps its property machinery out of authored recents', async () => {
    await useChildBackedProperties()
    const { blockId } = await append(1)

    const machinery = await sharedDb.db.getAll<{ id: string; content: string }>(
      `WITH RECURSIVE d(id) AS (
         SELECT ? UNION ALL SELECT b.id FROM blocks b JOIN d ON b.parent_id = d.id)
       SELECT b.id, b.content FROM blocks b JOIN d ON b.id = d.id
       WHERE b.deleted = 0 AND b.id != ? AND b.content != ''`,
      [blockId, blockId],
    )
    // Precondition: there really are non-empty generated rows to exclude, and
    // one of them really does carry the payload — without this the assertion
    // below passes on a shape that never materialized anything.
    expect(machinery.length).toBeGreaterThan(0)
    expect(machinery.some((r) => r.content.includes('appSha'))).toBe(true)

    const recents = await repo.query.recentUserBlocks({ workspaceId: WS, limit: 50 }).load()

    const offered = new Set(recents.map((b) => b.id))
    expect(offered.has(blockId)).toBe(false)
    for (const row of machinery) expect(offered.has(row.id)).toBe(false)
  })

  it('does not appear among recent blocks', async () => {
    const { blockId } = await append(1)

    const recent = await repo.query.recentBlocks({ workspaceId: WS, limit: 12 }).load()

    // The record was written and is live — otherwise this passes for the wrong
    // reason, and would keep passing with the rule deleted.
    expect(await liveIds()).toContain(blockId)
    expect(recent.map((b) => b.id)).not.toContain(blockId)
  })
})

/**
 * What retention may and may not take with the record.
 *
 * Two rules pulling opposite ways. Writing the record property materializes
 * field/value rows beneath the block where properties are blocks, and a bare
 * `tx.delete` tombstones only the parent, leaving those live under a tombstone
 * forever — so the prune walks the SUBTREE. But these records sit in the user's
 * tree, so a person can put a block under one, and this pass runs at Automation
 * scope where no undo reaches. The record is therefore skipped outright once it
 * has a child that is not property machinery.
 */
describe('retention deletion', () => {
  const liveDescendantsOf = async (id: string): Promise<string[]> =>
    (await sharedDb.db.getAll<{ id: string }>(
      'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0', [id],
    )).map((r) => r.id)

  // The production shape this guard exists for. With properties as blocks every
  // record has generated field children, and `hidePropertyChildren` is the only
  // thing keeping them from reading as hand-placed content — without it
  // retention silently stops, and both series grow without bound.
  it('prunes a record that has property machinery beneath it', async () => {
    await useChildBackedProperties()

    const { blockId: doomed } = await append(1)
    // The precondition, asserted rather than assumed: this record really does
    // have machinery under it, or the test proves nothing about the guard.
    expect(await liveDescendantsOf(doomed)).not.toEqual([])

    await append(1)
    await append(1)

    expect(await liveIds()).not.toContain(doomed)
  })

  it('prunes a record whose only descendants are its own machinery', async () => {
    const { blockId: doomed } = await append(1)
    // Two more appends push `doomed` past a retain of 1.
    await append(1)
    await append(1)

    expect(await liveIds()).not.toContain(doomed)
    expect(await liveDescendantsOf(doomed)).toEqual([])
  })

  // A record is inspectable by design, so a person can type into it. An
  // Automation-scope delete takes that with no undo behind it.
  it('leaves a record alone once someone has typed into it', async () => {
    const { blockId: annotated } = await append(1)
    await repo.tx(async (tx) => { await tx.update(annotated, { content: 'why was this slow?' }) },
      { scope: ChangeScope.Automation, description: 'seed a hand edit' })

    await append(1)
    await append(1)

    expect(await liveIds()).toContain(annotated)
  })

  // ...and the same for a property added by hand beside the record's own.
  it('leaves a record alone once someone has added a property', async () => {
    const { blockId: annotated } = await append(1)
    await repo.tx(async (tx) => {
      await tx.setProperty(annotated, interactionRecordProp, DATA, { skipMetadata: true })
      const row = await tx.get(annotated)
      await tx.update(annotated, { properties: { ...row!.properties, 'user:note': 'mine' } })
    }, { scope: ChangeScope.Automation, description: 'seed a hand property' })

    await append(1)
    await append(1)

    expect(await liveIds()).toContain(annotated)
  })

  // Records written before they became contentless carried their own ISO
  // timestamp. Reading that as a hand edit would leave every pre-existing
  // record permanently unprunable, which is the worse failure by far.
  it('still prunes a record carrying only its own legacy timestamp', async () => {
    const { blockId: legacy } = await append(1)
    await repo.tx(async (tx) => {
      await tx.update(legacy, { content: new Date(DATA.recordedAt).toISOString() })
    }, { scope: ChangeScope.Automation, description: 'seed a legacy title' })

    await append(1)
    await append(1)

    expect(await liveIds()).not.toContain(legacy)
  })

  // The group id is derived from the client id, so for a row this module wrote
  // the two cannot disagree. One that does was moved in from another client's
  // group by hand, and this client has no business pruning another's history.
  // The RE-TAKE, not the selection: a row that changes hands between the query
  // and the write lock is another client's by the time we hold it, and the
  // query cannot know that.
  it('leaves a row alone when it changes client after selection', async () => {
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await append(3)).blockId)
    const victim = ids[0]
    duringRetention(async () => {
      await sharedDb.db.execute(
        'UPDATE blocks SET properties_json = ? WHERE id = ?',
        [JSON.stringify({ [interactionRecordProp.name]:
          { ...DATA, clientId: 'another-device' } }), victim],
      )
    })

    await append(1)

    expect(await liveIds()).toContain(victim)
  })

  it('leaves a record belonging to another client alone', async () => {
    const { blockId: foreign } = await append(1)
    await sharedDb.db.execute(
      'UPDATE blocks SET properties_json = ? WHERE id = ?',
      [JSON.stringify({ [interactionRecordProp.name]:
        { ...DATA, clientId: 'another-device' } }), foreign],
    )

    await append(1)
    await append(1)

    expect(await liveIds()).toContain(foreign)
  })

  // A second type added by hand lives INSIDE the same `types` property, so a
  // check that only whitelists the key cannot see it.
  it('leaves a record alone once someone has tagged it', async () => {
    const { blockId: tagged } = await append(1)
    await repo.tx(async (tx) => {
      const row = await tx.get(tagged)
      await tx.update(tagged, {
        properties: { ...row!.properties, types: [interactionRecordType.id, 'user:favourite'] },
      })
    }, { scope: ChangeScope.Automation, description: 'seed a hand type tag' })

    await append(1)
    await append(1)

    expect(await liveIds()).toContain(tagged)
  })

  it('leaves a record alone once someone has put a block under it', async () => {
    const { blockId: annotated } = await append(1)
    await repo.tx(async (tx) => {
      await tx.create({
        id: 'a-note', workspaceId: WS, parentId: annotated, orderKey: 'a1',
        content: 'why was this session slow?', properties: {},
      }, { systemMint: true })
    }, { scope: ChangeScope.Automation, description: 'seed a hand-written note' })

    // Two more appends push `annotated` past a retain of 1.
    await append(1)
    await append(1)

    expect(await liveIds()).toContain(annotated)
    expect(await liveDescendantsOf(annotated)).toEqual(['a-note'])
  })
})

/**
 * The device-surface clause, re-taken like every other clause the selection
 * used. One browser profile resolves the same client id as an installed PWA and
 * as an ordinary tab, so the label is what separates their series — and a row
 * relabelled between the selection and the write lock belongs to a different
 * one by the same rule the query applied.
 */
describe('retention and the device surface', () => {
  // The descriptive half of the label CHANGES: `navigator.platform` is
  // deprecated and a browser upgrade can start returning empty, so every record
  // written before it carries a different platform string. Matching the whole
  // label would make all of them invisible to retention — permanently, and on a
  // series that was unbounded before this pass existed.
  it('prunes a record whose label predates a platform-string change', async () => {
    const { blockId: legacy } = await append(1)
    const block = repo.block(legacy)
    await block.load()
    const record = block.peekProperty(interactionRecordProp)!
    await repo.tx(async (tx) => {
      await tx.setProperty(legacy, interactionRecordProp,
        { ...record, deviceLabel: `${deviceSurface()}:SomeRetiredPlatformString` })
    }, { scope: ChangeScope.Automation, description: 'relabel as pre-upgrade' })

    await append(1)
    await append(1)

    expect(await liveIds()).not.toContain(legacy)
  })

  it('leaves a record relabelled after it was selected', async () => {
    for (let i = 0; i < 3; i++) await append(1)
    // The oldest SURVIVING row — earlier appends already pruned the rest, and
    // this is the one the next pass will select.
    const live = await liveIds()
    const doomed = live[live.length - 1]

    duringRetention(async () => {
      const block = repo.block(doomed)
      await block.load()
      const record = block.peekProperty(interactionRecordProp)!
      await repo.tx(async (tx) => {
        await tx.setProperty(doomed, interactionRecordProp,
          { ...record, deviceLabel: 'some other surface' })
      }, { scope: ChangeScope.Automation, description: 'relabel' })
    })

    await append(1)

    expect(await liveIds()).toContain(doomed)
  })
})
