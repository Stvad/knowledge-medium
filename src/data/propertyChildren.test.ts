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
import {
  encodedPropertyValueToChildContent,
  propertyChildContentToEncodedValue,
  propertyValueToChildContent,
} from './propertyChildren'
import { propertyDefinitionBlockId } from './definitionSeeds'
import { addBlockTypeToProperties, aliasesProp, blockTypeLabelProp, typesProp } from './properties'
import { BLOCK_TYPE_TYPE } from './blockTypes'

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
    // Field rows address their definition BY ID (`((fieldId))`, §7).
    expect(fields[0]!.content).toBe(`((${STATUS_FIELD_ID}))`)
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
      const visible = await tx.childrenOf('p', undefined, {hidePropertyChildren: true})
      expect(visible.map(c => c.id)).toEqual(['content-child'])
      const all = await tx.childrenOf('p')
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

describe('§9 positional rule on the WRITE side (round-2 review fixes)', () => {
  const setupWithProperty = async (): Promise<{repo: Repo; fieldRowId: string; valueRowId: string}> => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'p')
    await repo.tx(tx => tx.setProperty('p', statusSchema, 'done'),
      {scope: ChangeScope.BlockDefault})
    const [field] = await liveFieldRows('p')
    const [value] = (await childrenRows(field!.id)).filter(v => v.deleted === 0)
    return {repo, fieldRowId: field!.id, valueRowId: value!.id}
  }

  it('a comment under a ref-typed value never projects junk into the owning cell', async () => {
    const {repo, valueRowId} = await setupWithProperty()
    // Make the VALUE ref-typed at the definition itself — its column stamps
    // to a definition id, the §9 parent-guard shape.
    await repo.tx(tx => tx.update(valueRowId, {content: `((${STATUS_FIELD_ID}))`}),
      {scope: ChangeScope.BlockDefault})
    const cellAfterValueEdit = await cellValue('p')

    // Editing a comment under that value must not treat the value as a
    // nested field row of the FIELD ROW and parse the comment as its value.
    await repo.tx(async tx => {
      await tx.create({
        id: 'comment', workspaceId: WS, parentId: valueRowId, orderKey: 'a',
        content: 'just a note',
      })
    }, {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.update('comment', {content: 'edited note'}),
      {scope: ChangeScope.BlockDefault})

    expect(await cellValue('p')).toEqual(cellAfterValueEdit)
    const fieldRowCell = await sharedDb.db.get<{properties_json: string}>(
      'SELECT properties_json FROM blocks WHERE id = ?',
      [(await liveFieldRows('p'))[0]!.id],
    )
    expect(JSON.parse(fieldRowCell.properties_json)).toEqual({})
  })

  it('a bag write on a field row stays cell-only (no nested field rows)', async () => {
    const {repo, fieldRowId} = await setupWithProperty()
    await repo.tx(tx => tx.update(fieldRowId, {properties: {[statusSchema.name]: 'nested'}}),
      {scope: ChangeScope.BlockDefault})
    // No nested [[status]] row under the field row: its only live child is
    // the value child.
    const children = (await childrenRows(fieldRowId)).filter(c => c.deleted === 0)
    expect(children.filter(c => c.reference_target_id === STATUS_FIELD_ID)).toEqual([])
  })

  it('setProperty on a property-subtree interior row skips the dual-write', async () => {
    const {repo, valueRowId} = await setupWithProperty()
    await repo.tx(tx => tx.setProperty(valueRowId, statusSchema, 'meta'),
      {scope: ChangeScope.BlockDefault})
    // The cell write lands; no field row is minted under the value child.
    const children = (await childrenRows(valueRowId)).filter(c => c.deleted === 0)
    expect(children.filter(c => c.reference_target_id === STATUS_FIELD_ID)).toEqual([])
  })
})

describe('merge relocate-visibly with a ref-typed value (round-2 fix)', () => {
  it('clears the derived column so the relocated value stays visible, bag intact', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'into')
    await createBlock(repo, 'from')
    // into wins the key; from's DIVERGENT value is ref-typed at the
    // definition block — the exact hidden-fake-field-row shape.
    await repo.tx(tx => tx.setProperty('into', statusSchema, 'kept'),
      {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.setProperty('from', statusSchema, 'x'),
      {scope: ChangeScope.BlockDefault})
    const [fromField] = await liveFieldRows('from')
    const [fromValue] = (await childrenRows(fromField!.id)).filter(v => v.deleted === 0)
    await repo.tx(tx => tx.update(fromValue!.id, {content: `((${STATUS_FIELD_ID}))`}),
      {scope: ChangeScope.BlockDefault})

    await repo.tx(async tx => {
      const into = await tx.get('into')
      const from = await tx.get('from')
      await mergeBlocksInTx(tx, {into: into!, from: from!, mergeProperties: intoProps => intoProps})
    }, {scope: ChangeScope.BlockDefault})

    // The merged bag keeps into's value…
    expect(await cellValue('into')).toBe('kept')
    // …and the relocated value row is LIVE under into with a CLEARED
    // column (visible ordinary content, not a hidden fake field row).
    const relocated = await sharedDb.db.get<{deleted: number; parent_id: string; reference_target_id: string | null}>(
      'SELECT deleted, parent_id, reference_target_id FROM blocks WHERE id = ?',
      [fromValue!.id],
    )
    expect(relocated.deleted).toBe(0)
    expect(relocated.parent_id).toBe('into')
    expect(relocated.reference_target_id).toBeNull()
    // Visible to the outline default:
    await repo.tx(async tx => {
      const visible = await tx.childrenOf('into')
      expect(visible.map(c => c.id)).toContain(fromValue!.id)
    }, {scope: ChangeScope.BlockDefault})
  })
})

describe('flip predicate / SQL gate lock (§6)', () => {
  it('the SQL IN-list matches the TS at-or-past-children predicate exactly', async () => {
    // The TS predicate and the SQL literal must move together: a future
    // state added to one but not the other would silently un-recognize (or
    // over-recognize) every field row on one read surface.
    const {isChildBackedPropertiesWorkspace} = await import('@/types')
    const {VISIBLE_CHILDREN_SQL} = await import('./internals/treeQueries')
    const {PROPERTIES_MIGRATION_STATES} = await import('./workspaceSchema')
    const flipped = PROPERTIES_MIGRATION_STATES.filter(isChildBackedPropertiesWorkspace)
    expect(flipped).toEqual(['children', 'cell-off'])
    expect(VISIBLE_CHILDREN_SQL).toContain(
      `properties_migration IN (${flipped.map(s => `'${s}'`).join(', ')})`,
    )
  })
})

describe('query-layer twin (core.childIds / core.children)', () => {
  it('default includes field rows in a flipped workspace; visible view opts out', async () => {
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

    const allIds = await repo.runQuery('core.childIds', {id: 'p'})
    expect(allIds).toHaveLength(2)
    const visibleIds = await repo.runQuery('core.childIds', {id: 'p', hidePropertyChildren: true})
    expect(visibleIds).toEqual(['content-child'])

    const visible = await repo.runQuery('core.children', {id: 'p', hidePropertyChildren: true}) as BlockData[]
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

describe('core.subtree visible-subtree exclusion (PR #386 review gap fix, §9)', () => {
  const setupFlippedWithDefinition = async (): Promise<Repo> => {
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
    return repo
  }

  it('default includes the field row and its value child; visible view opts out', async () => {
    const repo = await setupFlippedWithDefinition()
    const [field] = await liveFieldRows('p')
    const [value] = (await childrenRows(field!.id)).filter(v => v.deleted === 0)

    const visible = await repo.query.subtree({id: 'p', hidePropertyChildren: true}).load()
    expect(visible.map(r => r.id).sort()).toEqual(['content-child', 'p'])

    const all = await repo.query.subtree({id: 'p'}).load()
    expect(all).toHaveLength(4)
    expect(all.map(r => r.id)).toEqual(expect.arrayContaining([field!.id, value!.id]))
  })

  it('un-flipped workspace: subtree unchanged, including a row with a stamped reference_target_id (dormancy)', async () => {
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

    const rows = await repo.query.subtree({id: 'p'}).load()
    expect(rows.map(r => r.id).sort()).toEqual(['p', 'ref-child'])
  })

  it('subtree rooted AT the field row returns the field row + its value child (root exemption)', async () => {
    const repo = await setupFlippedWithDefinition()
    const [field] = await liveFieldRows('p')
    const [value] = (await childrenRows(field!.id)).filter(v => v.deleted === 0)

    const rows = await repo.query.subtree({id: field!.id}).load()
    expect(rows.map(r => r.id).sort()).toEqual([field!.id, value!.id].sort())
  })

  it('subtree rooted at the VALUE child returns it plus comment children, including a ref-typed comment (interior root exemption)', async () => {
    const repo = await setupFlippedWithDefinition()
    const [field] = await liveFieldRows('p')
    const [value] = (await childrenRows(field!.id)).filter(v => v.deleted === 0)
    // A comment beneath the value child, itself ref-typed at the definition
    // block — the exact "stamped ref-typed VALUE row further down" shape
    // §9 says must never be pruned once the root is interior.
    await repo.tx(async tx => {
      await tx.create({
        id: 'comment', workspaceId: WS, parentId: value!.id, orderKey: 'a',
        content: `((${STATUS_FIELD_ID}))`, referenceTargetId: STATUS_FIELD_ID,
      })
    }, {scope: ChangeScope.BlockDefault})

    const rows = await repo.query.subtree({id: value!.id}).load()
    expect(rows.map(r => r.id).sort()).toEqual(['comment', value!.id].sort())
  })
})

describe('content <-> value codecs: lenient-read codecs keep values the write side rejects', () => {
  // `enum` deliberately splits its read/write strictness (codecs.ts): `encode`
  // rejects out-of-set values, but `decode` accepts a value whose option was
  // later removed/renamed so it "still decodes and stays editable". Projection
  // re-canonicalizes via encode(decode(...)) — which must NOT turn such a
  // preserved value into "unparseable" and drop the owning cell key.
  const currentOptionsSchema = defineProperty<string>('priority', {
    codec: codecs.enum(['low', 'high']),
    defaultValue: 'low',
    changeScope: ChangeScope.BlockDefault,
  })

  // The same property BEFORE 'urgent' was removed from its option list —
  // used to produce the child content exactly as it was stored back then.
  const legacyOptionsSchema = defineProperty<string>('priority', {
    codec: codecs.enum(['low', 'high', 'urgent']),
    defaultValue: 'low',
    changeScope: ChangeScope.BlockDefault,
  })

  it('a value whose option was removed survives the projection round-trip', () => {
    // Written while 'urgent' was still valid; the option list has since dropped it.
    const content = propertyValueToChildContent(legacyOptionsSchema, 'urgent')
    // The read/write split that makes this preservable: decode keeps it, encode rejects it.
    expect(currentOptionsSchema.codec.decode('urgent')).toBe('urgent')
    expect(() => currentOptionsSchema.codec.encode('urgent')).toThrow()

    // Must NOT throw — throwing marks it unparseable and the caller drops the cell key.
    expect(propertyChildContentToEncodedValue(currentOptionsSchema, content)).toBe('urgent')
  })

  it('still canonicalizes values that ARE in the current option set', () => {
    const content = propertyValueToChildContent(currentOptionsSchema, 'high')
    expect(propertyChildContentToEncodedValue(currentOptionsSchema, content)).toBe('high')
  })

  it('a genuine shape error still throws (decode failure is not swallowed)', () => {
    const numberSchema = defineProperty<number>('count', {
      codec: codecs.number,
      defaultValue: 0,
      changeScope: ChangeScope.BlockDefault,
    })
    expect(() => propertyChildContentToEncodedValue(numberSchema, 'not-a-number')).toThrow()
  })
})

describe('content <-> value codecs: blank numeric content is unparseable, not zero', () => {
  const numberSchema = defineProperty<number>('count', {
    codec: codecs.number,
    defaultValue: 0,
    changeScope: ChangeScope.BlockDefault,
  })

  // `Number('')` is 0 (not NaN), so a plain isFinite guard waves blank content
  // through as a real zero: clearing a value row would silently project 0 over
  // the cell instead of being treated as unparseable (PR #386 review).
  it.each([['', 'empty'], ['   ', 'spaces'], ['\t\n', 'other whitespace']])(
    'rejects %j (%s) rather than coercing it to 0',
    content => {
      // The trap this pins, spelled out — if the guard regresses, `Number`
      // hands back a finite 0 and the throw below disappears.
      expect(Number(content)).toBe(0)
      expect(Number.isFinite(Number(content))).toBe(true)

      expect(() => propertyChildContentToEncodedValue(numberSchema, content)).toThrow()
    },
  )

  it('still round-trips a real zero', () => {
    // The value blank must NOT be confused with: 0 has its own content ('0').
    const content = propertyValueToChildContent(numberSchema, 0)
    expect(content).toBe('0')
    expect(propertyChildContentToEncodedValue(numberSchema, content)).toBe(0)
  })
})

describe('content <-> value codecs: "null"-collision escaping (PR #386 review fix)', () => {
  // string-typed, null-accepting codec — the shape that exposed the bug:
  // an unescaped literal 'null' child content is ambiguous with the
  // encoded-null sentinel.
  const nullableStringSchema = defineProperty<string | undefined>('nullable-status', {
    codec: codecs.optionalString,
    defaultValue: undefined,
    changeScope: ChangeScope.BlockDefault,
  })

  it('the string value "null" is escaped to content, and round-trips back to the string', () => {
    const content = propertyValueToChildContent(nullableStringSchema, 'null')
    expect(content).toBe(JSON.stringify('null'))
    expect(content).not.toBe('null')
    expect(propertyChildContentToEncodedValue(nullableStringSchema, content)).toBe('null')
  })

  it('the string value " null " (trims to the token) round-trips', () => {
    const content = propertyValueToChildContent(nullableStringSchema, ' null ')
    expect(propertyChildContentToEncodedValue(nullableStringSchema, content)).toBe(' null ')
  })

  it('the string value \'"null"\' (a quoted-null literal) round-trips', () => {
    const content = propertyValueToChildContent(nullableStringSchema, '"null"')
    expect(propertyChildContentToEncodedValue(nullableStringSchema, content)).toBe('"null"')
  })

  it('encoded null still materializes as content "null" and parses back to encoded null', () => {
    const content = encodedPropertyValueToChildContent(nullableStringSchema, null)
    expect(content).toBe('null')
    expect(propertyChildContentToEncodedValue(nullableStringSchema, content)).toBeNull()
  })

  it('ordinary strings are stored verbatim, unchanged', () => {
    expect(propertyValueToChildContent(nullableStringSchema, 'hello')).toBe('hello')
    expect(propertyChildContentToEncodedValue(nullableStringSchema, 'hello')).toBe('hello')

    const withQuotes = 'say "hi"'
    expect(propertyValueToChildContent(nullableStringSchema, withQuotes)).toBe(withQuotes)
    expect(propertyChildContentToEncodedValue(nullableStringSchema, withQuotes)).toBe(withQuotes)
  })

  it('a non-null-accepting string schema stores "null" verbatim — no escaping needed', () => {
    // statusSchema (codecs.string) throws on decode(null), so the sentinel
    // never applies to it and there's nothing to escape.
    const content = propertyValueToChildContent(statusSchema, 'null')
    expect(content).toBe('null')
    expect(propertyChildContentToEncodedValue(statusSchema, content)).toBe('null')
  })
})

describe('root rows are never filtered (§9 root exemption, WRITE-side)', () => {
  it('a root block whose content is ((fieldId)) still appears in tx.childrenOf(null, ws)', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await repo.tx(async tx => {
      await tx.create({
        id: 'root-status', workspaceId: WS, parentId: null, orderKey: 'r0',
        content: `((${STATUS_FIELD_ID}))`,
      })
    }, {scope: ChangeScope.BlockDefault})

    // The derive processor stamped this root row's reference_target_id from
    // its id-addressed content in the same tx — it looks exactly like a
    // field row by column, but a root row is positionally user content,
    // never a field row (nothing OWNS it).
    const stamped = await sharedDb.db.get<{reference_target_id: string | null}>(
      'SELECT reference_target_id FROM blocks WHERE id = ?', ['root-status'],
    )
    expect(stamped.reference_target_id).toBe(STATUS_FIELD_ID)

    await repo.tx(async tx => {
      const roots = await tx.childrenOf(null, WS)
      expect(roots.map(r => r.id)).toContain('root-status')
    }, {scope: ChangeScope.BlockDefault})
  })
})

describe('same-tx content flip to ((fieldId)) stays cell-only (prospective-field-row gate, PR #386 review)', () => {
  it('update(content → ((fieldId))) then setProperty in ONE tx nests no machinery under the flipping block', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'host')
    await repo.tx(async tx => {
      await tx.create({
        id: 'p', workspaceId: WS, parentId: 'host', orderKey: 'a', content: 'ordinary',
      })
    }, {scope: ChangeScope.BlockDefault})

    // Both writes in the SAME tx: the content flip makes `p` a prospective
    // field row (its stored reference_target_id is still stale — derive
    // runs after the user fn AND after materialize), so both the
    // setProperty dual-write and the materialize processor must recognize
    // it from CONTENT and keep the property write cell-only. Pre-fix,
    // machinery nested a field row under a row about to become a field row
    // itself — unreclaimable.
    await repo.tx(async tx => {
      await tx.update('p', {content: `((${STATUS_FIELD_ID}))`})
      await tx.setProperty('p', statusSchema, 'v')
    }, {scope: ChangeScope.BlockDefault})

    // The flip landed (derive stamped the column from the new content)…
    const row = await sharedDb.db.get<{reference_target_id: string | null}>(
      'SELECT reference_target_id FROM blocks WHERE id = ?', ['p'],
    )
    expect(row.reference_target_id).toBe(STATUS_FIELD_ID)
    // …the cell carries the property…
    expect(await cellValue('p')).toBe('v')
    // …and NO field/value machinery was nested under the block.
    expect(await childrenRows('p')).toEqual([])
  })

  it('root exemption: a ROOT block with content ((fieldId)) still materializes its bag (root rows are never field rows)', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'root-p', `((${STATUS_FIELD_ID}))`)

    // A root row is positionally user content — the prospective-field-row
    // gate must NOT suppress its materialization: the setProperty
    // dual-write still creates the backing field row + value child.
    await repo.tx(tx => tx.setProperty('root-p', statusSchema, 'v'),
      {scope: ChangeScope.BlockDefault})

    expect(await cellValue('root-p')).toBe('v')
    const fields = await liveFieldRows('root-p')
    expect(fields).toHaveLength(1)
    expect(fields[0]!.content).toBe(`((${STATUS_FIELD_ID}))`)
    const values = (await childrenRows(fields[0]!.id)).filter(v => v.deleted === 0)
    expect(values.map(v => v.content)).toEqual(['v'])
  })
})

describe('block-type typeify amendments materialize in the same tx (§5/§9 processor-order fix)', () => {
  it('types, block-type:label, and alias each get a backing field row + value child', async () => {
    await seedWorkspace('children')
    const repo = setup()
    // Tag a fresh block block-type — the same-tx typeify processor (registered
    // FIRST in KERNEL_SAME_TX_PROCESSORS) amends its bag with PAGE_TYPE (raw
    // `types` write), a label, and an alias — all bag writes that, in a
    // flipped workspace, the materialize processor (registered right after
    // typeify, ahead of derive) must dual-write into field/value children in
    // this SAME tx rather than leaving them pending until the next edit.
    await repo.tx(async tx => {
      await tx.create({
        id: 'book', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Book',
        properties: addBlockTypeToProperties({}, BLOCK_TYPE_TYPE),
      })
    }, {scope: ChangeScope.BlockDefault})

    // The seeded kernel property definitions (types / alias / block-type
    // label) resolve by code-owned identity — no DB materialization of the
    // definition blocks themselves is required for `setProperty` /
    // `tx.update({properties})` to dual-write against their fieldId.
    const fieldIds: Record<string, string> = {
      types: propertyDefinitionBlockId(WS, typesProp.seedKey),
      alias: propertyDefinitionBlockId(WS, aliasesProp.seedKey),
      'block-type:label': propertyDefinitionBlockId(WS, blockTypeLabelProp.seedKey),
    }
    for (const [name, fieldId] of Object.entries(fieldIds)) {
      const fields = (await childrenRows('book')).filter(
        c => c.deleted === 0 && c.reference_target_id === fieldId,
      )
      expect(fields, `${name} field row`).toHaveLength(1)
      const values = (await childrenRows(fields[0]!.id)).filter(v => v.deleted === 0)
      expect(values.length, `${name} value child`).toBeGreaterThan(0)
    }
  })
})
