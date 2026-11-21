// @vitest-environment node
/**
 * A user edit of a property's value row moves its OWNER's display edit time
 * (`user_updated_at`), as `setProperty` does: the projection that rewrites the
 * owner's cell carries the edit's stamp. Derived, processor and sync-shaped
 * projections leave it alone.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, codecs, defineProperty, defineSameTxProcessor, type AnyPropertySchema } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { projectedPropertyDefinitionsFacet, sameTxProcessorsFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { PROPERTY_VALUES_RESOLVED_EVENT } from './internals/propertyChildrenProcessor'
import type { Repo } from './repo'

const WS = 'ws-value-edit-time'
const STATUS_FIELD_ID = 'field-status-edit-time'

const statusSchema = defineProperty('status', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  await sharedDb.db.execute(
    `INSERT INTO workspaces
       (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
     VALUES (?, 'test ws', 'user-1', 1, 1, 'none', NULL, 'children')`,
    [WS],
  )
})

const registerDefinition = (repo: Repo, fieldId: string, schema: AnyPropertySchema): void => {
  repo.setRuntimeContributions(
    projectedPropertyDefinitionsFacet,
    `test-definition-${fieldId}`,
    [{
      metadata: {
        fieldId, workspaceId: WS, createdAt: 1,
        name: schema.name, changeScope: schema.changeScope,
        hidden: false, origin: 'user' as const,
      },
      schema,
    }],
    {workspaceId: WS},
  )
}

const setup = (extraProcessors: Parameters<typeof sameTxProcessorsFacet.of>[0][] = []): Repo => {
  const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
  if (extraProcessors.length > 0) {
    repo.setFacetRuntime(resolveFacetRuntimeSync([
      kernelDataExtension,
      ...extraProcessors.map(processor => sameTxProcessorsFacet.of(processor, {source: 'test'})),
    ]))
  }
  repo.setActiveWorkspaceId(WS)
  registerDefinition(repo, STATUS_FIELD_ID, statusSchema)
  return repo
}

interface OwnerStamp {user_updated_at: number; updated_by: string; properties_json: string}

const ownerStamp = (id: string): Promise<OwnerStamp> =>
  sharedDb.db.get<OwnerStamp>(
    'SELECT user_updated_at, updated_by, properties_json FROM blocks WHERE id = ?', [id])

const cellValue = async (id: string): Promise<unknown> =>
  (JSON.parse((await ownerStamp(id)).properties_json) as Record<string, unknown>)[statusSchema.name]

/** Owner `p` holding status = 'draft' through a field row and one value row. */
const seedOwner = async (repo: Repo): Promise<{fieldId: string; valueId: string}> => {
  await repo.tx(async tx => {
    await tx.create({id: 'p', workspaceId: WS, parentId: null, orderKey: 'k-p', content: ''})
    await tx.setProperty('p', statusSchema, 'draft')
  }, {scope: ChangeScope.BlockDefault})
  const field = await sharedDb.db.get<{id: string}>(
    'SELECT id FROM blocks WHERE parent_id = ? AND reference_target_id = ? AND deleted = 0',
    ['p', STATUS_FIELD_ID])
  const value = await sharedDb.db.get<{id: string}>(
    'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0', [field.id])
  return {fieldId: field.id, valueId: value.id}
}

describe('owner edit time follows a user edit of a property value row', () => {
  it('a value-row content edit moves the owner\'s user_updated_at in the one owner write', async () => {
    const repo = setup()
    const {valueId} = await seedOwner(repo)
    const before = await ownerStamp('p')
    await sharedDb.db.execute('DELETE FROM row_events')

    await repo.tx(tx => tx.update(valueId, {content: 'shipped'}), {scope: ChangeScope.BlockDefault})

    expect(await cellValue('p')).toBe('shipped')
    const after = await ownerStamp('p')
    expect(after.user_updated_at).toBeGreaterThan(before.user_updated_at)
    expect(after.updated_by).toBe('user-1')
    // The stamp rides the cell write the projection already made: one owner
    // update, not a second one for the time.
    const ownerEvents = await sharedDb.db.getAll<{id: number}>(
      `SELECT id FROM row_events WHERE block_id = 'p'`)
    expect(ownerEvents).toHaveLength(1)
  })

  it('deleting the value row moves the owner\'s user_updated_at', async () => {
    const repo = setup()
    const {valueId} = await seedOwner(repo)
    const before = await ownerStamp('p')

    await repo.tx(tx => tx.delete(valueId), {scope: ChangeScope.BlockDefault})

    expect(await cellValue('p')).toBeUndefined()
    expect((await ownerStamp('p')).user_updated_at).toBeGreaterThan(before.user_updated_at)
  })

  it('an edit that leaves the projected value unchanged leaves the owner alone', async () => {
    const repo = setup()
    const {fieldId, valueId} = await seedOwner(repo)
    const before = await ownerStamp('p')

    // Reordering the only value row is a projection-watched change whose
    // projection is the same 'draft'.
    await repo.tx(tx => tx.move(valueId, {parentId: fieldId, orderKey: 'zz'}),
      {scope: ChangeScope.BlockDefault})

    expect(await cellValue('p')).toBe('draft')
    expect(await ownerStamp('p')).toEqual(before)
  })

  it('a sync-shaped arrival projected later leaves the owner\'s time where it was', async () => {
    const repo = setup()
    const {valueId} = await seedOwner(repo)
    const before = await ownerStamp('p')

    // A peer's value edit lands as a raw write: no processor sees it.
    await sharedDb.db.writeTransaction(async db => {
      await db.execute('UPDATE blocks SET content = ? WHERE id = ?', ['arrived', valueId])
    })
    // The resolved-values pass (Repo.reprojectResolvedPropertyValues) then
    // projects it in a tx that wrote nothing of its own.
    await repo.tx(async tx => {
      tx.emitEvent(PROPERTY_VALUES_RESOLVED_EVENT, {workspaceId: WS, valueIds: [valueId]}, WS)
    }, {scope: ChangeScope.References})

    expect(await cellValue('p')).toBe('arrived')
    expect((await ownerStamp('p')).user_updated_at).toBe(before.user_updated_at)
  })

  it('a processor rewriting a value row leaves the owner\'s time where it was', async () => {
    let valueToRewrite: string | null = null
    const rewriter = defineSameTxProcessor({
      name: 'test.rewriteValueOnTrigger',
      watches: {kind: 'field', table: 'blocks', fields: ['content']},
      apply: async (event, ctx) => {
        if (valueToRewrite === null) return
        if (!event.changedRows.some(row => row.id === 'trigger')) return
        await ctx.tx.update(valueToRewrite, {content: 'rewritten'})
      },
    })
    const repo = setup([rewriter])
    const {valueId} = await seedOwner(repo)
    await repo.tx(tx => tx.create({id: 'trigger', workspaceId: WS, parentId: null, orderKey: 'k-t', content: ''}),
      {scope: ChangeScope.BlockDefault})
    const before = await ownerStamp('p')
    valueToRewrite = valueId

    await repo.tx(tx => tx.update('trigger', {content: 'go'}), {scope: ChangeScope.BlockDefault})

    expect(await cellValue('p')).toBe('rewritten')
    expect((await ownerStamp('p')).user_updated_at).toBe(before.user_updated_at)
  })

  it('undo of the value edit restores the owner\'s cell and never moves its time back', async () => {
    const repo = setup()
    const {valueId} = await seedOwner(repo)

    await repo.tx(tx => tx.update(valueId, {content: 'shipped'}), {scope: ChangeScope.BlockDefault})
    const edited = await ownerStamp('p')
    await repo.undo(ChangeScope.BlockDefault)

    // Undo is itself a user edit (`applyRaw` stamps replayed rows `now`), and
    // the server clamps `user_updated_at` to move forward only.
    expect(await cellValue('p')).toBe('draft')
    expect((await ownerStamp('p')).user_updated_at).toBeGreaterThanOrEqual(edited.user_updated_at)
  })
})
