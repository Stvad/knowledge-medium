// @vitest-environment node
/**
 * `createTypedChild` exists to make the granular shape (one block per
 * record, typed, composable) as cheap to write as the JSON-blob shortcut.
 * These tests pin the properties that make it worth reaching for: the block
 * lands typed, its values go through their codecs, several types compose,
 * and the whole thing is one atomic unit of the caller's transaction.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, propertyValue, seedProperty, seedType } from '@/data/api'
import type { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets'
import { getBlockTypes } from '@/data/properties'
import type { Repo } from '@/data/repo'
import { createTypedChild, derivedBlockId, getOrCreateTypedChild } from '@/data/typedRecords'

const NS = 'd6c7f0e1-5b42-4a90-9d18-2f7c4e6a1b03'
const identity = (key: string) => ({namespace: NS, key})

const weightProp = seedProperty({
  seedKey: 'test/property/rec-weight',
  revision: 1,
  name: 'rec:weight',
  preset: 'number',
  defaultValue: 0,
  changeScope: ChangeScope.BlockDefault,
})

const doneProp = seedProperty({
  seedKey: 'test/property/rec-done',
  revision: 1,
  name: 'rec:done',
  preset: 'boolean',
  defaultValue: false,
  changeScope: ChangeScope.BlockDefault,
})

const recordType = seedType({
  seedKey: 'test/type/rec',
  revision: 1,
  id: 'rec-entry',
  label: 'Record',
  properties: [weightProp],
})

const companionType = seedType({
  seedKey: 'test/type/rec-companion',
  revision: 1,
  id: 'rec-companion',
  label: 'Companion',
  properties: [doneProp],
})

let sharedDb: TestDb
let repo: Repo
let cache: BlockCache

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  const created = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    extensions: [
      definitionSeedsFacet.of(weightProp, {source: 'test'}),
      definitionSeedsFacet.of(doneProp, {source: 'test'}),
      typeSeedsFacet.of(recordType, {source: 'test'}),
      typeSeedsFacet.of(companionType, {source: 'test'}),
    ],
  })
  repo = created.repo
  cache = created.cache
  repo.setActiveWorkspaceId('ws-1')
  await repo.tx(async tx => {
    await tx.create({id: 'parent', workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'Parent'})
  }, {scope: ChangeScope.BlockDefault})
})

describe('createTypedChild', () => {
  it('creates a typed child with codec-encoded properties in one call', async () => {
    const id = await repo.tx(
      tx => createTypedChild(repo, tx, {
        parentId: 'parent',
        content: '135lb × 8',
        types: [recordType.id],
        properties: [propertyValue(weightProp, 135)],
      }),
      {scope: ChangeScope.BlockDefault, description: 'record'},
    )

    const block = cache.getSnapshot(id)!
    expect(block.parentId).toBe('parent')
    expect(block.content).toBe('135lb × 8')
    expect(getBlockTypes(block)).toEqual([recordType.id])
    expect(repo.block(id).peekProperty(weightProp)).toBe(135)
  })

  it('composes several types on one record', async () => {
    const id = await repo.tx(
      tx => createTypedChild(repo, tx, {
        parentId: 'parent',
        types: [recordType.id, companionType.id],
        properties: [propertyValue(weightProp, 45), propertyValue(doneProp, true)],
      }),
      {scope: ChangeScope.BlockDefault},
    )
    expect(getBlockTypes(cache.getSnapshot(id)!)).toEqual([recordType.id, companionType.id])
    expect(repo.block(id).peekProperty(doneProp)).toBe(true)
  })

  it('honours an explicit id and position so deterministic-id upserts work', async () => {
    const secondId = await repo.tx(tx => createTypedChild(repo, tx, {
      parentId: 'parent', types: [recordType.id], content: 'second',
    }), {scope: ChangeScope.BlockDefault})
    const firstId = await repo.tx(tx => createTypedChild(repo, tx, {
      parentId: 'parent', id: 'pinned-id', content: 'first', types: [recordType.id],
      position: {kind: 'first'},
    }), {scope: ChangeScope.BlockDefault})

    expect(firstId).toBe('pinned-id')
    const rows = await sharedDb.db.getAll<{id: string}>(
      'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id',
      ['parent'],
    )
    expect(rows.map(r => r.id)).toEqual(['pinned-id', secondId])
  })

  it('rolls the whole record back with the caller\'s transaction', async () => {
    await expect(repo.tx(async tx => {
      await createTypedChild(repo, tx, {
        parentId: 'parent', id: 'doomed', types: [recordType.id],
        properties: [propertyValue(weightProp, 95)],
      })
      throw new Error('caller failed after the record was created')
    }, {scope: ChangeScope.BlockDefault})).rejects.toThrow('caller failed')

    const rows = await sharedDb.db.getAll<{id: string}>('SELECT id FROM blocks WHERE id = ?', ['doomed'])
    expect(rows).toEqual([])
  })
})

/**
 * `getOrCreateTypedChild` exists because "query for it, then create if
 * absent" cannot be made correct — the query answers for the moment it ran.
 * These tests pin the two properties that make a derived id better than a
 * narrower race: repeating the call converges on one block, and adopting one
 * never overwrites what it found.
 */
describe('getOrCreateTypedChild', () => {
  const record = (key: string, over: Partial<Parameters<typeof getOrCreateTypedChild>[2]> = {}) =>
    repo.tx(tx => getOrCreateTypedChild(repo, tx, {
      identity: identity(key),
      parentId: 'parent',
      content: 'Session A',
      types: [recordType.id],
      properties: [propertyValue(weightProp, 135)],
      ...over,
    }), {scope: ChangeScope.BlockDefault})

  it('gives different identities different records, and the same key different records per namespace', async () => {
    // Without this the suite passes with `derivedBlockId` ignoring the key
    // entirely — every other test uses one key against a fresh db, so none of
    // them can tell. This is the property the namespaces exist for.
    const a = await record('ws-1|2026-07-24|A')
    const b = await record('ws-1|2026-07-24|B')
    expect(a.id).not.toBe(b.id)

    const otherNamespace = await repo.tx(tx => getOrCreateTypedChild(repo, tx, {
      identity: {namespace: 'f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b', key: 'ws-1|2026-07-24|A'},
      parentId: 'parent',
      types: [recordType.id],
    }), {scope: ChangeScope.BlockDefault})
    expect(otherNamespace).toEqual({status: 'created', id: expect.any(String)})
    expect(otherNamespace.id).not.toBe(a.id)

    const rows = await sharedDb.db.getAll<{id: string}>(
      'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0', ['parent'],
    )
    expect(rows).toHaveLength(3)
  })

  it('adopts within a single transaction, since the probe must see its own insert', async () => {
    // Two rows of one draft resolving the same identity inside ONE tx. If
    // `tx.get` ever stopped reading through to the transaction's own writes,
    // both would insert and the second would throw DuplicateIdError.
    const [first, second] = await repo.tx(async tx => [
      await getOrCreateTypedChild(repo, tx, {
        identity: identity('same-tx'), parentId: 'parent', types: [recordType.id],
      }),
      await getOrCreateTypedChild(repo, tx, {
        identity: identity('same-tx'), parentId: 'parent', types: [recordType.id],
      }),
    ], {scope: ChangeScope.BlockDefault})

    expect(first.status).toBe('created')
    expect(second.status).toBe('adopted')
    expect(second.id).toBe(first.id)
  })

  it('mints pristine, so two devices deriving one id both yield to the server', async () => {
    // Not cosmetic: syncObserver/reconcile.ts's invariant I1 treats equal
    // NONZERO stamps as the same write. Two devices minting the same derived
    // id in the same millisecond would produce equal nonzero stamps from
    // different writes, and the insert-or-skip loser would strand forever.
    const {id} = await record('pristine')
    const [row] = await sharedDb.db.getAll<{updated_at: number}>(
      'SELECT updated_at FROM blocks WHERE id = ?', [id],
    )
    expect(row.updated_at).toBe(0)
  })

  it('creates once and adopts thereafter, so a repeated create converges on one block', async () => {
    const first = await record('ws-1|2026-07-24|A')
    const second = await record('ws-1|2026-07-24|A')

    expect(first).toEqual({status: 'created', id: derivedBlockId(identity('ws-1|2026-07-24|A'))})
    expect(second.status).toBe('adopted')
    expect(second.id).toBe(first.id)
    const rows = await sharedDb.db.getAll<{id: string}>(
      'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0', ['parent'],
    )
    expect(rows).toHaveLength(1)
  })

  it('leaves the adopted block\'s content and properties alone', async () => {
    // The whole point. The second caller holds pre-filled defaults; the block
    // holds real logged state. Applying the spec on adopt would overwrite it.
    const {id} = await record('logged')
    await repo.tx(async tx => {
      await tx.update(id, {content: '145lb × 8'})
      await tx.setProperty(id, weightProp, 145)
    }, {scope: ChangeScope.BlockDefault})

    await record('logged')

    expect(cache.getSnapshot(id)!.content).toBe('145lb × 8')
    expect(repo.block(id).peekProperty(weightProp)).toBe(145)
  })

  it('re-tags a type the block is missing, so a record repairs itself', async () => {
    const {id} = await record('repairable')
    const outcome = await record('repairable', {types: [recordType.id, companionType.id]})
    expect(getBlockTypes(cache.getSnapshot(id)!)).toEqual([recordType.id, companionType.id])
    // …and the block it hands back describes the repaired record, not the one
    // it walked in on. A caller reading types off it saw the tag still missing.
    expect(outcome.status === 'adopted' && getBlockTypes(outcome.block))
      .toEqual([recordType.id, companionType.id])
  })

  it('never adopts a row belonging to another workspace', async () => {
    // Two workspaces whose keys collide would otherwise have the first one's
    // record silently written into by the second — a write into a workspace
    // the user may not even have open. The probe steps past it instead.
    const id = derivedBlockId(identity('shared-key'))
    await repo.tx(async tx => {
      await tx.create({id: 'parent-2', workspaceId: 'ws-2', parentId: null, orderKey: 'a0', content: 'Elsewhere'})
      await tx.create({id, workspaceId: 'ws-2', parentId: 'parent-2', orderKey: 'a1', content: 'Theirs'})
    }, {scope: ChangeScope.BlockDefault})

    const ours = await record('shared-key')
    expect(ours.status).toBe('created')
    expect(ours.id).not.toBe(id)
    expect(cache.getSnapshot(id)!.content).toBe('Theirs')
    expect(getBlockTypes(cache.getSnapshot(id)!)).toEqual([])
  })

  it('keeps a key that spells a later slot distinct from that slot', async () => {
    // The slot varies the NAMESPACE rather than suffixing the key, so a key
    // that literally contains a slot suffix cannot collide with it. Asserting
    // against `derivedBlockId` alone would move both sides together, so this
    // needs the colliding PAIR.
    const spelled = await record('Row#1')
    await record('Row')
    const next = await record('Row', {adoptable: () => false})
    expect(next.id).toBe(derivedBlockId(identity('Row'), 1))
    expect(spelled.id).not.toBe(next.id)
  })

  it('honours the requested position', async () => {
    // `startWorkout` files tonight's session at the TOP of the log; a create
    // that dropped `position` would put it wherever, silently. Needs an
    // existing sibling to have an opinion about.
    const existing = await record('already-there')
    const newest = await record('positioned', {position: {kind: 'first'}})
    const children = await repo.block('parent').children.load()
    expect(children?.map(child => child.id)).toEqual([newest.id, existing.id])
  })

  it('takes the next slot rather than resurrecting a deleted record', async () => {
    // Discarding a workout and then tapping a checkbox again must not bring
    // the discarded one back — but it must still be idempotent, so the
    // fallback is derived too, not random.
    const first = await record('discarded')
    await repo.tx(tx => tx.delete(first.id), {scope: ChangeScope.BlockDefault})

    const second = await record('discarded')
    const third = await record('discarded')

    expect(second).toEqual({status: 'created', id: derivedBlockId(identity('discarded'), 1)})
    expect(third.status).toBe('adopted')
    expect(third.id).toBe(second.id)
  })

  it('takes the next slot when the caller rejects what it found', async () => {
    const done = await record('slot-taken')
    await repo.tx(tx => tx.setProperty(done.id, doneProp, true), {scope: ChangeScope.BlockDefault})

    const next = await record('slot-taken', {adoptable: b => b.properties[doneProp.name] !== true})
    expect(next.status).toBe('created')
    expect(next.id).toBe(derivedBlockId(identity('slot-taken'), 1))
  })

  it('fails loudly when every slot is rejected, instead of silently creating a duplicate', async () => {
    await record('always-rejected')
    await expect(record('always-rejected', {adoptable: () => false, maxSlots: 1}))
      .rejects.toThrow(/all 1 slots/)
  })
})
