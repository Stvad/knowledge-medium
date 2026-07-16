// @vitest-environment node
/**
 * Properties-as-blocks slice B1 (PR #288 §5/§6/§9): dual-writing
 * `tx.setProperty`, the project/materialize processor pair, and the
 * `childrenOf` visible-children exclusion — all gated on the per-workspace
 * flip column (`workspaces.properties_migration`), dormant at 'cell'.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, codecs, defineProperty, type BlockData } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { projectedPropertyDefinitionsFacet } from '@/data/facets'
import { mergeBlocksInTx } from './blockMerge'
import type { Repo } from './repo'

const WS = 'ws-prop-children'
const STATUS_FIELD_ID = 'field-status-children'

const statusSchema = defineProperty('status', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db) })

const seedWorkspace = async (
  propertiesMigration: string | null,
): Promise<void> => {
  await sharedDb.db.execute(
    `INSERT INTO workspaces
       (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
     VALUES (?, ?, ?, 1, 1, 'none', NULL, ?)`,
    [WS, 'test ws', 'user-1', propertiesMigration],
  )
}

const setup = (): Repo => {
  const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
  repo.setActiveWorkspaceId(WS)
  repo.setRuntimeContributions(
    projectedPropertyDefinitionsFacet,
    'test-status-definition',
    [{
      metadata: {
        fieldId: STATUS_FIELD_ID,
        workspaceId: WS,
        createdAt: 1,
        name: statusSchema.name,
        changeScope: statusSchema.changeScope,
        hidden: false,
        origin: 'user' as const,
      },
      schema: statusSchema,
    }],
    {workspaceId: WS},
  )
  return repo
}

/** Definition-block stand-in so the SQL visible-children predicate (which
 *  binds definition-ness to `block_types`) recognizes the fieldId. */
const seedDefinitionBlock = async (repo: Repo): Promise<void> => {
  await repo.tx(async tx => {
    await tx.create({
      id: STATUS_FIELD_ID, workspaceId: WS, parentId: null, orderKey: 'zz',
      content: 'status', properties: {types: ['property-schema']},
    })
  }, {scope: ChangeScope.BlockDefault})
}

const createBlock = async (repo: Repo, id: string, content = ''): Promise<void> => {
  await repo.tx(async tx => {
    await tx.create({id, workspaceId: WS, parentId: null, orderKey: `k-${id}`, content})
  }, {scope: ChangeScope.BlockDefault})
}

interface ChildRow {
  id: string
  content: string
  reference_target_id: string | null
  deleted: number
}

const childrenRows = async (parentId: string): Promise<ChildRow[]> =>
  sharedDb.db.getAll<ChildRow>(
    `SELECT id, content, reference_target_id, deleted FROM blocks
      WHERE parent_id = ? ORDER BY order_key, id`,
    [parentId],
  )

const liveFieldRows = async (parentId: string): Promise<ChildRow[]> =>
  (await childrenRows(parentId)).filter(
    r => r.deleted === 0 && r.reference_target_id === STATUS_FIELD_ID,
  )

const cellValue = async (id: string): Promise<unknown> => {
  const row = await sharedDb.db.get<{properties_json: string}>(
    'SELECT properties_json FROM blocks WHERE id = ?', [id],
  )
  return (JSON.parse(row.properties_json) as Record<string, unknown>)[statusSchema.name]
}

describe('dormant at properties_migration = cell', () => {
  it('setProperty writes the cell only — no field rows', async () => {
    await seedWorkspace('cell')
    const repo = setup()
    await createBlock(repo, 'p')
    await repo.tx(tx => tx.setProperty('p', statusSchema, 'done'),
      {scope: ChangeScope.BlockDefault})

    expect(await cellValue('p')).toBe('done')
    expect(await childrenRows('p')).toEqual([])
  })

  it('raw cell writes do not materialize children', async () => {
    await seedWorkspace(null) // column absent → reads as 'cell'
    const repo = setup()
    await createBlock(repo, 'p')
    await repo.tx(tx => tx.update('p', {properties: {[statusSchema.name]: 'done'}}),
      {scope: ChangeScope.BlockDefault})

    expect(await childrenRows('p')).toEqual([])
  })
})

describe('flipped workspace (properties_migration = children)', () => {
  it('setProperty dual-writes: field row + value child + cell, one undo step', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'p')
    await repo.tx(tx => tx.setProperty('p', statusSchema, 'done'),
      {scope: ChangeScope.BlockDefault})

    expect(await cellValue('p')).toBe('done')
    const fields = await liveFieldRows('p')
    expect(fields).toHaveLength(1)
    expect(fields[0]!.content).toBe('[[status]]')
    const values = await childrenRows(fields[0]!.id)
    expect(values.filter(v => v.deleted === 0)).toHaveLength(1)
    expect(values[0]!.content).toBe('done')

    // One undo step reverts the whole dual-write.
    await repo.undo(ChangeScope.BlockDefault)
    expect(await cellValue('p')).toBeUndefined()
    expect(await liveFieldRows('p')).toEqual([])
  })

  it('re-setting the property updates the ONE value child (no duplicates)', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'p')
    await repo.tx(tx => tx.setProperty('p', statusSchema, 'draft'),
      {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.setProperty('p', statusSchema, 'done'),
      {scope: ChangeScope.BlockDefault})

    const fields = await liveFieldRows('p')
    expect(fields).toHaveLength(1)
    const values = (await childrenRows(fields[0]!.id)).filter(v => v.deleted === 0)
    expect(values).toHaveLength(1)
    expect(values[0]!.content).toBe('done')
    expect(await cellValue('p')).toBe('done')
  })

  it('the same-tx projection is idempotent — the cell is written once per tx', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'p')
    await sharedDb.db.execute('DELETE FROM row_events')

    await repo.tx(tx => tx.setProperty('p', statusSchema, 'done'),
      {scope: ChangeScope.BlockDefault})

    // §5 invariant 1 (idempotence): project recomputes the cell from the
    // fresh children, finds it equal, and skips — the parent logs exactly
    // ONE update event (the setProperty cell write), not a second from the
    // processor pair ping-ponging.
    const parentUpdates = await sharedDb.db.getAll<{id: number}>(
      `SELECT id FROM row_events WHERE block_id = 'p' AND kind = 'update'`,
    )
    expect(parentUpdates).toHaveLength(1)
  })

  it('editing the value child in the tree reprojects the parent cell', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'p')
    await repo.tx(tx => tx.setProperty('p', statusSchema, 'draft'),
      {scope: ChangeScope.BlockDefault})
    const [field] = await liveFieldRows('p')
    const [value] = (await childrenRows(field!.id)).filter(v => v.deleted === 0)

    await repo.tx(tx => tx.update(value!.id, {content: 'shipped'}),
      {scope: ChangeScope.BlockDefault})
    expect(await cellValue('p')).toBe('shipped')
  })

  it('deleting the field row in the tree removes the cell key', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'p')
    await repo.tx(tx => tx.setProperty('p', statusSchema, 'draft'),
      {scope: ChangeScope.BlockDefault})
    const [field] = await liveFieldRows('p')

    await repo.tx(tx => tx.delete(field!.id), {scope: ChangeScope.BlockDefault})
    expect(await cellValue('p')).toBeUndefined()
  })

  it('raw cell writes materialize field/value children; key removal soft-deletes them', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'p')

    await repo.tx(tx => tx.update('p', {properties: {[statusSchema.name]: 'imported'}}),
      {scope: ChangeScope.BlockDefault})
    const fields = await liveFieldRows('p')
    expect(fields).toHaveLength(1)
    const values = (await childrenRows(fields[0]!.id)).filter(v => v.deleted === 0)
    expect(values.map(v => v.content)).toEqual(['imported'])

    await repo.tx(tx => tx.update('p', {properties: {}}),
      {scope: ChangeScope.BlockDefault})
    expect(await liveFieldRows('p')).toEqual([])
  })

  it('unknown cell keys are left alone (pending §9 orphan synthesis, never deleted)', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'p')
    await repo.tx(tx => tx.update('p', {properties: {'no-such-schema': 42}}),
      {scope: ChangeScope.BlockDefault})

    expect(await childrenRows('p')).toEqual([])
    const row = await sharedDb.db.get<{properties_json: string}>(
      'SELECT properties_json FROM blocks WHERE id = ?', ['p'],
    )
    expect(JSON.parse(row.properties_json)).toEqual({'no-such-schema': 42})
  })
})

describe('childrenOf visible-children exclusion (§9)', () => {
  const setupFlipped = async (): Promise<Repo> => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'p')
    await repo.tx(async tx => {
      await tx.create({
        id: 'content-child', workspaceId: WS, parentId: 'p', orderKey: 'm', content: 'note',
      })
    }, {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.setProperty('p', statusSchema, 'done'),
      {scope: ChangeScope.BlockDefault})
    return repo
  }

  it('default excludes recognized field rows; machinery opts in', async () => {
    const repo = await setupFlipped()
    await repo.tx(async tx => {
      const visible = await tx.childrenOf('p')
      expect(visible.map(c => c.id)).toEqual(['content-child'])
      const all = await tx.childrenOf('p', undefined, {includePropertyChildren: true})
      expect(all).toHaveLength(2)
    }, {scope: ChangeScope.BlockDefault})
  })

  it('inside a property subtree nothing is filtered — a ref-typed value pointing at a definition stays visible', async () => {
    const repo = await setupFlipped()
    const [field] = await liveFieldRows('p')
    // Replace the value child's content with a reference to the DEFINITION
    // block id — its column stamps to a definition id, exactly the §9
    // parent-guard case (block-type:properties-style values).
    const [value] = (await childrenRows(field!.id)).filter(v => v.deleted === 0)
    await repo.tx(tx => tx.update(value!.id, {content: `((${STATUS_FIELD_ID}))`}),
      {scope: ChangeScope.BlockDefault})

    await repo.tx(async tx => {
      const values = await tx.childrenOf(field!.id)
      expect(values.map(v => v.id)).toEqual([value!.id])
    }, {scope: ChangeScope.BlockDefault})
  })

  it('un-flipped workspaces filter nothing even with a stamped column', async () => {
    await seedWorkspace('cell')
    const repo = setup()
    await createBlock(repo, 'p')
    // Hand-author the field-row SHAPE while un-flipped: a plain reference
    // row with a definition-shaped target must stay an ordinary visible
    // child ("machinery lands dormant" — §9 recognition is flip-gated).
    await repo.tx(async tx => {
      await tx.create({
        id: 'ref-child', workspaceId: WS, parentId: 'p', orderKey: 'a',
        content: '[[status]]', referenceTargetId: STATUS_FIELD_ID,
      })
    }, {scope: ChangeScope.BlockDefault})

    await repo.tx(async tx => {
      const visible = await tx.childrenOf('p')
      expect(visible.map(c => c.id)).toEqual(['ref-child'])
    }, {scope: ChangeScope.BlockDefault})
  })
})

describe('merge integration (§9, slice B3)', () => {
  it('re-materializes the merged bag; source field rows tombstone with their values', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'into')
    await createBlock(repo, 'from')
    await repo.tx(tx => tx.setProperty('from', statusSchema, 'from-status'),
      {scope: ChangeScope.BlockDefault})
    const [fromField] = await liveFieldRows('from')

    await repo.tx(async tx => {
      const into = await tx.get('into')
      const from = await tx.get('from')
      await mergeBlocksInTx(tx, {into: into!, from: from!})
    }, {scope: ChangeScope.BlockDefault})

    expect(await cellValue('into')).toBe('from-status')
    // `into` re-materialized its own field/value rows from the merged bag…
    const intoFields = await liveFieldRows('into')
    expect(intoFields).toHaveLength(1)
    // …and `from`'s field row + value child are tombstoned, not carried or
    // stranded live under the tombstone.
    const fromFieldRow = await sharedDb.db.get<{deleted: number}>(
      'SELECT deleted FROM blocks WHERE id = ?', [fromField!.id],
    )
    expect(fromFieldRow.deleted).toBe(1)
    const strandedLive = await sharedDb.db.getAll<{id: string}>(
      `SELECT b.id FROM blocks b JOIN blocks p ON p.id = b.parent_id
        WHERE p.deleted = 1 AND b.deleted = 0 AND b.workspace_id = ?`,
      [WS],
    )
    expect(strandedLive).toEqual([])
  })

  it('preserves user-authored descendants of the source value child', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'into')
    await createBlock(repo, 'from')
    await repo.tx(tx => tx.setProperty('from', statusSchema, 'from-status'),
      {scope: ChangeScope.BlockDefault})
    const [fromField] = await liveFieldRows('from')
    const [fromValue] = (await childrenRows(fromField!.id)).filter(v => v.deleted === 0)
    await repo.tx(async tx => {
      await tx.create({
        id: 'comment', workspaceId: WS, parentId: fromValue!.id, orderKey: 'a',
        content: 'a comment on the value',
      })
    }, {scope: ChangeScope.BlockDefault})

    await repo.tx(async tx => {
      const into = await tx.get('into')
      const from = await tx.get('from')
      await mergeBlocksInTx(tx, {into: into!, from: from!})
    }, {scope: ChangeScope.BlockDefault})

    const comment = await sharedDb.db.get<{deleted: number; parent_id: string}>(
      'SELECT deleted, parent_id FROM blocks WHERE id = ?', ['comment'],
    )
    expect(comment.deleted).toBe(0)
    expect(comment.parent_id).toBe('into')
  })
})

describe('duplicate collapse preservation (§9, slice B3)', () => {
  it('relocates a divergent losing value and its comments instead of silently deleting', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'p')
    // Two concurrent-dual-write-shaped field rows for the same schema, with
    // DIVERGENT values, one carrying a user comment — the §5 duplicate case.
    await repo.tx(async tx => {
      await tx.create({
        id: 'field-a', workspaceId: WS, parentId: 'p', orderKey: 'a',
        content: '[[status]]', referenceTargetId: STATUS_FIELD_ID,
      })
      await tx.create({
        id: 'value-a', workspaceId: WS, parentId: 'field-a', orderKey: 'a', content: 'alpha',
      })
      await tx.create({
        id: 'field-b', workspaceId: WS, parentId: 'p', orderKey: 'b',
        content: '[[status]]', referenceTargetId: STATUS_FIELD_ID,
      })
      await tx.create({
        id: 'value-b', workspaceId: WS, parentId: 'field-b', orderKey: 'a', content: 'beta',
      })
      await tx.create({
        id: 'comment-b', workspaceId: WS, parentId: 'value-b', orderKey: 'a',
        content: 'note on beta',
      })
    }, {scope: ChangeScope.BlockDefault})

    // A REAL cell change triggers materialize, which dedups field rows at
    // 'p' (an equal-value setProperty short-circuits before any write).
    await repo.tx(tx => tx.setProperty('p', statusSchema, 'gamma'),
      {scope: ChangeScope.BlockDefault})

    // Survivor (order_key,id) = field-a; field-b subtree-deleted…
    expect((await liveFieldRows('p')).map(f => f.id)).toEqual(['field-a'])
    const fieldB = await sharedDb.db.get<{deleted: number}>(
      'SELECT deleted FROM blocks WHERE id = ?', ['field-b'],
    )
    expect(fieldB.deleted).toBe(1)
    // …but the DIVERGENT losing value survives visibly under the surviving
    // value child, with its comment thread intact beneath it.
    const valueB = await sharedDb.db.get<{deleted: number; parent_id: string}>(
      'SELECT deleted, parent_id FROM blocks WHERE id = ?', ['value-b'],
    )
    expect(valueB.deleted).toBe(0)
    expect(valueB.parent_id).toBe('value-a')
    const commentB = await sharedDb.db.get<{deleted: number; parent_id: string}>(
      'SELECT deleted, parent_id FROM blocks WHERE id = ?', ['comment-b'],
    )
    expect(commentB.deleted).toBe(0)
    expect(commentB.parent_id).toBe('value-b')
  })
})

describe('delete cascade (machinery traversal, §9)', () => {
  it('softDeleteSubtree tombstones hidden field/value rows with the parent', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'p')
    await repo.tx(tx => tx.setProperty('p', statusSchema, 'done'),
      {scope: ChangeScope.BlockDefault})
    const [field] = await liveFieldRows('p')
    const [value] = (await childrenRows(field!.id)).filter(v => v.deleted === 0)

    await repo.mutate.delete({id: 'p'})

    for (const id of ['p', field!.id, value!.id]) {
      const row = await sharedDb.db.get<{deleted: number}>(
        'SELECT deleted FROM blocks WHERE id = ?', [id],
      )
      expect(row.deleted).toBe(1)
    }
  })
})

describe('flip predicate / SQL gate lock (§6)', () => {
  it('the SQL IN-list matches the TS at-or-past-children predicate exactly', async () => {
    // The TS predicate and the SQL literal must move together: a future
    // state added to one but not the other would silently un-recognize (or
    // over-recognize) every field row on one read surface.
    const {isChildBackedPropertiesWorkspace} = await import('@/types')
    const {VISIBLE_CHILDREN_SQL} = await import('./internals/treeQueries')
    const states = ['cell', 'children', 'cell-off'] as const
    const flipped = states.filter(isChildBackedPropertiesWorkspace)
    expect(flipped).toEqual(['children', 'cell-off'])
    expect(VISIBLE_CHILDREN_SQL).toContain(
      `properties_migration IN (${flipped.map(s => `'${s}'`).join(', ')})`,
    )
  })
})

describe('query-layer twin (core.childIds / core.children)', () => {
  it('excludes field rows in a flipped workspace; opts in for machinery', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await seedDefinitionBlock(repo)
    await createBlock(repo, 'p')
    await repo.tx(async tx => {
      await tx.create({
        id: 'content-child', workspaceId: WS, parentId: 'p', orderKey: 'm', content: 'note',
      })
    }, {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.setProperty('p', statusSchema, 'done'),
      {scope: ChangeScope.BlockDefault})

    const visibleIds = await repo.runQuery('core.childIds', {id: 'p'})
    expect(visibleIds).toEqual(['content-child'])
    const allIds = await repo.runQuery('core.childIds', {id: 'p', includePropertyChildren: true})
    expect(allIds).toHaveLength(2)

    const visible = await repo.runQuery('core.children', {id: 'p'}) as BlockData[]
    expect(visible.map(c => c.id)).toEqual(['content-child'])
  })

  it('is dormant in an un-flipped workspace', async () => {
    await seedWorkspace('cell')
    const repo = setup()
    await seedDefinitionBlock(repo)
    await createBlock(repo, 'p')
    await repo.tx(async tx => {
      await tx.create({
        id: 'ref-child', workspaceId: WS, parentId: 'p', orderKey: 'a',
        content: '[[status]]', referenceTargetId: STATUS_FIELD_ID,
      })
    }, {scope: ChangeScope.BlockDefault})

    const ids = await repo.runQuery('core.childIds', {id: 'p'})
    expect(ids).toEqual(['ref-child'])
  })
})
