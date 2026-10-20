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
import {deleteProperty} from '@/components/propertyPanel/actions'

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
  it('keeps human-only notes quiet and records human edits to agent-authored notes', async () => {
    await create(repo, 'human-note')
    await repo.tx(tx => tx.update('human-note', {content: 'Human revision'}), opts)
    expect(await read('human-note', attributionCreatorsProp.name)).toBeUndefined()
    expect(await read('human-note', attributionEditorsProp.name)).toBeUndefined()
    expect(await db.db.getAll('SELECT source_id FROM block_references WHERE target_id = ?', [HUMAN])).toEqual([])
    expect(await repo.load(HUMAN)).toBeNull()
    await create(repo.withTxContext({contributorId: 'atlas'}))
    await repo.tx(tx => tx.update('note', {content: 'Human revision'}), opts)
    expect(await read('note', attributionCreatorsProp.name)).toEqual(['atlas'])
    expect(await read('note', attributionEditorsProp.name)).toEqual([HUMAN])
    expect(await read(HUMAN, typesProp.name)).toContain(CONTRIBUTOR_TYPE)
    expect(await read(HUMAN, aliasesProp.name)).toEqual(['Vlad', 'vlad'])
  })

  it('records a human edit after an agent modifies an existing human-only note', async () => {
    await create(repo)
    await repo.withTxContext({contributorId: 'atlas'}).tx(tx => tx.update('note', {content: 'Agent revision'}), opts)
    expect(await read('note', attributionCreatorsProp.name)).toBeUndefined()
    expect(await read('note', attributionEditorsProp.name)).toEqual(['atlas'])
    await repo.tx(tx => tx.update('note', {content: 'Human follow-up'}), opts)
    expect(await read('note', attributionEditorsProp.name)).toEqual(['atlas', HUMAN])
  })

  it('keeps a note with only a user-page contributor quiet when its stored kind has drifted', async () => {
    await create(repo)
    await repo.withTxContext({contributorId: null}).tx(async tx => {
      await ensureUserPageInTx(tx, WS, repo.user, repo.snapshotTypeRegistries())
      await repo.addTypeInTx(tx, HUMAN, CONTRIBUTOR_TYPE, {[contributorKindProp.name]: 'agent'})
      await tx.setProperty('note', attributionCreatorsProp, [HUMAN])
    }, opts)
    expect(await read(HUMAN, contributorKindProp.name)).toBe('agent')
    await repo.tx(tx => tx.update('note', {content: 'Human revision'}), opts)
    expect((await repo.load('note'))?.content).toBe('Human revision')
    expect(await read('note', attributionEditorsProp.name)).toBeUndefined()
  })

  it('rejects a human actor inside an external transaction, even without command admission', async () => {
    await create(repo.withTxContext({contributorId: 'atlas'}))
    await repo.tx(tx => tx.update('note', {content: 'Human revision'}), opts)
    await expect(create(repo.withTxContext({contributorId: HUMAN, contributorSource: 'agent'}), 'disguised'))
      .rejects.toThrow(/agent or automation/)
    expect(await repo.load('disguised')).toBeNull()
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

  it.each([false, true])('requires selection for external attribution corrections without appending an editor (children: %s)', async children => {
    if (children) {
      await db.db.execute(`INSERT INTO workspaces
        (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
        VALUES (?, 'Test', 'vlad', 1, 1, 'none', NULL, 'children')`, [WS])
      repo.setActiveWorkspaceId(WS)
    }
    await create(repo.withTxContext({contributorId: 'atlas'}))
    const external = repo.withTxContext({contributorSource: 'agent'})
    await expect(external.tx(tx => tx.setProperty('note', attributionCreatorsProp, []), opts))
      .rejects.toThrow(/Choose a contributor/)
    expect(await read('note', attributionCreatorsProp.name)).toEqual(['atlas'])

    await external.withTxContext({contributorId: 'atlas'}).tx(tx => tx.setProperties('note', {set: [
      {schema: attributionCreatorsProp, value: ['scout']},
      {schema: attributionEditorsProp, value: []},
    ]}), opts)
    expect(await read('note', attributionCreatorsProp.name)).toEqual(['scout'])
    expect(await read('note', attributionEditorsProp.name)).toEqual([])
  })

  it.each(['missing', 'untyped', 'foreign'] as const)('rejects a %s profile in an external attribution correction, including explicit opt-out', async invalid => {
    await create(repo.withTxContext({contributorId: 'atlas'}))
    await repo.withTxContext({contributorId: null}).tx(async tx => {
      await tx.create({id: 'untyped', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Ordinary note'})
    }, opts)
    await repo.withTxContext({contributorId: null}).tx(async tx => {
      await tx.create({id: 'foreign', workspaceId: 'other', parentId: null, orderKey: 'a0', content: 'Foreign profile',
        properties: {[typesProp.name]: [PAGE_TYPE, CONTRIBUTOR_TYPE]}})
    }, opts)
    for (const contributorId of ['atlas', null]) {
      const external = repo.withTxContext({contributorSource: 'agent', contributorId})
      await expect(external.tx(tx => tx.setProperty('note', attributionCreatorsProp, [invalid]), opts))
        .rejects.toThrow(/Contributor.*profile.*workspace/)
      expect(await read('note', attributionCreatorsProp.name)).toEqual(['atlas'])
    }
  })

  it('accepts a historical deleted profile in a correction and preserves an explicit editor correction alongside content', async () => {
    await create(repo.withTxContext({contributorId: 'atlas'}))
    await repo.withTxContext({contributorId: null}).tx(tx => tx.delete('scout'), opts)
    await repo.withTxContext({contributorSource: 'agent', contributorId: 'atlas'}).tx(async tx => {
      await tx.update('note', {content: 'Corrected'})
      await tx.setProperty('note', attributionCreatorsProp, ['scout'])
      await tx.setProperty('note', attributionEditorsProp, [])
    }, opts)
    expect(await read('note', attributionCreatorsProp.name)).toEqual(['scout'])
    expect(await read('note', attributionEditorsProp.name)).toEqual([])
  })

  it.each(['missing', ''] as const)('validates the selected actor even for correction-only writes (%s)', async contributorId => {
    await create(repo.withTxContext({contributorId: 'atlas'}))
    await expect(repo.withTxContext({contributorSource: 'agent', contributorId}).tx(tx =>
      tx.setProperty('note', attributionCreatorsProp, ['scout']), opts,
    )).rejects.toThrow(/Contributor.*live Contributor profile/)
    expect(await read('note', attributionCreatorsProp.name)).toEqual(['atlas'])
  })

  it('requires selection for direct attribution-value edits in children-backed storage', async () => {
    await db.db.execute(`INSERT INTO workspaces
      (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
      VALUES (?, 'Test', 'vlad', 1, 1, 'none', NULL, 'children')`, [WS])
    repo.setActiveWorkspaceId(WS)
    await create(repo.withTxContext({contributorId: 'atlas'}))
    const fieldId = propertyDefinitionBlockId(WS, attributionCreatorsProp.seedKey)
    const field = await db.db.get<{id: string}>('SELECT id FROM blocks WHERE parent_id = ? AND content = ? AND deleted = 0',
      ['note', propertyFieldContent(fieldId)])
    const value = await db.db.get<{id: string}>('SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0', [field.id])
    const external = repo.withTxContext({contributorSource: 'agent'})
    await expect(external.tx(tx => tx.delete(value.id), opts)).rejects.toThrow(/Choose a contributor/)
    expect(await read('note', attributionCreatorsProp.name)).toEqual(['atlas'])

    await external.withTxContext({contributorId: 'atlas'}).tx(tx => tx.delete(value.id), opts)
    expect(await read('note', attributionCreatorsProp.name)).toEqual([])
    expect(await read('note', attributionEditorsProp.name)).toBeUndefined()
  })

  it.each([false, true])('honors property-panel removals and batch unsets (children: %s)', async children => {
    if (children) {
      await db.db.execute(`INSERT INTO workspaces
        (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
        VALUES (?, 'Test', 'vlad', 1, 1, 'none', NULL, 'children')`, [WS])
    }
    repo.setActiveWorkspaceId(WS)
    await create(repo.withTxContext({contributorId: 'atlas'}))
    await repo.withTxContext({contributorId: 'scout'}).tx(tx => tx.update('note', {content: 'Revision'}), opts)
    for (const schema of [attributionCreatorsProp, attributionEditorsProp]) {
      await deleteProperty({block: repo.block('note'), properties: (await repo.load('note'))!.properties,
        schemas: repo.propertySchemas, uis: new Map(), name: schema.name})
      expect(await read('note', schema.name)).toBeUndefined()
    }
    await repo.tx(tx => tx.setProperties('note', {set: [
      {schema: attributionCreatorsProp, value: ['atlas']}, {schema: attributionEditorsProp, value: ['scout']},
    ]}), opts)
    await repo.tx(tx => tx.setProperties('note', {unset: [attributionCreatorsProp, attributionEditorsProp]}), opts)
    expect(await read('note', attributionCreatorsProp.name)).toBeUndefined()
    expect(await read('note', attributionEditorsProp.name)).toBeUndefined()
  })

  it.each(['single', 'batch'] as const)('honors an explicit %s clear after replacement in the same transaction', async mode => {
    await create(repo.withTxContext({contributorId: 'atlas'}))
    await repo.withTxContext({contributorId: 'scout'}).tx(tx => tx.update('note', {content: 'Revision'}), opts)
    await repo.tx(async tx => {
      await tx.update('note', {properties: {}})
      if (mode === 'single') await tx.unsetProperty('note', attributionCreatorsProp)
      else await tx.setProperties('note', {unset: [attributionCreatorsProp]})
    }, opts)
    expect(await read('note', attributionCreatorsProp.name)).toBeUndefined()
    expect(await read('note', attributionEditorsProp.name)).toEqual(['scout'])
  })

  it('does not attribute no-ops, bookkeeping writes, or explicit unattributed work', async () => {
    await create(repo.withTxContext({contributorId: null}))
    const scout = repo.withTxContext({contributorId: 'scout'})
    await scout.tx(tx => tx.update('note', {content: 'Original'}), opts)
    await scout.tx(tx => tx.update('note', {content: 'Derived'}, {skipMetadata: true}), opts)
    expect(await read('note', attributionCreatorsProp.name)).toBeUndefined()
    expect(await read('note', attributionEditorsProp.name)).toBeUndefined()
  })

  it('allows unconfigured external bookkeeping and no-ops, but rolls back a meaningful edit', async () => {
    await create(repo.withTxContext({contributorId: null}))
    const external = repo.withTxContext({contributorSource: 'agent'})
    await external.tx(tx => tx.update('note', {content: 'Derived'}, {skipMetadata: true}), opts)
    expect((await repo.load('note'))?.content).toBe('Derived')
    await external.tx(tx => tx.update('note', {content: 'Derived'}), opts)
    await expect(external.tx(tx => tx.update('note', {content: 'Authored'}), opts))
      .rejects.toThrow(/Choose a contributor/)
    expect((await repo.load('note'))?.content).toBe('Derived')
    expect(await read('note', attributionEditorsProp.name)).toBeUndefined()
  })

  const nonDocumentScopeCases = [
    ['ui-state', ChangeScope.UiState],
    ['user-prefs', ChangeScope.UserPrefs],
    ['automation', ChangeScope.Automation],
    ['references', ChangeScope.References],
  ] as const
  const actorCases = [
    ['unconfigured', {contributorSource: 'agent'}],
    ['selected', {contributorSource: 'agent', contributorId: 'atlas'}],
  ] as const
  it.each(nonDocumentScopeCases.flatMap(([scopeName, scope]) => actorCases.map(([actorName, context]) =>
    [scopeName, actorName, scope, context] as const,
  )))('%s scope stays quiet for the %s external actor', async (scopeName, actorName, scope, context) => {
    const host = repo.withTxContext(context)
    const id = `${scopeName}-${actorName}`
    await host.tx(tx => tx.create({
      id, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Created in non-document scope',
    }), {scope})
    expect((await repo.load(id))?.content).toBe('Created in non-document scope')
    expect(await read(id, attributionCreatorsProp.name)).toBeUndefined()
    expect(await read(id, attributionEditorsProp.name)).toBeUndefined()

    await host.tx(tx => tx.update(id, {content: 'Updated in non-document scope'}), {scope})
    expect((await repo.load(id))?.content).toBe('Updated in non-document scope')
    expect(await read(id, attributionCreatorsProp.name)).toBeUndefined()
    expect(await read(id, attributionEditorsProp.name)).toBeUndefined()
  })

  it.each(['parent', 'order'] as const)('requires selection and credits a pure %s move', async field => {
    await create(repo, 'parent')
    await create(repo)
    const target = {parentId: field === 'parent' ? 'parent' : null, orderKey: field === 'order' ? 'a1' : 'a0'}
    const external = repo.withTxContext({contributorSource: 'agent'})
    await expect(external.tx(tx => tx.move('note', target), opts)).rejects.toThrow(/Choose a contributor/)
    expect((await repo.load('note'))?.parentId).toBeNull()
    expect((await repo.load('note'))?.orderKey).toBe('a0')
    await external.withTxContext({contributorId: 'atlas'}).tx(tx => tx.move('note', target), opts)
    expect(await repo.load('note')).toMatchObject(target)
    expect(await read('note', attributionEditorsProp.name)).toEqual(['atlas'])
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
      await create(repo.withTxContext({contributorId: 'atlas'}), 'first')
      await repo.tx(tx => tx.update('first', {content: 'Human revision'}), opts)
      expect(await read(HUMAN, typesProp.name)).toContain(CONTRIBUTOR_TYPE)
    }
    await repo.withTxContext({contributorId: null}).tx(tx => tx.delete(HUMAN), opts)
    expect(await repo.load(HUMAN)).toBeNull()
    await create(repo.withTxContext({contributorId: 'atlas'}))
    await repo.tx(tx => tx.update('note', {content: 'Human revision'}), opts)
    expect((await repo.load(HUMAN))?.deleted).toBe(false)
    expect(await read(HUMAN, typesProp.name)).toContain(CONTRIBUTOR_TYPE)
    expect(await read(HUMAN, contributorKindProp.name)).toBe('human')
    expect(await read('note', attributionEditorsProp.name)).toEqual([HUMAN])
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

  it('credits both owners when an agent moves a property field between them', async () => {
    await db.db.execute(`INSERT INTO workspaces
      (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
      VALUES (?, 'Test', 'vlad', 1, 1, 'none', NULL, 'children')`, [WS])
    repo.setActiveWorkspaceId(WS)
    await create(repo.withTxContext({contributorId: 'atlas'}), 'owner-a')
    await create(repo.withTxContext({contributorId: 'atlas'}), 'owner-b')
    await repo.withTxContext({contributorId: null}).tx(tx =>
      tx.setProperty('owner-a', contributorRoleProp, 'Researcher'), opts,
    )

    const fieldId = propertyDefinitionBlockId(WS, contributorRoleProp.seedKey)
    const field = await db.db.get<{id: string}>(
      'SELECT id FROM blocks WHERE parent_id = ? AND content = ? AND deleted = 0',
      ['owner-a', propertyFieldContent(fieldId)],
    )
    expect(field).toBeDefined()
    expect(await read('owner-a', contributorRoleProp.name)).toBe('Researcher')
    expect(await read('owner-b', contributorRoleProp.name)).toBeUndefined()
    expect(await read('owner-a', attributionEditorsProp.name)).toBeUndefined()
    expect(await read('owner-b', attributionEditorsProp.name)).toBeUndefined()

    await repo.withTxContext({contributorId: 'scout'}).tx(tx =>
      tx.move(field!.id, {parentId: 'owner-b', orderKey: 'a0'}), opts,
    )

    expect(await read('owner-a', contributorRoleProp.name)).toBeUndefined()
    expect(await read('owner-b', contributorRoleProp.name)).toBe('Researcher')
    expect(await read('owner-a', attributionEditorsProp.name)).toEqual(['scout'])
    expect(await read('owner-b', attributionEditorsProp.name)).toEqual(['scout'])
    expect(await read('owner-a', attributionCreatorsProp.name)).toEqual(['atlas'])
    expect(await read('owner-b', attributionCreatorsProp.name)).toEqual(['atlas'])
    expect(await read(field.id, attributionCreatorsProp.name)).toBeUndefined()
    expect(await read(field.id, attributionEditorsProp.name)).toBeUndefined()
  })

  it('credits both owners when an agent moves a property value between fields', async () => {
    await db.db.execute(`INSERT INTO workspaces
      (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
      VALUES (?, 'Test', 'vlad', 1, 1, 'none', NULL, 'children')`, [WS])
    repo.setActiveWorkspaceId(WS)
    await create(repo.withTxContext({contributorId: 'atlas'}), 'owner-a')
    await create(repo.withTxContext({contributorId: 'atlas'}), 'owner-b')
    await repo.withTxContext({contributorId: null}).tx(async tx => {
      await tx.setProperty('owner-a', contributorRoleProp, 'Researcher')
      await tx.setProperty('owner-b', contributorRoleProp, 'Temporary')
    }, opts)

    const fieldId = propertyDefinitionBlockId(WS, contributorRoleProp.seedKey)
    const fieldFor = async (ownerId: string) => db.db.get<{id: string}>(
      'SELECT id FROM blocks WHERE parent_id = ? AND content = ? AND deleted = 0',
      [ownerId, propertyFieldContent(fieldId)],
    )
    const sourceField = await fieldFor('owner-a')
    const destinationField = await fieldFor('owner-b')
    expect(sourceField).toBeDefined()
    expect(destinationField).toBeDefined()
    const sourceValue = await db.db.get<{id: string}>(
      'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0', [sourceField!.id],
    )
    const destinationValue = await db.db.get<{id: string}>(
      'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0', [destinationField!.id],
    )
    expect(sourceValue).toBeDefined()
    expect(destinationValue).toBeDefined()
    await repo.withTxContext({contributorId: null}).tx(tx => tx.delete(destinationValue!.id), opts)
    expect(await read('owner-a', contributorRoleProp.name)).toBe('Researcher')
    expect(await read('owner-b', contributorRoleProp.name)).toBeUndefined()
    expect(await read('owner-a', attributionEditorsProp.name)).toBeUndefined()
    expect(await read('owner-b', attributionEditorsProp.name)).toBeUndefined()

    await repo.withTxContext({contributorId: 'scout'}).tx(tx =>
      tx.move(sourceValue!.id, {parentId: destinationField!.id, orderKey: 'a0'}), opts,
    )

    expect(await read('owner-a', contributorRoleProp.name)).toBeUndefined()
    expect(await read('owner-b', contributorRoleProp.name)).toBe('Researcher')
    expect(await read('owner-a', attributionEditorsProp.name)).toEqual(['scout'])
    expect(await read('owner-b', attributionEditorsProp.name)).toEqual(['scout'])
    expect(await read('owner-a', attributionCreatorsProp.name)).toEqual(['atlas'])
    expect(await read('owner-b', attributionCreatorsProp.name)).toEqual(['atlas'])
    expect(await read(sourceValue!.id, attributionCreatorsProp.name)).toBeUndefined()
    expect(await read(sourceValue!.id, attributionEditorsProp.name)).toBeUndefined()
    expect(await read(sourceField!.id, attributionEditorsProp.name)).toBeUndefined()
    expect(await read(destinationField!.id, attributionEditorsProp.name)).toBeUndefined()
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
