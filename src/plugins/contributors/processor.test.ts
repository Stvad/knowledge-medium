import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {ChangeScope, defineSameTxProcessor} from '@/data/api'
import {PAGE_TYPE} from '@/data/blockTypes'
import {sameTxProcessorsFacet} from '@/data/facets'
import {aliasesProp, typesProp} from '@/data/properties'
import {ensureUserPageInTx, userPageBlockId} from '@/data/stateBlocks'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import type {Repo} from '@/data/repo'
import {contributorsDataExtension} from './dataExtension'
import {attributionCreatorsProp, attributionEditorsProp, CONTRIBUTOR_TYPE, contributorKindProp, contributorRoleProp} from './schema'
import {propertyFieldContent} from '@/data/propertyChildren'
import {propertyDefinitionBlockId} from '@/data/definitionSeeds'

const WS = 'workspace'
const HUMAN = userPageBlockId(WS, 'vlad')
const opts = {scope: ChangeScope.BlockDefault}
let db: TestDb
let repo: Repo
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  await resetTestDb(db.db)
  repo = createTestRepo({db: db.db, user: {id: 'vlad', name: 'Vlad'}, now: () => 1000, extensions: [contributorsDataExtension]}).repo
  await repo.withTxContext({contributorId: null}).tx(async tx => {
    for (const id of ['atlas', 'scout']) {
      await tx.create({id, workspaceId: WS, parentId: null, orderKey: 'a0', content: id,
        properties: {[typesProp.name]: [PAGE_TYPE, CONTRIBUTOR_TYPE], [contributorKindProp.name]: 'agent'}})
    }
  }, opts)
})

const read = async (id: string, name: string) => (await repo.load(id))?.properties[name]
const create = (host: Repo, id = 'note') => host.tx(async tx => {
  await tx.create({id, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Original'})
}, opts)

describe('automatic contributor attribution', () => {
  it('records the human user page on UI creation and preserves agent origin through human edits', async () => {
    await create(repo, 'human-note')
    expect(await read('human-note', attributionCreatorsProp.name)).toEqual([HUMAN])
    expect(await read(HUMAN, typesProp.name)).toContain(CONTRIBUTOR_TYPE)
    expect(await read(HUMAN, aliasesProp.name)).toEqual(['Vlad', 'vlad'])
    await create(repo.withTxContext({contributorId: 'atlas'}))
    await repo.tx(tx => tx.update('note', {content: 'Human revision'}), opts)
    expect(await read('note', attributionCreatorsProp.name)).toEqual(['atlas'])
    expect(await read('note', attributionEditorsProp.name)).toEqual([HUMAN])
  })

  it('deduplicates several editors without replacing earlier contributors', async () => {
    await create(repo.withTxContext({contributorId: 'atlas'}))
    for (const [id, content] of [['scout', 'Second'], ['atlas', 'Third'], ['scout', 'Fourth']]) {
      await repo.withTxContext({contributorId: id}).tx(tx => tx.update('note', {content}), opts)
    }
    expect(await read('note', attributionCreatorsProp.name)).toEqual(['atlas'])
    expect(await read('note', attributionEditorsProp.name)).toEqual(['scout', 'atlas'])
  })

  it('allows explicit corrections to the creator and editor lists', async () => {
    await create(repo.withTxContext({contributorId: 'atlas'}))
    await repo.withTxContext({contributorId: 'scout'}).tx(tx => tx.update('note', {content: 'Revision'}), opts)
    await repo.tx(tx => tx.setProperties('note', {set: [
      {schema: attributionCreatorsProp, value: ['scout']},
      {schema: attributionEditorsProp, value: []},
    ]}), opts)
    expect(await read('note', attributionCreatorsProp.name)).toEqual(['scout'])
    expect(await read('note', attributionEditorsProp.name)).toEqual([])
  })

  it('does not attribute no-ops, bookkeeping writes, or explicit unattributed work', async () => {
    await create(repo.withTxContext({contributorId: null}))
    const scout = repo.withTxContext({contributorId: 'scout'})
    await scout.tx(tx => tx.update('note', {content: 'Original'}), opts)
    await scout.tx(tx => tx.update('note', {content: 'Derived'}, {skipMetadata: true}), opts)
    expect(await read('note', attributionCreatorsProp.name)).toBeUndefined()
    expect(await read('note', attributionEditorsProp.name)).toBeUndefined()
  })
  it.each(['set', 'batch', 'replace', 'unset', 'batch-unset'] as const)(
    'keeps derived %s property writes unattributed in a children-backed workspace', async mode => {
      await db.db.execute(`INSERT INTO workspaces
        (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
        VALUES (?, 'Test', 'vlad', 1, 1, 'none', NULL, 'children')`, [WS])
      repo.setActiveWorkspaceId(WS)
      await create(repo.withTxContext({contributorId: null}))
      await repo.withTxContext({contributorId: null}).tx(tx => tx.setProperty('note', contributorRoleProp, 'Before'), opts)
      const scout = repo.withTxContext({contributorId: 'scout'})
      await scout.tx(async tx => {
        const skipped = {skipMetadata: true}
        if (mode === 'set') await tx.setProperty('note', contributorRoleProp, 'After', skipped)
        if (mode === 'batch') await tx.setProperties('note', {set: [{schema: contributorRoleProp, value: 'After'}]}, skipped)
        if (mode === 'replace') await tx.update('note', {properties: {[contributorRoleProp.name]: 'After'}}, skipped)
        if (mode === 'unset') await tx.unsetProperty('note', contributorRoleProp, skipped)
        if (mode === 'batch-unset') await tx.setProperties('note', {unset: [contributorRoleProp]}, skipped)
      }, opts)
      expect(await read('note', contributorRoleProp.name)).toBe(mode.includes('unset') ? undefined : 'After')
      expect(await read('note', attributionCreatorsProp.name)).toBeUndefined()
      expect(await read('note', attributionEditorsProp.name)).toBeUndefined()
    },
  )

  it('does not treat rows generated by a same-transaction processor as authored notes', async () => {
    repo.__setSameTxProcessorsForTesting([
      defineSameTxProcessor({
        name: 'test.deriveAuxiliaryRow',
        watches: {kind: 'field', table: 'blocks', fields: ['content']},
        apply: async (_event, ctx) => {
          await ctx.tx.create({id: 'auxiliary', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Computed'})
        },
      }),
      ...repo.facetRuntime!.read(sameTxProcessorsFacet).values(),
    ])
    await create(repo.withTxContext({contributorId: 'atlas'}))
    expect((await repo.load('auxiliary'))?.content).toBe('Computed')
    expect(await read('auxiliary', attributionCreatorsProp.name)).toBeUndefined()
    expect(await read('note', attributionCreatorsProp.name)).toEqual(['atlas'])
  })

  it('does not suppress a concurrent direct edit while materializing a derived property', async () => {
    await db.db.execute(`INSERT INTO workspaces
      (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
      VALUES (?, 'Test', 'vlad', 1, 1, 'none', NULL, 'children')`, [WS])
    repo.setActiveWorkspaceId(WS)
    await create(repo.withTxContext({contributorId: null}), 'derived')
    await create(repo.withTxContext({contributorId: null}), 'authored')
    await repo.withTxContext({contributorId: 'scout'}).tx(async tx => {
      await Promise.all([
        tx.setProperty('derived', contributorRoleProp, 'Computed', {skipMetadata: true}),
        tx.update('authored', {content: 'Authored edit'}),
      ])
    }, opts)
    expect(await read('derived', contributorRoleProp.name)).toBe('Computed')
    expect((await repo.load('authored'))?.content).toBe('Authored edit')
    expect(await read('derived', attributionEditorsProp.name)).toBeUndefined()
    expect(await read('authored', attributionEditorsProp.name)).toEqual(['scout'])
  })

  it.each(['before', 'after'] as const)('restores the human user page deleted %s contributor setup', async when => {
    if (when === 'before') {
      await repo.withTxContext({contributorId: null}).tx(async tx => {
        await tx.create({id: HUMAN, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Vlad',
          properties: {[typesProp.name]: [PAGE_TYPE], [aliasesProp.name]: ['Vlad', 'vlad']}})
      }, opts)
    } else {
      await create(repo, 'first')
      expect(await read(HUMAN, typesProp.name)).toContain(CONTRIBUTOR_TYPE)
    }
    await repo.withTxContext({contributorId: null}).tx(tx => tx.delete(HUMAN), opts)
    expect(await repo.load(HUMAN)).toBeNull()
    await create(repo)
    expect((await repo.load(HUMAN))?.deleted).toBe(false)
    expect(await read(HUMAN, typesProp.name)).toContain(CONTRIBUTOR_TYPE)
    expect(await read(HUMAN, contributorKindProp.name)).toBe('human')
    expect(await read('note', attributionCreatorsProp.name)).toEqual([HUMAN])
  })

  it('refuses a live foreign occupant of the deterministic user-page id before returning it', async () => {
    await repo.withTxContext({contributorId: null}).tx(tx => tx.create({
      id: HUMAN, workspaceId: 'other', parentId: null, orderKey: 'a0', content: 'Foreign',
    }), opts)
    await expect(repo.tx(tx => ensureUserPageInTx(
      tx, WS, {id: 'vlad', name: 'Vlad'}, repo.snapshotTypeRegistries(),
    ), opts)).rejects.toThrow('The user page belongs to another workspace.')
    expect((await repo.load(HUMAN))?.content).toBe('Foreign')
  })

  it('records a real edit when the display timestamp stays in the same millisecond', async () => {
    await create(repo.withTxContext({contributorId: 'atlas'}))
    const before = await repo.load('note')
    await repo.withTxContext({contributorId: 'scout'}).tx(tx => tx.update('note', {content: 'Changed'}), opts)
    expect((await repo.load('note'))?.userUpdatedAt).toBe(before?.userUpdatedAt)
    expect(await read('note', attributionEditorsProp.name)).toEqual(['scout'])
  })

  it('rejects missing, deleted, untyped, and foreign contributor pages atomically', async () => {
    await repo.withTxContext({contributorId: null}).tx(async tx => {
      await tx.create({id: 'foreign', workspaceId: 'other', parentId: null, orderKey: 'a0', content: 'Foreign',
        properties: {[typesProp.name]: [PAGE_TYPE, CONTRIBUTOR_TYPE]}})
    }, opts)
    await repo.withTxContext({contributorId: null}).tx(async tx => {
      await tx.create({id: 'untyped', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Untyped'})
      await tx.delete('scout')
    }, opts)
    for (const id of ['missing', 'scout', 'untyped', 'foreign']) {
      await expect(create(repo.withTxContext({contributorId: id}))).rejects.toThrow(/contributor/i)
      expect(await repo.load('note')).toBeNull()
    }
  })

  it('binds block and grouped writes to their own context while other clients keep theirs', async () => {
    await create(repo.withTxContext({contributorId: null}))
    const atlas = repo.withTxContext({contributorId: 'atlas'})
    await atlas.undoGroup(async grouped => {
      await grouped.block('note').setContent('From Atlas')
    })
    expect(await read('note', attributionEditorsProp.name)).toEqual(['atlas'])
    await repo.withTxContext({contributorId: 'scout'}).tx(tx => tx.update('note', {content: 'From Scout'}), opts)
    await repo.tx(tx => tx.update('note', {content: 'From human'}), opts)
    expect(await read('note', attributionEditorsProp.name)).toEqual(['atlas', 'scout', HUMAN])
  })

  it('attributes property value edits to the owner in a children-backed workspace', async () => {
    await db.db.execute(`INSERT INTO workspaces
      (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
      VALUES (?, 'Test', 'vlad', 1, 1, 'none', NULL, 'children')`, [WS])
    repo.setActiveWorkspaceId(WS)
    await create(repo.withTxContext({contributorId: 'atlas'}))
    await repo.withTxContext({contributorId: 'scout'}).tx(tx => tx.setProperty('note', contributorRoleProp, 'First'), opts)
    expect(await read('note', attributionEditorsProp.name)).toEqual(['scout'])
    const fieldId = propertyDefinitionBlockId(WS, contributorRoleProp.seedKey)
    const field = await db.db.get<{id: string}>('SELECT id FROM blocks WHERE parent_id = ? AND content = ? AND deleted = 0',
      ['note', propertyFieldContent(fieldId)])
    const value = await db.db.get<{id: string}>('SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0', [field.id])
    await repo.block(value.id).setContent('Second')
    expect(await read('note', contributorRoleProp.name)).toBe('Second')
    expect(await read('note', attributionEditorsProp.name)).toEqual(['scout', HUMAN])
    expect(await read(value.id, attributionEditorsProp.name)).toBeUndefined()
    expect(await read(field.id, attributionCreatorsProp.name)).toBeUndefined()
    await repo.withTxContext({contributorId: 'atlas'}).tx(tx => tx.delete(value.id), opts)
    expect(await read('note', contributorRoleProp.name)).toBeUndefined()
    expect(await read('note', attributionEditorsProp.name)).toEqual(['scout', HUMAN, 'atlas'])
  })

  it('undoes attribution together with the content edit', async () => {
    repo.setActiveWorkspaceId(WS)
    await create(repo.withTxContext({contributorId: 'atlas'}))
    await repo.withTxContext({contributorId: 'scout'}).tx(tx => tx.update('note', {content: 'Revision'}), opts)
    expect(await read('note', attributionEditorsProp.name)).toEqual(['scout'])
    await repo.undo(ChangeScope.BlockDefault)
    expect((await repo.load('note'))?.content).toBe('Original')
    expect(await read('note', attributionEditorsProp.name)).toBeUndefined()
  })
})
