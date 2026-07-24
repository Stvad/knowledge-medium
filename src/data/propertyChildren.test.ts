// @vitest-environment node
/**
 * Properties-as-blocks slice B1 (PR #288 §5/§6/§9): dual-writing
 * `tx.setProperty`, the project/materialize processor pair, and the
 * `childrenOf` visible-children exclusion — all gated on the per-workspace
 * flip column (`workspaces.properties_migration`), dormant at 'cell'.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, codecs, defineProperty, propertyValue, type BlockData } from '@/data/api'
import { keyAtStart } from './orderKey'
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
    // Field rows are the MARKED canonical form (`::((fieldId))`, §7 grammar
    // box) — id-addressed and rename-stable.
    expect(fields[0]!.content).toBe(`::((${STATUS_FIELD_ID}))`)
    const values = await childrenRows(fields[0]!.id)
    expect(values.filter(v => v.deleted === 0)).toHaveLength(1)
    expect(values[0]!.content).toBe('done')

    // One undo step reverts the whole dual-write.
    await repo.undo(ChangeScope.BlockDefault)
    expect(await cellValue('p')).toBeUndefined()
    expect(await liveFieldRows('p')).toEqual([])
  })

  it('rejects a raw cell write whose value does not decode (no silent cell/child divergence)', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'p')
    // Establish a valid materialized value first.
    await repo.tx(tx => tx.setProperty('p', statusSchema, 'done'),
      {scope: ChangeScope.BlockDefault})
    expect(await cellValue('p')).toBe('done')

    // A raw whole-bag write of an UNDECODABLE value (null for a non-null
    // string codec) — the kind of mistake setProperty can't produce. It must
    // be REJECTED, not silently skipped: the old skip left the cell = null
    // while the value child stayed 'done', diverging forever (PROJECT never
    // reconciles a raw `properties` write).
    await expect(
      repo.tx(tx => tx.update('p', {properties: {[statusSchema.name]: null}}),
        {scope: ChangeScope.BlockDefault}),
    ).rejects.toThrow(/does not decode/)

    // Rolled back atomically: the prior valid value survives in BOTH forms.
    expect(await cellValue('p')).toBe('done')
    const fields = await liveFieldRows('p')
    expect(fields).toHaveLength(1)
    const values = (await childrenRows(fields[0]!.id)).filter(v => v.deleted === 0)
    expect(values).toHaveLength(1)
    expect(values[0]!.content).toBe('done')
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
})

describe('tx.unsetProperty', () => {
  it('cell workspace: removes just the key, no children involved', async () => {
    await seedWorkspace('cell')
    const repo = setup()
    await createBlock(repo, 'p')
    await repo.tx(tx => tx.setProperty('p', statusSchema, 'done'),
      {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.unsetProperty('p', statusSchema),
      {scope: ChangeScope.BlockDefault})
    expect(await cellValue('p')).toBeUndefined()
    expect(await childrenRows('p')).toEqual([])
  })

  it('flipped workspace: removes the cell key AND soft-deletes the field-row subtree, one undo step', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'p')
    await repo.tx(tx => tx.setProperty('p', statusSchema, 'done'),
      {scope: ChangeScope.BlockDefault})
    expect(await liveFieldRows('p')).toHaveLength(1)

    await repo.tx(tx => tx.unsetProperty('p', statusSchema),
      {scope: ChangeScope.BlockDefault})
    // Cell key gone; unsetProperty eagerly soft-deleted the field-row subtree.
    expect(await cellValue('p')).toBeUndefined()
    expect(await liveFieldRows('p')).toEqual([])

    // One undo restores both the cell key and the field-row subtree.
    await repo.undo(ChangeScope.BlockDefault)
    expect(await cellValue('p')).toBe('done')
    expect(await liveFieldRows('p')).toHaveLength(1)
  })

  it('is a targeted delete — an unrelated sibling key survives (no whole-bag clobber)', async () => {
    await seedWorkspace('cell')
    const repo = setup()
    await createBlock(repo, 'p')
    // Seed two keys via one raw bag write, then unset only `status`.
    await repo.tx(tx => tx.update('p', {properties: {[statusSchema.name]: 'done', other: 'keep'}}),
      {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.unsetProperty('p', statusSchema),
      {scope: ChangeScope.BlockDefault})
    const bag = await sharedDb.db.get<{properties_json: string}>(
      'SELECT properties_json FROM blocks WHERE id = ?', ['p'],
    )
    expect(JSON.parse(bag.properties_json)).toEqual({other: 'keep'})
  })

  it('is a no-op when the key is already absent', async () => {
    await seedWorkspace('cell')
    const repo = setup()
    await createBlock(repo, 'p')
    await sharedDb.db.execute('DELETE FROM row_events')
    await repo.tx(tx => tx.unsetProperty('p', statusSchema),
      {scope: ChangeScope.BlockDefault})
    // No write → the no-WHEN update row_event trigger never fires for `p`.
    const updates = await sharedDb.db.getAll<{id: number}>(
      `SELECT id FROM row_events WHERE block_id = 'p' AND kind = 'update'`,
    )
    expect(updates).toEqual([])
  })

  it('flipped: setProperty then unsetProperty on the SAME key in one tx removes value AND children (no resurrection)', async () => {
    // Regression: setProperty writes children EAGERLY, so the removal must also
    // be eager. A removal that only trusts the deferred single-pass MATERIALIZE
    // net-diff sees `absent -> absent` for a key set-then-unset in one tx, never
    // deletes the eager children, and PROJECT reprojects the value back.
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'p')
    await repo.tx(async tx => {
      await tx.setProperty('p', statusSchema, 'done')
      await tx.unsetProperty('p', statusSchema)
    }, {scope: ChangeScope.BlockDefault})
    expect(await cellValue('p')).toBeUndefined()
    expect(await liveFieldRows('p')).toEqual([])
  })

  it('flipped: setProperty then setProperties({unset}) on the SAME key in one tx removes value AND children', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'p')
    await repo.tx(async tx => {
      await tx.setProperty('p', statusSchema, 'done')
      await tx.setProperties('p', {unset: [statusSchema]})
    }, {scope: ChangeScope.BlockDefault})
    expect(await cellValue('p')).toBeUndefined()
    expect(await liveFieldRows('p')).toEqual([])
  })
})

describe('tx.setProperties (batch set + unset)', () => {
  const PRIORITY_FIELD_ID = 'field-priority-children'
  const prioritySchema = defineProperty<string>('priority', {
    codec: codecs.string,
    defaultValue: '',
    changeScope: ChangeScope.BlockDefault,
  })

  const setupWithTwo = async (migration: string): Promise<Repo> => {
    await seedWorkspace(migration)
    const repo = setup()
    repo.setRuntimeContributions(
      projectedPropertyDefinitionsFacet,
      'test-priority-definition',
      [{
        metadata: {
          fieldId: PRIORITY_FIELD_ID, workspaceId: WS, createdAt: 1,
          name: prioritySchema.name, changeScope: prioritySchema.changeScope,
          hidden: false, origin: 'user' as const,
        },
        schema: prioritySchema,
      }],
      {workspaceId: WS},
    )
    return repo
  }

  const priorityFieldRows = async (parentId: string): Promise<ChildRow[]> =>
    (await childrenRows(parentId)).filter(
      r => r.deleted === 0 && r.reference_target_id === PRIORITY_FIELD_ID,
    )

  it('cell workspace: applies set + unset in ONE bag rewrite', async () => {
    const repo = await setupWithTwo('cell')
    await createBlock(repo, 'p')
    await repo.tx(tx => tx.setProperty('p', statusSchema, 'old'),
      {scope: ChangeScope.BlockDefault})
    await sharedDb.db.execute('DELETE FROM row_events')

    await repo.tx(tx => tx.setProperties('p', {
      set: [propertyValue(prioritySchema, 'high')],
      unset: [statusSchema],
    }), {scope: ChangeScope.BlockDefault})

    const bag = await sharedDb.db.get<{properties_json: string}>(
      'SELECT properties_json FROM blocks WHERE id = ?', ['p'],
    )
    expect(JSON.parse(bag.properties_json)).toEqual({priority: 'high'})
    // ONE bag write for the whole batch (not one per key).
    const updates = await sharedDb.db.getAll<{id: number}>(
      `SELECT id FROM row_events WHERE block_id = 'p' AND kind = 'update'`,
    )
    expect(updates).toHaveLength(1)
  })

  it('a set value that is ALSO unset is discarded, not encoded — an invalid discarded value does not abort the clear', async () => {
    const countSchema = defineProperty<number>('count', {
      codec: codecs.number,
      defaultValue: 0,
      changeScope: ChangeScope.BlockDefault,
    })
    const repo = await setupWithTwo('cell')
    repo.setRuntimeContributions(
      projectedPropertyDefinitionsFacet,
      'test-count-definition',
      [{
        metadata: {
          fieldId: 'field-count-children', workspaceId: WS, createdAt: 1,
          name: countSchema.name, changeScope: countSchema.changeScope,
          hidden: false, origin: 'user' as const,
        },
        schema: countSchema,
      }],
      {workspaceId: WS},
    )
    await createBlock(repo, 'p')
    await repo.tx(tx => tx.setProperty('p', countSchema, 5),
      {scope: ChangeScope.BlockDefault})

    // `NaN` is invalid for the number codec (encode throws). Because `count` is
    // ALSO unset in the same batch, the discarded set value must be skipped
    // rather than encoded — otherwise the whole batch throws instead of applying
    // the explicit clear (Codex #386). unset wins.
    await repo.tx(tx => tx.setProperties('p', {
      set: [propertyValue(countSchema, Number.NaN)],
      unset: [countSchema],
    }), {scope: ChangeScope.BlockDefault})

    const bag = await sharedDb.db.get<{properties_json: string}>(
      'SELECT properties_json FROM blocks WHERE id = ?', ['p'],
    )
    expect(JSON.parse(bag.properties_json)).toEqual({})
  })

  it('does not clobber a sibling key absent from the batch', async () => {
    const repo = await setupWithTwo('cell')
    await createBlock(repo, 'p')
    await repo.tx(tx => tx.update('p', {properties: {[statusSchema.name]: 'done', keep: 'me'}}),
      {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.setProperties('p', {
      set: [propertyValue(prioritySchema, 'high')],
      unset: [statusSchema],
    }), {scope: ChangeScope.BlockDefault})
    const bag = await sharedDb.db.get<{properties_json: string}>(
      'SELECT properties_json FROM blocks WHERE id = ?', ['p'],
    )
    expect(JSON.parse(bag.properties_json)).toEqual({keep: 'me', priority: 'high'})
  })

  it('unset wins when a key is in BOTH set and unset', async () => {
    const repo = await setupWithTwo('cell')
    await createBlock(repo, 'p')
    await repo.tx(tx => tx.setProperties('p', {
      set: [propertyValue(statusSchema, 'done')],
      unset: [statusSchema],
    }), {scope: ChangeScope.BlockDefault})
    expect(await cellValue('p')).toBeUndefined()
  })

  it('flipped workspace: sets create children, unsets soft-delete them, in one tx', async () => {
    const repo = await setupWithTwo('children')
    await createBlock(repo, 'p')
    // Seed both keys as children.
    await repo.tx(tx => tx.setProperties('p', {
      set: [propertyValue(statusSchema, 'done'), propertyValue(prioritySchema, 'high')],
    }), {scope: ChangeScope.BlockDefault})
    expect(await liveFieldRows('p')).toHaveLength(1)      // status field row
    expect(await priorityFieldRows('p')).toHaveLength(1)  // priority field row

    // One batch that updates status and clears priority.
    await repo.tx(tx => tx.setProperties('p', {
      set: [propertyValue(statusSchema, 'archived')],
      unset: [prioritySchema],
    }), {scope: ChangeScope.BlockDefault})

    expect(await cellValue('p')).toBe('archived')
    expect(await priorityFieldRows('p')).toEqual([])       // eagerly deleted by the unset half
    const statusValues = (await childrenRows((await liveFieldRows('p'))[0]!.id))
      .filter(v => v.deleted === 0)
    expect(statusValues.map(v => v.content)).toEqual(['archived'])
  })

  it('flipped workspace: unset wins over set on the SAME pre-existing key — child deleted, not recreated', async () => {
    // The delete-then-skip-create seam: a key with LIVE children, named in both
    // set and unset of one batch. The unset half must delete the field row and
    // the set half must NOT recreate it (unsetNames guard).
    const repo = await setupWithTwo('children')
    await createBlock(repo, 'p')
    await repo.tx(tx => tx.setProperty('p', statusSchema, 'done'),
      {scope: ChangeScope.BlockDefault})
    expect(await liveFieldRows('p')).toHaveLength(1)

    await repo.tx(tx => tx.setProperties('p', {
      set: [propertyValue(statusSchema, 'ignored')],
      unset: [statusSchema],
    }), {scope: ChangeScope.BlockDefault})

    expect(await cellValue('p')).toBeUndefined()      // unset wins in the cell
    expect(await liveFieldRows('p')).toEqual([])       // field row deleted, no recreate
  })

  it('is a net no-op when the batch leaves the bag unchanged', async () => {
    const repo = await setupWithTwo('cell')
    await createBlock(repo, 'p')
    await repo.tx(tx => tx.setProperty('p', statusSchema, 'done'),
      {scope: ChangeScope.BlockDefault})
    await sharedDb.db.execute('DELETE FROM row_events')
    // Set status to its current value and unset an absent key → no net change.
    await repo.tx(tx => tx.setProperties('p', {
      set: [propertyValue(statusSchema, 'done')],
      unset: [prioritySchema],
    }), {scope: ChangeScope.BlockDefault})
    const updates = await sharedDb.db.getAll<{id: number}>(
      `SELECT id FROM row_events WHERE block_id = 'p' AND kind = 'update'`,
    )
    expect(updates).toEqual([])
  })
})

describe('flipped workspace — ref-typed property values are editable `((id))` (#16)', () => {
  const RELATED_FIELD_ID = 'field-related-children'
  const relatedSchema = defineProperty<string>('related', {
    codec: codecs.ref(),
    defaultValue: '',
    changeScope: ChangeScope.BlockDefault,
  })

  const setupWithRef = async (): Promise<Repo> => {
    await seedWorkspace('children')
    const repo = setup()
    // A second projected definition alongside `status`, ref-typed.
    repo.setRuntimeContributions(
      projectedPropertyDefinitionsFacet,
      'test-related-definition',
      [{
        metadata: {
          fieldId: RELATED_FIELD_ID, workspaceId: WS, createdAt: 1,
          name: relatedSchema.name, changeScope: relatedSchema.changeScope,
          hidden: false, origin: 'user' as const,
        },
        schema: relatedSchema,
      }],
      {workspaceId: WS},
    )
    return repo
  }

  const relatedCell = async (id: string): Promise<unknown> => {
    const row = await sharedDb.db.get<{properties_json: string}>(
      'SELECT properties_json FROM blocks WHERE id = ?', [id],
    )
    return (JSON.parse(row.properties_json) as Record<string, unknown>)[relatedSchema.name]
  }

  const relatedValueChild = async (parentId: string): Promise<ChildRow | undefined> => {
    const fields = (await childrenRows(parentId)).filter(
      r => r.deleted === 0 && r.reference_target_id === RELATED_FIELD_ID,
    )
    if (fields.length === 0) return undefined
    return (await childrenRows(fields[0]!.id)).find(v => v.deleted === 0)
  }

  it('stores the value child as `((target))` while the cell keeps the bare id', async () => {
    const repo = await setupWithRef()
    await createBlock(repo, 'p')
    await repo.tx(tx => tx.setProperty('p', relatedSchema, 'target-xyz'),
      {scope: ChangeScope.BlockDefault})

    const value = await relatedValueChild('p')
    // The tree shows a real, clickable/editable block reference...
    expect(value?.content).toBe('((target-xyz))')
    // ...DERIVE stamped its column (so it's a ref to reference maintenance)...
    expect(value?.reference_target_id).toBe('target-xyz')
    // ...and the synced cell keeps the bare id.
    expect(await relatedCell('p')).toBe('target-xyz')
  })

  it('re-projects the cell from the column when the ref is retargeted in the tree', async () => {
    const repo = await setupWithRef()
    await createBlock(repo, 'p')
    await repo.tx(tx => tx.setProperty('p', relatedSchema, 'target-xyz'),
      {scope: ChangeScope.BlockDefault})
    const value = await relatedValueChild('p')

    await repo.tx(tx => tx.update(value!.id, {content: '((target-abc))'}),
      {scope: ChangeScope.BlockDefault})
    expect(await relatedCell('p')).toBe('target-abc')
  })

  it('typing prose into a ref value unsets the cell key but preserves the row', async () => {
    const repo = await setupWithRef()
    await createBlock(repo, 'p')
    await repo.tx(tx => tx.setProperty('p', relatedSchema, 'target-xyz'),
      {scope: ChangeScope.BlockDefault})
    const value = await relatedValueChild('p')

    // "people will type text into ref properties, like logs" — the graceful path.
    await repo.tx(tx => tx.update(value!.id, {content: 'saw a bug in prod today'}),
      {scope: ChangeScope.BlockDefault})

    expect(await relatedCell('p')).toBeUndefined()
    const survivor = await relatedValueChild('p')
    expect(survivor?.content).toBe('saw a bug in prod today')
    expect(survivor?.reference_target_id).toBeNull()
  })

  it('a merge-losing ref value keeps its stamp (no unsound stamp-clear) — #19', async () => {
    // #19: the old merge relocated a divergent losing value to ORDINARY
    // content and had to null a definition-shaped `reference_target_id` so it
    // wouldn't project as a field row of `into`. That clear was unsound (the
    // column is content-derived + device-local: it evaporates on the next
    // edit and never syncs). Union-with-dedupe nests the loser under `into`'s
    // winning value — property-subtree interior, §9-exempt — so NO clear is
    // needed and the stamp stays correct.
    const repo = await setupWithRef()
    await seedDefinitionBlock(repo) // makes STATUS_FIELD_ID resolve as a definition
    await createBlock(repo, 'into')
    await createBlock(repo, 'from')
    // Both have `related`; `from`'s value points at the Status DEFINITION —
    // the exact shape that would misclassify if relocated to ordinary content.
    await repo.tx(tx => tx.setProperty('into', relatedSchema, 'target-into'),
      {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.setProperty('from', relatedSchema, STATUS_FIELD_ID),
      {scope: ChangeScope.BlockDefault})
    const fromRelated = (await childrenRows('from')).find(
      r => r.deleted === 0 && r.reference_target_id === RELATED_FIELD_ID,
    )
    const [fromValue] = (await childrenRows(fromRelated!.id)).filter(v => v.deleted === 0)
    expect(fromValue!.reference_target_id).toBe(STATUS_FIELD_ID)

    await repo.tx(async tx => {
      const into = await tx.get('into')
      const from = await tx.get('from')
      await mergeBlocksInTx(tx, {into: into!, from: from!})
    }, {scope: ChangeScope.BlockDefault})

    // The losing value survives with its stamp INTACT (old code would null it)…
    const survivor = await sharedDb.db.get<{deleted: number; reference_target_id: string | null}>(
      'SELECT deleted, reference_target_id FROM blocks WHERE id = ?', [fromValue!.id],
    )
    expect(survivor.deleted).toBe(0)
    expect(survivor.reference_target_id).toBe(STATUS_FIELD_ID)
    // …and it did NOT project as a Status field row of `into` (no clobber).
    const intoStatus = await sharedDb.db.get<{properties_json: string}>(
      'SELECT properties_json FROM blocks WHERE id = ?', ['into'],
    )
    expect((JSON.parse(intoStatus.properties_json) as Record<string, unknown>)[statusSchema.name])
      .toBeUndefined()
    expect((JSON.parse(intoStatus.properties_json) as Record<string, unknown>)[relatedSchema.name])
      .toBe('target-into')
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

  // Flat §9 recognition is content-intrinsic and MOVE-PROOF: classification
  // never reads ancestors, so no per-tx ancestry memo exists to go stale.
  // An UNMARKED `((fieldId))` child is never machinery — before or after a
  // move into a property subtree — while a MARKED child filters at any
  // depth, including under a field row (it is that row's own nested field
  // row).
  it('recognition is move-proof: unmarked stays visible and marked stays filtered across a same-tx move', async () => {
    const repo = await setupFlipped()
    const [field] = await liveFieldRows('p')
    await repo.tx(async tx => {
      await tx.create({id: 'x', workspaceId: WS, parentId: null, orderKey: 'z', content: 'x'})
      await tx.create({
        id: 'x-kid', workspaceId: WS, parentId: 'x', orderKey: 'a',
        content: `((${STATUS_FIELD_ID}))`,
      })
      await tx.create({
        id: 'x-field', workspaceId: WS, parentId: 'x', orderKey: 'b',
        content: `::((${STATUS_FIELD_ID}))`,
      })
    }, {scope: ChangeScope.BlockDefault})

    await repo.tx(async tx => {
      const before = await tx.childrenOf('x', undefined, {hidePropertyChildren: true})
      expect(before.map(c => c.id)).toEqual(['x-kid'])

      await tx.move('x', {parentId: field!.id, orderKey: 'zz'})

      const after = await tx.childrenOf('x', undefined, {hidePropertyChildren: true})
      expect(after.map(c => c.id)).toEqual(['x-kid'])
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
      // Ask for the visible view explicitly — recognition is flip-gated, so an
      // un-flipped workspace must return the field-row-shaped child UNFILTERED
      // even under hidePropertyChildren. (Without the option this asserts
      // nothing about the flip gate — childrenOf short-circuits before it.)
      const visible = await tx.childrenOf('p', undefined, {hidePropertyChildren: true})
      expect(visible.map(c => c.id)).toEqual(['ref-child'])
    }, {scope: ChangeScope.BlockDefault})
  })
})

describe('merge integration (§9, slice B3)', () => {
  it('adopts a source field row for a property `into` lacks (moved, not recreated)', async () => {
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
    // `into` lacked `status`, so `from`'s field row is MOVED over intact and
    // becomes `into`'s — not tombstoned-and-recreated (#23: property children
    // always transfer to `into`, never delete-and-rebuild).
    const intoFields = await liveFieldRows('into')
    expect(intoFields.map(f => f.id)).toEqual([fromField!.id])
    const fromFieldRow = await sharedDb.db.get<{deleted: number}>(
      'SELECT deleted FROM blocks WHERE id = ?', [fromField!.id],
    )
    expect(fromFieldRow.deleted).toBe(0)
    // Nothing stranded live under the `from` tombstone.
    const strandedLive = await sharedDb.db.getAll<{id: string}>(
      `SELECT b.id FROM blocks b JOIN blocks p ON p.id = b.parent_id
        WHERE p.deleted = 1 AND b.deleted = 0 AND b.workspace_id = ?`,
      [WS],
    )
    expect(strandedLive).toEqual([])
  })

  it('honors a custom mergeProperties that drops a source-only property (no reproject-back)', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'into')
    await createBlock(repo, 'from')
    await repo.tx(tx => tx.setProperty('from', statusSchema, 'from-only'),
      {scope: ChangeScope.BlockDefault})
    const [fromField] = await liveFieldRows('from')

    await repo.tx(async tx => {
      const into = await tx.get('into')
      const from = await tx.get('from')
      // Strategy keeps ONLY into's bag → deliberately drops from's `status`.
      await mergeBlocksInTx(tx, {into: into!, from: from!, mergeProperties: intoProps => intoProps})
    }, {scope: ChangeScope.BlockDefault})

    // The dropped property must NOT reappear via a moved-and-reprojected field
    // row — the merge honors the strategy.
    expect(await cellValue('into')).toBeUndefined()
    expect(await liveFieldRows('into')).toEqual([])
    const ff = await sharedDb.db.get<{deleted: number}>(
      'SELECT deleted FROM blocks WHERE id = ?', [fromField!.id],
    )
    expect(ff.deleted).toBe(1)
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

    // The comment survives, still attached to the value it was authored on
    // (which now lives under `into` via the adopted field row) — more faithful
    // than flattening it directly under `into`.
    const comment = await sharedDb.db.get<{deleted: number; parent_id: string}>(
      'SELECT deleted, parent_id FROM blocks WHERE id = ?', ['comment'],
    )
    expect(comment.deleted).toBe(0)
    expect(comment.parent_id).toBe(fromValue!.id)
  })

  it('a divergent value from BOTH sides survives as a peer sibling, cell target-wins (#23)', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'into')
    await createBlock(repo, 'from')
    await repo.tx(tx => tx.setProperty('into', statusSchema, 'into-status'),
      {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.setProperty('from', statusSchema, 'from-status'),
      {scope: ChangeScope.BlockDefault})
    const [fromField] = await liveFieldRows('from')
    const [fromValue] = (await childrenRows(fromField!.id)).filter(v => v.deleted === 0)
    const [intoField] = await liveFieldRows('into')

    await repo.tx(async tx => {
      const into = await tx.get('into')
      const from = await tx.get('from')
      await mergeBlocksInTx(tx, {into: into!, from: from!})
    }, {scope: ChangeScope.BlockDefault})

    // Cell keeps `into`'s value (projection reads the first sibling), one field row…
    expect(await cellValue('into')).toBe('into-status')
    expect((await liveFieldRows('into')).map(f => f.id)).toEqual([intoField!.id])
    // …and `from`'s divergent value survives as a PEER value child under the
    // same field row — a set of values, not a winner with the loser nested
    // under it, not litter in the outline, not silently dropped.
    const survivor = await sharedDb.db.get<{deleted: number; parent_id: string; content: string}>(
      'SELECT deleted, parent_id, content FROM blocks WHERE id = ?', [fromValue!.id],
    )
    expect(survivor.deleted).toBe(0)
    expect(survivor.content).toBe('from-status')
    expect(survivor.parent_id).toBe(intoField!.id)
    // Both values live directly under the field row (siblings).
    const siblings = (await childrenRows(intoField!.id)).filter(v => v.deleted === 0)
    expect(siblings.map(v => v.content).sort()).toEqual(['from-status', 'into-status'])
  })

  it('an ordinary `((definitionId))` child of a property-subtree-interior `into` is not mistaken for its field row (PR #386 review)', async () => {
    // `into` here is itself a property VALUE row (interior) — `owner`'s
    // Status value — which has its OWN ordinary child that happens to be a
    // block-ref to the Status definition. Per the §9 positional rule that
    // child is ordinary content (children of a value row are never field
    // rows), but its `reference_target_id` column is indistinguishable from
    // a real field row's without going through the visible-children
    // exclusion (`hidePropertyChildren`) — which is exactly what
    // `intoFieldByFieldId` must do.
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'owner')
    await repo.tx(tx => tx.setProperty('owner', statusSchema, 'owner-status'),
      {scope: ChangeScope.BlockDefault})
    const [ownerField] = await liveFieldRows('owner')
    const [ownerValue] = (await childrenRows(ownerField!.id)).filter(v => v.deleted === 0)

    await repo.tx(async tx => {
      await tx.create({
        id: 'ordinary-ref-child', workspaceId: WS, parentId: ownerValue!.id, orderKey: keyAtStart(),
        content: `((${STATUS_FIELD_ID}))`, referenceTargetId: STATUS_FIELD_ID,
      })
    }, {scope: ChangeScope.BlockDefault})

    await createBlock(repo, 'from')
    await repo.tx(tx => tx.setProperty('from', statusSchema, 'from-status'),
      {scope: ChangeScope.BlockDefault})
    const [fromField] = await liveFieldRows('from')
    const [fromValue] = (await childrenRows(fromField!.id)).filter(v => v.deleted === 0)

    await repo.tx(async tx => {
      const into = await tx.get(ownerValue!.id)
      const from = await tx.get('from')
      await mergeBlocksInTx(tx, {into: into!, from: from!})
    }, {scope: ChangeScope.BlockDefault})

    // The ordinary child was NOT treated as `into`'s field row: no value or
    // comment got collapsed under it, and it is otherwise untouched.
    const ordinaryChild = await sharedDb.db.get<{deleted: number; parent_id: string; content: string}>(
      'SELECT deleted, parent_id, content FROM blocks WHERE id = ?', ['ordinary-ref-child'],
    )
    expect(ordinaryChild.deleted).toBe(0)
    expect(ordinaryChild.parent_id).toBe(ownerValue!.id)
    expect(ordinaryChild.content).toBe(`((${STATUS_FIELD_ID}))`)
    expect((await childrenRows('ordinary-ref-child')).filter(c => c.deleted === 0)).toEqual([])

    // `from`'s GENUINE field row was adopted intact under the value row
    // (the "`into` lacks this field" branch) — NOT tombstoned-and-collapsed
    // into the ordinary child.
    const fromFieldRow = await sharedDb.db.get<{deleted: number; parent_id: string}>(
      'SELECT deleted, parent_id FROM blocks WHERE id = ?', [fromField!.id],
    )
    expect(fromFieldRow.deleted).toBe(0)
    expect(fromFieldRow.parent_id).toBe(ownerValue!.id)

    // Its value child stayed put under the (adopted) field row — not
    // relocated under the ordinary child.
    const fromValueRow = await sharedDb.db.get<{deleted: number; parent_id: string}>(
      'SELECT deleted, parent_id FROM blocks WHERE id = ?', [fromValue!.id],
    )
    expect(fromValueRow.deleted).toBe(0)
    expect(fromValueRow.parent_id).toBe(fromField!.id)
  })
})

describe('duplicate collapse preservation (§9, slice B3)', () => {
  it('keeps a divergent losing value as a sibling (with its comments) instead of deleting', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'p')
    // Two concurrent-dual-write-shaped field rows for the same schema, with
    // DIVERGENT values, one carrying a user comment — the §5 duplicate case.
    await repo.tx(async tx => {
      await tx.create({
        id: 'field-a', workspaceId: WS, parentId: 'p', orderKey: 'a',
        content: `::((${STATUS_FIELD_ID}))`,
      })
      // Real fractional keys — a divergent value now moves to a SIBLING slot
      // computed against the survivor's last value key, so that key must be a
      // valid fractional-index (a bare 'a' is not).
      await tx.create({
        id: 'value-a', workspaceId: WS, parentId: 'field-a', orderKey: keyAtStart(), content: 'alpha',
      })
      await tx.create({
        id: 'field-b', workspaceId: WS, parentId: 'p', orderKey: 'b',
        content: `::((${STATUS_FIELD_ID}))`,
      })
      await tx.create({
        id: 'value-b', workspaceId: WS, parentId: 'field-b', orderKey: keyAtStart(), content: 'beta',
      })
      await tx.create({
        id: 'comment-b', workspaceId: WS, parentId: 'value-b', orderKey: keyAtStart(),
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
    // …but the DIVERGENT losing value survives as a PEER sibling value under
    // the surviving field row, with its comment thread intact beneath it.
    const valueB = await sharedDb.db.get<{deleted: number; parent_id: string}>(
      'SELECT deleted, parent_id FROM blocks WHERE id = ?', ['value-b'],
    )
    expect(valueB.deleted).toBe(0)
    expect(valueB.parent_id).toBe('field-a')
    const commentB = await sharedDb.db.get<{deleted: number; parent_id: string}>(
      'SELECT deleted, parent_id FROM blocks WHERE id = ?', ['comment-b'],
    )
    expect(commentB.deleted).toBe(0)
    expect(commentB.parent_id).toBe('value-b')
  })

  it('a non-equal setProperty after a merge keeps the divergent peer (eager dual-write parity with materialize, #386 ultra-review)', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'into')
    await createBlock(repo, 'from')
    await repo.tx(tx => tx.setProperty('into', statusSchema, 'into-status'),
      {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.setProperty('from', statusSchema, 'from-status'),
      {scope: ChangeScope.BlockDefault})
    const [fromField] = await liveFieldRows('from')
    const [fromValue] = (await childrenRows(fromField!.id)).filter(v => v.deleted === 0)
    const [intoField] = await liveFieldRows('into')

    // Merge leaves ONE field row under `into` holding two divergent peer value
    // children ('into-status' primary, 'from-status' peer) — the surfaced-conflict
    // steady state (#23, above).
    await repo.tx(async tx => {
      const into = await tx.get('into')
      const from = await tx.get('from')
      await mergeBlocksInTx(tx, {into: into!, from: from!})
    }, {scope: ChangeScope.BlockDefault})

    // A later, NON-equal setProperty routes through the eager dual-write
    // (writePropertyValueChild). It must fold only EXACT duplicates of the new
    // value — like the deferred materialize processor — and PRESERVE the
    // divergent peer, not silently destroy it. A raw tx.update({properties})
    // on the same state keeps the peer (it reconciles via materialize), so the
    // two "set a property" entry points must agree.
    await repo.tx(tx => tx.setProperty('into', statusSchema, 'archived'),
      {scope: ChangeScope.BlockDefault})

    // The divergent peer ('from-status' ≠ the new value 'archived') survives.
    const survivor = await sharedDb.db.get<{deleted: number; parent_id: string; content: string}>(
      'SELECT deleted, parent_id, content FROM blocks WHERE id = ?', [fromValue!.id],
    )
    expect(survivor.deleted).toBe(0)
    expect(survivor.content).toBe('from-status')
    expect(survivor.parent_id).toBe(intoField!.id)
    // The primary now holds the new value; both live as siblings under the row.
    const siblings = (await childrenRows(intoField!.id)).filter(v => v.deleted === 0)
    expect(siblings.map(v => v.content).sort()).toEqual(['archived', 'from-status'])
  })
})

describe('movement gestures anchor on the visible sibling list (§9/§10)', () => {
  /** `p` → hidden field row → value child, plus two ordinary content
   *  children, so every gesture has both a visible and a hidden neighbour. */
  const setupMovable = async (): Promise<{
    repo: Repo; fieldRowId: string; valueRowId: string
  }> => {
    await seedWorkspace('children')
    const repo = setup()
    // Real fractional-index keys throughout: these tests exercise the
    // order-key arithmetic, which validates its inputs.
    await repo.tx(async tx => {
      await tx.create({id: 'p', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'p'})
    }, {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.setProperty('p', statusSchema, 'done'),
      {scope: ChangeScope.BlockDefault})
    // Content children created AFTER the property so the field row (keyAtStart)
    // sits physically first — the hidden-neighbour case.
    await repo.tx(async tx => {
      await tx.create({id: 'c1', workspaceId: WS, parentId: 'p', orderKey: 'a1', content: 'c1'})
      await tx.create({id: 'c2', workspaceId: WS, parentId: 'p', orderKey: 'a2', content: 'c2'})
    }, {scope: ChangeScope.BlockDefault})
    const [field] = await liveFieldRows('p')
    const [value] = (await childrenRows(field!.id)).filter(v => v.deleted === 0)
    return {repo, fieldRowId: field!.id, valueRowId: value!.id}
  }

  const parentOf = async (id: string): Promise<string | null> =>
    (await sharedDb.db.get<{parent_id: string | null}>(
      'SELECT parent_id FROM blocks WHERE id = ?', [id],
    )).parent_id

  // The anchor for outdenting a VALUE row is its parent field row, which the
  // caller cannot see — so the gesture has no target and must do nothing.
  // Acting on the raw sibling list instead hoists the value out of the
  // property and the next projection drops the key: silent property loss from
  // a Shift+Tab the user aimed at ordinary content.
  it('outdenting a property value row is a clean no-op — the property survives', async () => {
    const {repo, fieldRowId, valueRowId} = await setupMovable()

    const moved = await repo.mutate.outdent({id: valueRowId})

    expect(moved).toBe(false)
    expect(await parentOf(valueRowId)).toBe(fieldRowId)
    expect(await cellValue('p')).toBe('done')
  })

  // Same subject, the other gesture: with the field row hidden from `p`'s
  // visible children, the "parent has no neighbouring sibling" edge used to
  // index `parentSiblings[-1 + 1]` and adopt the FIRST visible child as the
  // new parent — dropping the value under an unrelated block.
  it('moving a property value row down at the edge does not relocate it under a content sibling', async () => {
    const {repo, fieldRowId, valueRowId} = await setupMovable()

    const moved = await repo.mutate.moveVertical({
      id: valueRowId, direction: 1, scopeRootId: 'p',
    })

    expect(moved).toBe(false)
    expect(await parentOf(valueRowId)).toBe(fieldRowId)
    expect(await cellValue('p')).toBe('done')
  })

  // Resolves the asymmetry #404 flagged: `indent` and `moveVertical` already
  // no-op on a row the caller can't see, while `outdent` acted on it. A
  // deliberate machinery move goes through `core.move`, not an outline gesture.
  it('outdenting a hidden field row is a no-op, like indent and moveVertical', async () => {
    const {repo, fieldRowId} = await setupMovable()

    expect(await repo.mutate.outdent({id: fieldRowId})).toBe(false)
    expect(await repo.mutate.moveVertical({id: fieldRowId, direction: -1})).toBe(false)
    await repo.mutate.indent({id: fieldRowId})

    expect(await parentOf(fieldRowId)).toBe('p')
    expect(await cellValue('p')).toBe('done')
  })

  // The positive half of the rule: a hidden row must not absorb a gesture
  // either. `c2` moves up past the field row's physical slot in ONE step and
  // lands above `c1` — where it physically sits relative to the hidden row is
  // unobservable, but a visible gesture may never appear to do nothing.
  it('moving up past a hidden physical neighbour lands above the visible one', async () => {
    const {repo} = await setupMovable()

    expect(await repo.mutate.moveVertical({id: 'c2', direction: -1})).toBe(true)

    await repo.tx(async tx => {
      const visible = await tx.childrenOf('p', undefined, {hidePropertyChildren: true})
      expect(visible.map(c => c.id)).toEqual(['c2', 'c1'])
    }, {scope: ChangeScope.BlockDefault})
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

  it('a bag write on a field row materializes its OWN nested field row (materialize-everything, §9)', async () => {
    const {repo, fieldRowId} = await setupWithProperty()
    await repo.tx(tx => tx.update(fieldRowId, {properties: {[statusSchema.name]: 'nested'}}),
      {scope: ChangeScope.BlockDefault})
    // Under the `::` grammar, field rows' bags materialize like everyone
    // else's: a MARKED nested field row lands beside the value child, and
    // recognition reclaims it at any depth (no cell-only carve-out).
    const children = (await childrenRows(fieldRowId)).filter(c => c.deleted === 0)
    const nested = children.filter(c => c.content === `::((${STATUS_FIELD_ID}))`)
    expect(nested).toHaveLength(1)
    const nestedValues = (await childrenRows(nested[0]!.id)).filter(c => c.deleted === 0)
    expect(nestedValues.map(v => v.content)).toEqual(['nested'])
  })

  it('setProperty on a value row dual-writes machinery under it (any-depth rule, §9)', async () => {
    const {repo, valueRowId} = await setupWithProperty()
    await repo.tx(tx => tx.setProperty(valueRowId, statusSchema, 'meta'),
      {scope: ChangeScope.BlockDefault})
    // A `::` child of a value row is that value's own field row — the cell
    // write lands AND the marked machinery nests under the value row.
    expect(await cellValue(valueRowId)).toBe('meta')
    const children = (await childrenRows(valueRowId)).filter(c => c.deleted === 0)
    const nested = children.filter(c => c.content === `::((${STATUS_FIELD_ID}))`)
    expect(nested).toHaveLength(1)
    const nestedValues = (await childrenRows(nested[0]!.id)).filter(c => c.deleted === 0)
    expect(nestedValues.map(v => v.content)).toEqual(['meta'])
  })
})

describe('merge keeps a ref-typed losing value interior, stamp intact (#19)', () => {
  it('the losing ref value survives as a hidden sibling with its stamp NOT cleared', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await seedDefinitionBlock(repo) // makes STATUS_FIELD_ID resolve as a definition
    await createBlock(repo, 'into')
    await createBlock(repo, 'from')
    // into wins the key; from's DIVERGENT value is ref-typed at the definition
    // block — the exact shape the OLD code had to stamp-clear to stop it
    // projecting as a hidden field row of `into`.
    await repo.tx(tx => tx.setProperty('into', statusSchema, 'kept'),
      {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.setProperty('from', statusSchema, 'x'),
      {scope: ChangeScope.BlockDefault})
    const [intoField] = await liveFieldRows('into')
    const [fromField] = await liveFieldRows('from')
    const [fromValue] = (await childrenRows(fromField!.id)).filter(v => v.deleted === 0)
    await repo.tx(tx => tx.update(fromValue!.id, {content: `((${STATUS_FIELD_ID}))`}),
      {scope: ChangeScope.BlockDefault})
    expect((await childrenRows(fromField!.id)).find(v => v.id === fromValue!.id)?.reference_target_id)
      .toBe(STATUS_FIELD_ID)

    await repo.tx(async tx => {
      const into = await tx.get('into')
      const from = await tx.get('from')
      await mergeBlocksInTx(tx, {into: into!, from: from!, mergeProperties: intoProps => intoProps})
    }, {scope: ChangeScope.BlockDefault})

    expect(await cellValue('into')).toBe('kept')
    // The losing value survives as a SIBLING under into's status field row,
    // with its stamp INTACT — no unsound clear (#19). It's property-subtree
    // interior, so §9 keeps it out of the visible outline AND stops it
    // projecting as a Status field row of `into`.
    const survivor = await sharedDb.db.get<{deleted: number; parent_id: string; reference_target_id: string | null}>(
      'SELECT deleted, parent_id, reference_target_id FROM blocks WHERE id = ?',
      [fromValue!.id],
    )
    expect(survivor.deleted).toBe(0)
    expect(survivor.parent_id).toBe(intoField!.id)
    expect(survivor.reference_target_id).toBe(STATUS_FIELD_ID)
    // NOT a visible ordinary child of into (it's interior machinery)…
    await repo.tx(async tx => {
      const visible = await tx.childrenOf('into', undefined, {hidePropertyChildren: true})
      expect(visible.map(c => c.id)).not.toContain(fromValue!.id)
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

    // Exercise the visible view: the reactive query's flip gate
    // (VISIBLE_CHILD_PREDICATE_SQL's `properties_migration IN (...)` branch)
    // must leave the field-row-shaped child visible in an un-flipped workspace.
    const ids = await repo.runQuery('core.childIds', {id: 'p', hidePropertyChildren: true})
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

describe('content <-> value codecs: ref values are `((id))`, read via reference_target_id', () => {
  // A ref value child holds the reference in EDITABLE `((id))` form (the same
  // affordance as any block reference), while the cell keeps a bare id. The
  // read side does NOT re-parse the content — `core.deriveReferenceTarget`
  // already parsed it and stored the result in `reference_target_id`, keeping
  // the invariant "column is null iff content isn't a resolvable exact ref".
  // So the codec reads the column: content is the edit affordance, the column
  // is the truth.
  const refSchema = defineProperty<string>('related', {
    codec: codecs.ref(),
    defaultValue: '',
    changeScope: ChangeScope.BlockDefault,
  })
  const optionalRefSchema = defineProperty<string | undefined>('maybe-related', {
    codec: codecs.optionalRef(),
    defaultValue: undefined,
    changeScope: ChangeScope.BlockDefault,
  })

  it('writes a ref value as `((id))`, not the bare id', () => {
    expect(propertyValueToChildContent(refSchema, 'block-abc')).toBe('((block-abc))')
    expect(encodedPropertyValueToChildContent(refSchema, 'block-abc')).toBe('((block-abc))')
  })

  // Regression (PR #386 review): `referenceBlockContentForId` was hardened to
  // refuse ids it cannot round-trip, which made the ordinary "clear a ref
  // property" path — `codecs.ref` encodes a cleared value as EXACTLY `''` —
  // throw and roll back the whole transaction. An empty ref is the ABSENCE of a
  // reference, so it renders as empty content: the row survives, its derived
  // column stays NULL, and the projection reads the key as unset.
  it('renders an exactly-empty ref as empty content, but rejects a whitespace-only id', () => {
    expect(propertyValueToChildContent(refSchema, '')).toBe('')
    expect(encodedPropertyValueToChildContent(refSchema, '')).toBe('')
    // A whitespace-only id is a MALFORMED reference, not a clear (Codex #386):
    // matching it as "empty" would silently unset the property; it must reach
    // `referenceBlockContentForId`, which throws on whitespace/parens ids.
    expect(() => propertyValueToChildContent(refSchema, '   ')).toThrow()
    expect(() => encodedPropertyValueToChildContent(refSchema, '   ')).toThrow()
  })

  it('reads the ref back from the column (the bare id lands in the cell)', () => {
    const content = propertyValueToChildContent(refSchema, 'block-abc')
    // The derived column DERIVE would have stamped for `((block-abc))`.
    expect(propertyChildContentToEncodedValue(refSchema, content, 'block-abc')).toBe('block-abc')
  })

  it('rejects prose typed into a ref value (column NULL) instead of coercing it', () => {
    // "people will type text into ref properties, like logs" — DERIVE clears
    // the column for non-ref content, so the codec throws → the projection
    // skips it → the cell key reads unset while the row text is preserved.
    expect(() =>
      propertyChildContentToEncodedValue(refSchema, 'saw a bug in prod today', null),
    ).toThrow()
  })

  it('rejects a `((id))` whose target never resolved (column still NULL)', () => {
    // A dangling/unresolved ref: content looks ref-shaped but nothing stamped
    // it (e.g. an as-yet-unresolvable alias). Unparseable until it resolves.
    expect(() =>
      propertyChildContentToEncodedValue(refSchema, '[[Not Yet A Page]]', null),
    ).toThrow()
  })

  it('an optional ref preserves an explicit null (sentinel wins over the column read)', () => {
    const content = encodedPropertyValueToChildContent(optionalRefSchema, null)
    expect(content).toBe('null')
    // Must NOT throw despite a null column — the generic null sentinel runs
    // first, so an intentionally-unset optional ref decodes to its unset form
    // (encoded as null, like every other null-accepting codec).
    expect(propertyChildContentToEncodedValue(optionalRefSchema, content, null)).toBeNull()
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

describe('materialize-everything: no cell-only carve-outs remain (§9 flat grammar)', () => {
  it('an unmarked ((fieldId)) row is not a field row — its bag dual-writes normally', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'host')
    await repo.tx(async tx => {
      await tx.create({
        id: 'p', workspaceId: WS, parentId: 'host', orderKey: 'a', content: 'ordinary',
      })
    }, {scope: ChangeScope.BlockDefault})

    // Both writes in the SAME tx. Under the marked grammar an UNMARKED
    // `((fieldId))` is a plain reference block, full stop — the old
    // prospective-field-row gate (which kept this write cell-only) is
    // deleted, and machinery dual-writes under `p` like any block.
    await repo.tx(async tx => {
      await tx.update('p', {content: `((${STATUS_FIELD_ID}))`})
      await tx.setProperty('p', statusSchema, 'v')
    }, {scope: ChangeScope.BlockDefault})

    // The target stamped (every form × marked/unmarked derives)…
    const row = await sharedDb.db.get<{reference_target_id: string | null; is_field_form: number | null}>(
      'SELECT reference_target_id, is_field_form FROM blocks WHERE id = ?', ['p'],
    )
    expect(row.reference_target_id).toBe(STATUS_FIELD_ID)
    // …but the BIT did not — unmarked never classifies…
    expect(row.is_field_form).toBeNull()
    // …the cell carries the property, and the backing machinery nests
    // under `p` (marked field row + value child).
    expect(await cellValue('p')).toBe('v')
    const fields = await liveFieldRows('p')
    expect(fields).toHaveLength(1)
    expect(fields[0]!.content).toBe(`::((${STATUS_FIELD_ID}))`)
  })

  it('a MARKED field row still dual-writes its own bag (no prospective suppression either)', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'host2')
    await repo.tx(async tx => {
      await tx.create({
        id: 'p2', workspaceId: WS, parentId: 'host2', orderKey: 'a', content: 'ordinary',
      })
    }, {scope: ChangeScope.BlockDefault})

    // Content flips to the MARKED form and a property write lands in the
    // same tx: `p2` IS (about to be) a field row, and materialize-everything
    // still dual-writes its bag — nested machinery is reclaimable at any
    // depth, so no suppression exists.
    await repo.tx(async tx => {
      await tx.update('p2', {content: `::((${STATUS_FIELD_ID}))`})
      await tx.setProperty('p2', statusSchema, 'v')
    }, {scope: ChangeScope.BlockDefault})

    const row = await sharedDb.db.get<{reference_target_id: string | null; is_field_form: number | null}>(
      'SELECT reference_target_id, is_field_form FROM blocks WHERE id = ?', ['p2'],
    )
    expect(row.reference_target_id).toBe(STATUS_FIELD_ID)
    expect(row.is_field_form).toBe(1)
    expect(await cellValue('p2')).toBe('v')
    const fields = await liveFieldRows('p2')
    expect(fields).toHaveLength(1)
    expect(fields[0]!.content).toBe(`::((${STATUS_FIELD_ID}))`)
  })

  it('a ROOT block materializes its bag (root rows are never field rows)', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'root-p', `((${STATUS_FIELD_ID}))`)

    await repo.tx(tx => tx.setProperty('root-p', statusSchema, 'v'),
      {scope: ChangeScope.BlockDefault})

    expect(await cellValue('root-p')).toBe('v')
    const fields = await liveFieldRows('root-p')
    expect(fields).toHaveLength(1)
    expect(fields[0]!.content).toBe(`::((${STATUS_FIELD_ID}))`)
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
