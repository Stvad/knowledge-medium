// @vitest-environment node
/**
 * Properties-as-blocks slice B1 (PR #288 §5/§6/§9): dual-writing
 * `tx.setProperty`, the project/materialize processor pair, and the
 * `childrenOf` visible-children exclusion — all gated on the per-workspace
 * flip column (`workspaces.properties_migration`), dormant at 'cell'.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, codecs, defineProperty, propertyValue, type AnyPropertySchema, type BlockData } from '@/data/api'
import { keyAtStart } from './orderKey'
import { propertyFieldContent } from './propertyChildren'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { projectedPropertyDefinitionsFacet } from '@/data/facets'
import { foldBlocksInTx, mergeBlocksInTx } from './blockMerge'
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
/** A synthetic block id for values that LOOK like references. All-2s, so it
 *  is plainly not a real graph id — it only has to be UUID-shaped. */
const SAMPLE_UUID = '22222222-2222-4222-8222-222222222222'

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

/** Publish one projected property definition into `repo`'s facet runtime.
 *  Contributions bucket by (sourceId, workspaceId), so each call ADDS a
 *  definition rather than replacing the ones before it. */
const registerDefinition = (
  repo: Repo,
  sourceId: string,
  fieldId: string,
  schema: AnyPropertySchema,
): void => {
  repo.setRuntimeContributions(
    projectedPropertyDefinitionsFacet,
    sourceId,
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

const setup = (): Repo => {
  const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
  repo.setActiveWorkspaceId(WS)
  registerDefinition(repo, 'test-status-definition', STATUS_FIELD_ID, statusSchema)
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

const liveFieldRowsFor = (fieldId: string) =>
  async (parentId: string): Promise<ChildRow[]> =>
    (await childrenRows(parentId)).filter(
      r => r.deleted === 0 && r.reference_target_id === fieldId,
    )

const liveFieldRows = liveFieldRowsFor(STATUS_FIELD_ID)

const bagOf = async (id: string): Promise<Record<string, unknown>> => {
  const row = await sharedDb.db.get<{properties_json: string}>(
    'SELECT properties_json FROM blocks WHERE id = ?', [id],
  )
  return JSON.parse(row.properties_json) as Record<string, unknown>
}

const cellValue = async (id: string): Promise<unknown> =>
  (await bagOf(id))[statusSchema.name]

/** What the escaped envelope must BE, rather than how it is spelled: it carries
 *  the value back, and carries no span OPENER. Asserting the spelling instead
 *  would only prove `escapeContent` agrees with a copy of itself.
 *
 *  The opener check is deliberately stronger than asking the whole-block parser
 *  whether the content is a reference: every span form in EITHER reader has to
 *  open with `[` or `(`, so no opener means no span for the inline reader
 *  either — and that reader is the one a rename or merge rewrites through. */
const expectEscapedEnvelope = (schema: typeof statusSchema, value: string, content: string): void => {
  expect(content).not.toBe(value)
  expect(content).not.toMatch(/[[(]/)
  expect(propertyChildContentToEncodedValue(schema, content)).toBe(value)
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

/** #688: a string value the content column cannot hold AS ITSELF. Both shapes
 *  survive the cell era (`properties_json` is JSON) and were destroyed by the
 *  flip — the reason this is a must-fix BEFORE the first workspace flips.
 *  End-to-end because the loss is not in the codec pair: encode and decode
 *  agreed, and the value disappeared between them, in the derive processor and
 *  the projection's value-set filter. */
describe('flipped workspace: string values that verbatim content would destroy (#688)', () => {
  const valueRows = async (parentId: string): Promise<Array<{
    id: string
    content: string
    is_field_form: number | null
    reference_target_id: string | null
    deleted: number
  }>> => {
    const [field] = await liveFieldRows(parentId)
    return sharedDb.db.getAll(
      `SELECT id, content, is_field_form, reference_target_id, deleted
         FROM blocks WHERE parent_id = ?`,
      [field!.id],
    )
  }

  // The headline shape: content that IS the §7 marked field form. The derive
  // stamps `is_field_form`, `isFieldValueChild` drops the row from the value
  // set, and the projection unsets the owner's key — silently.
  it('a `::((id))` value keeps the property, and its row stays a VALUE not a field row', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'p')
    const value = `::((${SAMPLE_UUID}))`

    await repo.tx(tx => tx.setProperty('p', statusSchema, value),
      {scope: ChangeScope.BlockDefault})

    expect(await cellValue('p')).toBe(value)
    const values = (await valueRows('p')).filter(v => v.deleted === 0)
    expect(values).toHaveLength(1)
    // Escaped, so the derive reads it as prose: the bit is what the value-set
    // filter keys on, and the whole loss followed from it being stamped.
    expect(values[0]!.is_field_form).not.toBe(1)
    expectEscapedEnvelope(statusSchema, value, values[0]!.content)
  })

  // An UNMARKED span never set the bit, so it never dropped the key — it
  // stamped `reference_target_id` instead, making a string value a live
  // reference that reference maintenance rewrites. Escaped for that reason,
  // and pinned so a narrowing of the predicate to just the marked form shows up.
  it('an unmarked `((id))` value is stored as text, not as a reference', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'p')
    const value = `((${SAMPLE_UUID}))`

    await repo.tx(tx => tx.setProperty('p', statusSchema, value),
      {scope: ChangeScope.BlockDefault})

    expect(await cellValue('p')).toBe(value)
    const values = (await valueRows('p')).filter(v => v.deleted === 0)
    expect(values[0]!.reference_target_id ?? null).toBeNull()
  })

  // The second shape (bead comment): the cell keeps a lone surrogate, the
  // content column returns U+FFFD, and the projection writes the mangled
  // spelling back over the cell as authoritative.
  it.each([
    ['high', 'a\uD800b'],
    ['low', 'a\uDC00b'],
  ])('a lone %s surrogate survives instead of projecting back as U+FFFD', async (_kind, value) => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'p')

    await repo.tx(tx => tx.setProperty('p', statusSchema, value),
      {scope: ChangeScope.BlockDefault})

    expect(await cellValue('p')).toBe(value)
    expect(await cellValue('p')).not.toContain('�')
  })

  // The scope line for the escape: it engages only for values verbatim content
  // cannot hold. A well-formed emoji is a surrogate PAIR, and padding, control
  // characters and newlines all round-trip the column verbatim (measured), so
  // none of them are escaped — the tree keeps showing the value as itself.
  it.each([
    ['an emoji (a valid surrogate pair)', 'a😀b'],
    ['padding', '  padded  '],
    ['a newline', 'a\r\nb'],
    ['a NUL byte', 'a\u0000b'],
  ])('leaves %s verbatim — the escape is not a blanket re-encoding', async (_name, value) => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'p')

    await repo.tx(tx => tx.setProperty('p', statusSchema, value),
      {scope: ChangeScope.BlockDefault})

    expect(await cellValue('p')).toBe(value)
    const values = (await valueRows('p')).filter(v => v.deleted === 0)
    expect(values[0]!.content).toBe(value)
  })

  // The projection is the half that actually lost the value, so drive it on
  // its own: an unrelated edit under the field row reprojects the cell from
  // the value children, and must reconstruct the same string.
  it('reprojects the escaped value unchanged when the field row is touched again', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'p')
    const value = `::((${SAMPLE_UUID}))`
    await repo.tx(tx => tx.setProperty('p', statusSchema, value),
      {scope: ChangeScope.BlockDefault})

    const [field] = await liveFieldRows('p')
    await repo.tx(tx => tx.update(field!.id, {content: field!.content}),
      {scope: ChangeScope.BlockDefault})

    expect(await cellValue('p')).toBe(value)
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
    registerDefinition(repo, 'test-priority-definition', PRIORITY_FIELD_ID, prioritySchema)
    return repo
  }

  const priorityFieldRows = liveFieldRowsFor(PRIORITY_FIELD_ID)

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
    registerDefinition(repo, 'test-count-definition', 'field-count-children', countSchema)
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
    registerDefinition(repo, 'test-related-definition', RELATED_FIELD_ID, relatedSchema)
    return repo
  }

  const relatedCell = async (id: string): Promise<unknown> =>
    (await bagOf(id))[relatedSchema.name]

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

  // #443 group 3: the projection's ref decode gates on the content's FORM, not
  // on `reference_target_id` being non-null. End-to-end because the column read
  // was defensible in isolation and only wrong once you see what DERIVE
  // actually stamps: a whole-block `[[alias]]` resolves through the live alias
  // index, so the column is populated with a REAL, WRONG block id. Before the
  // fix this test measured `cell === 'mary-page'` — the property silently
  // followed a name the user typed over the id it held.
  it('a wikilink typed into a ref value unsets the cell — never re-points it', async () => {
    const repo = await setupWithRef()
    await createBlock(repo, 'p')
    await createBlock(repo, 'mary-page')
    await repo.tx(tx => tx.update('mary-page', {properties: {[aliasesProp.name]: ['Mary']}}),
      {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.setProperty('p', relatedSchema, 'target-xyz'),
      {scope: ChangeScope.BlockDefault})
    const value = await relatedValueChild('p')

    await repo.tx(tx => tx.update(value!.id, {content: '[[Mary]]'}),
      {scope: ChangeScope.BlockDefault})

    expect(await relatedCell('p')).toBeUndefined()
    const survivor = await relatedValueChild('p')
    // The row keeps the user's text and stays visible/fixable in the tree...
    expect(survivor?.content).toBe('[[Mary]]')
    // ...and the derived column is still stamped, which is the whole point:
    // it resolves, so the OLD decode would have coerced this into a ref value.
    expect(survivor?.reference_target_id).toBe('mary-page')
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

  it('excludes them in an UN-flipped workspace too, matching the SQL view', async () => {
    // `tx.childrenOf(..., hidePropertyChildren)` is the in-transaction twin of
    // VISIBLE_CHILDREN_SQL and must answer the same question. The backfill
    // mints field rows before the flip; while this was gated and the SQL was
    // not, the two disagreed — and `agent-runtime`'s delete path uses THIS one
    // to decide what is foreign content to rescue, so a hidden field row got
    // reparented onto the wrong owner.
    await seedWorkspace('cell')
    const repo = setup()
    await seedDefinitionBlock(repo)
    await createBlock(repo, 'p')
    await repo.tx(async tx => {
      await tx.create({
        id: 'content-child', workspaceId: WS, parentId: 'p', orderKey: 'm', content: 'note',
      })
      // Built by hand: the dual-write processors are dormant pre-flip, which
      // is exactly why only the backfill produces this shape.
      await tx.create({
        id: 'field', workspaceId: WS, parentId: 'p', orderKey: 'a',
        content: propertyFieldContent(STATUS_FIELD_ID), referenceTargetId: STATUS_FIELD_ID,
      })
    }, {scope: ChangeScope.BlockDefault})

    await repo.tx(async tx => {
      const visible = await tx.childrenOf('p', undefined, {hidePropertyChildren: true})
      expect(visible.map(c => c.id)).toEqual(['content-child'])
      expect(await tx.childrenOf('p')).toHaveLength(2)
    }, {scope: ChangeScope.BlockDefault})
  })

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

  it('a custom mergeProperties dropping a source-only key does not reap its rows', async () => {
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
      // Strategy keeps ONLY into's bag → drops from's `status` from the bag.
      await mergeBlocksInTx(tx, {into: into!, from: from!, mergeProperties: intoProps => intoProps})
    }, {scope: ChangeScope.BlockDefault})

    // Child-backed properties are owned by their ROWS (§5's one-direction
    // rule), so editing the merged BAG is not a way to delete one: the row
    // moves over intact and PROJECT re-derives the cell from it. A strategy
    // that means to drop a property has to remove the rows itself, knowing
    // what is nested under them (#728).
    expect((await liveFieldRows('into')).map(f => f.id)).toEqual([fromField!.id])
    expect(await cellValue('into')).toBe('from-only')
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

  it("a source's ordinary block-ref child is not mistaken for the survivor's field row once re-homed", async () => {
    // The sibling case to the PR #386 one below, and the half the fold's
    // visible-child SET exists for. `from`'s ordinary `((STATUS))` child is
    // re-homed under `into` BEFORE the field-row scan runs, so unless the set
    // grows to include it the scan sees a child of `into` carrying a
    // definition-shaped `reference_target_id` and registers it as `into`'s
    // field row for Status — after which `from`'s genuine field row collapses
    // into that unrelated block and is tombstoned.
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'into')
    await createBlock(repo, 'from')
    await repo.tx(tx => tx.setProperty('from', statusSchema, 'from-status'),
      {scope: ChangeScope.BlockDefault})
    const [fromField] = await liveFieldRows('from')
    await repo.tx(async tx => {
      await tx.create({
        id: 'plain-ref', workspaceId: WS, parentId: 'from', orderKey: keyAtStart(),
        content: `((${STATUS_FIELD_ID}))`, referenceTargetId: STATUS_FIELD_ID,
      })
    }, {scope: ChangeScope.BlockDefault})

    await repo.tx(async tx => {
      const into = await tx.get('into')
      const from = await tx.get('from')
      await mergeBlocksInTx(tx, {into: into!, from: from!})
    }, {scope: ChangeScope.BlockDefault})

    // The genuine field row moved across intact, and the ordinary child took
    // nothing under it.
    const fromFieldRow = await sharedDb.db.get<{deleted: number; parent_id: string}>(
      'SELECT deleted, parent_id FROM blocks WHERE id = ?', [fromField!.id],
    )
    expect(fromFieldRow.deleted).toBe(0)
    expect(fromFieldRow.parent_id).toBe('into')
    expect((await childrenRows('plain-ref')).filter(c => c.deleted === 0)).toEqual([])
    expect(await cellValue('into')).toBe('from-status')
  })

  it('an ordinary `((definitionId))` child of a value-row `into` is not mistaken for its field row (PR #386 review)', async () => {
    // `into` here is itself a property VALUE row — `owner`'s Status value —
    // which has its OWN ordinary child that happens to be a block-ref to the
    // Status definition. That child is ordinary content because it is
    // UNMARKED, not because of where it sits: under flat §9 recognition a
    // value row hosts its own field rows like any other block, and only the
    // `::` bit separates them. Its `reference_target_id` alone is
    // indistinguishable from a real field row's, so the answer has to come
    // from the visible-children exclusion (`hidePropertyChildren`) — which
    // is exactly what `intoFieldByFieldId` must do.
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

describe('merge never reaps a source field row (#728)', () => {
  const COUNT_FIELD_ID = 'field-count-children'
  const countSchema = defineProperty<number>('count', {
    codec: codecs.number,
    defaultValue: 0,
    changeScope: ChangeScope.BlockDefault,
  })

  /** `setup()` plus a NUMBER property. The state this suite is about — cell
   *  key unset, rows still live — needs a codec that can REJECT a value
   *  child's text, which `codecs.string` never does. */
  const setupWithCount = (): Repo => {
    const repo = setup()
    registerDefinition(repo, 'test-count-definition', COUNT_FIELD_ID, countSchema)
    return repo
  }

  const countFieldRows = liveFieldRowsFor(COUNT_FIELD_ID)

  const rowOf = async (id: string) => sharedDb.db.get<{
    deleted: number; parent_id: string; content: string
  }>('SELECT deleted, parent_id, content FROM blocks WHERE id = ?', [id])

  /** Root of `id`'s LIVE ancestry, or null if `id` or any ancestor is
   *  tombstoned — the difference between "not deleted" and "reachable", which
   *  is what a merge left under a source tombstone gets wrong. */
  const liveRootOf = async (id: string): Promise<string | null> => {
    let cursor: string | null = id
    while (cursor !== null) {
      const row: {parent_id: string | null; deleted: number} = await sharedDb.db.get(
        'SELECT parent_id, deleted FROM blocks WHERE id = ?', [cursor],
      )
      if (row.deleted === 1) return null
      if (row.parent_id === null) return cursor
      cursor = row.parent_id
    }
    return null
  }

  /** `from` holds a field row whose value no longer decodes, so PROJECT has
   *  unset the cell key while keeping the rows visible/fixable (§9) — plus a
   *  user-authored note under the value. Returns the three row ids. */
  const seedKeylessFieldRow = async (
    repo: Repo, owner: string,
  ): Promise<{fieldId: string; valueId: string; noteId: string}> => {
    await repo.tx(tx => tx.setProperty(owner, countSchema, 42),
      {scope: ChangeScope.BlockDefault})
    const [field] = await countFieldRows(owner)
    const [value] = (await childrenRows(field!.id)).filter(v => v.deleted === 0)
    await repo.mutate.setContent({id: value!.id, content: 'about forty-two'})
    const noteId = `note-${owner}`
    await repo.tx(async tx => {
      await tx.create({
        id: noteId, workspaceId: WS, parentId: value!.id, orderKey: 'a',
        content: 'measured on the old scale',
      })
    }, {scope: ChangeScope.BlockDefault})

    // Preconditions, asserted rather than assumed: an un-flipped workspace or
    // a still-parsing value would never reach the branch under test.
    expect(Object.hasOwn(await bagOf(owner), countSchema.name)).toBe(false)
    expect((await countFieldRows(owner)).map(r => r.id)).toEqual([field!.id])
    return {fieldId: field!.id, valueId: value!.id, noteId}
  }

  it('moves the row, its unparseable value and the user note onto the survivor', async () => {
    await seedWorkspace('children')
    const repo = setupWithCount()
    await createBlock(repo, 'into')
    await createBlock(repo, 'from')
    const {fieldId, valueId, noteId} = await seedKeylessFieldRow(repo, 'from')

    await repo.mutate.merge({intoId: 'into', fromId: 'from'})

    expect(await rowOf(fieldId)).toMatchObject({deleted: 0, parent_id: 'into'})
    expect(await rowOf(valueId)).toMatchObject({
      deleted: 0, parent_id: fieldId, content: 'about forty-two',
    })
    expect(await rowOf(noteId)).toMatchObject({deleted: 0, parent_id: valueId})
    expect(await liveRootOf(noteId)).toBe('into')
    // The cell stays unset: the adopted row still has no value that decodes,
    // so PROJECT adds nothing. Moving it is inert for the survivor's bag.
    expect(Object.hasOwn(await bagOf('into'), countSchema.name)).toBe(false)
    // Nothing stranded live under the `from` tombstone.
    expect(await sharedDb.db.getAll(
      `SELECT b.id FROM blocks b JOIN blocks p ON p.id = b.parent_id
        WHERE p.deleted = 1 AND b.deleted = 0 AND b.workspace_id = ?`, [WS],
    )).toEqual([])
  })

  it('undo restores the row under the source, cell still unset', async () => {
    await seedWorkspace('children')
    const repo = setupWithCount()
    await createBlock(repo, 'into')
    await createBlock(repo, 'from')
    const {fieldId, valueId, noteId} = await seedKeylessFieldRow(repo, 'from')
    repo.undoManager.clear()

    await repo.mutate.merge({intoId: 'into', fromId: 'from'})
    expect(await liveRootOf(noteId)).toBe('into')

    expect(await repo.undo()).toBe(true)
    expect(await rowOf('from')).toMatchObject({deleted: 0})
    expect(await rowOf(fieldId)).toMatchObject({deleted: 0, parent_id: 'from'})
    expect(await rowOf(valueId)).toMatchObject({deleted: 0, parent_id: fieldId, content: 'about forty-two'})
    expect(await rowOf(noteId)).toMatchObject({deleted: 0, parent_id: valueId})
    expect(await liveRootOf(noteId)).toBe('from')
    expect(Object.hasOwn(await bagOf('from'), countSchema.name)).toBe(false)

    expect(await repo.redo()).toBe(true)
    expect(await liveRootOf(noteId)).toBe('into')
  })

  it.each([
    ['keyless source first', ['a', 'b']],
    ['keyless source second', ['b', 'a']],
  ] as const)('survives either fold order — %s', async (_label, order) => {
    await seedWorkspace('children')
    const repo = setupWithCount()
    await createBlock(repo, 'into')
    await createBlock(repo, 'a')
    await createBlock(repo, 'b')
    const {valueId, noteId} = await seedKeylessFieldRow(repo, 'a')
    // `b` holds the same property with a value that DOES decode, so one source
    // supplies the survivor's field row and the other has to fold into it.
    await repo.tx(tx => tx.setProperty('b', countSchema, 7),
      {scope: ChangeScope.BlockDefault})

    await repo.tx(async tx => {
      const into = await tx.get('into')
      const froms = await Promise.all(order.map(id => tx.get(id)))
      await foldBlocksInTx(tx, {into: into!, froms: froms.map(f => f!)})
    }, {scope: ChangeScope.BlockDefault})

    // `foldBlocksInTx` folds in whatever order its caller supplies — for the
    // alias-collision flow, its own claimant order, which the user never chose
    // — so the outcome must not depend on it. Only the keyless-source-FIRST arm
    // exercises the adopt branch; folding it second routes through
    // `collapseDuplicateFieldRow`, which never reaped — that arm is the control
    // the first is compared against. Which value TEXT wins is still
    // order-dependent, via MATERIALIZE's cell-wins overwrite of the primary
    // value child; that is a `setProperty` rule reachable with no merge at all,
    // so it is deliberately not asserted here.
    expect(await liveRootOf(valueId)).toBe('into')
    expect(await liveRootOf(noteId)).toBe('into')
    expect((await bagOf('into'))[countSchema.name]).toBe(7)
  })
})

describe('pre-backfill window: merging into a cell-only target (§5, #389 item 9)', () => {
  /** The flip is an operator UPDATE of the workspace row; between it and the
   *  backfill reaching a block, that block has a full cell and zero field
   *  rows. Same shape as any row that arrives by sync after the flip. */
  const flipToChildren = async (): Promise<void> => {
    await sharedDb.db.execute(
      'UPDATE workspaces SET properties_migration = ? WHERE id = ?', ['children', WS],
    )
  }

  it('keeps the target-wins value when `into` is cell-only and `from` is child-backed', async () => {
    await seedWorkspace('cell')
    const repo = setup()
    await createBlock(repo, 'into')
    await repo.tx(tx => tx.setProperty('into', statusSchema, 'target-value'),
      {scope: ChangeScope.BlockDefault})
    // The precondition the whole case rests on: a cell with nothing behind it.
    expect(await cellValue('into')).toBe('target-value')
    expect(await liveFieldRows('into')).toEqual([])

    await flipToChildren()

    await createBlock(repo, 'from')
    await repo.tx(tx => tx.setProperty('from', statusSchema, 'source-value'),
      {scope: ChangeScope.BlockDefault})
    expect((await liveFieldRows('from')).length).toBe(1)

    await repo.tx(async tx => {
      const into = await tx.get('into')
      const from = await tx.get('from')
      await mergeBlocksInTx(tx, {into: into!, from: from!})
    }, {scope: ChangeScope.BlockDefault})

    // `mergeProperties` rule 4 is target-wins, and a merge must not invert it
    // just because the target's value had not been materialized yet.
    expect(await cellValue('into')).toBe('target-value')
    // …and the source's divergent value is kept as a peer, not dropped —
    // §9 union-with-dedupe, identical to merging two child-backed blocks.
    const [intoField] = await liveFieldRows('into')
    const values = (await childrenRows(intoField!.id)).filter(v => v.deleted === 0)
    expect(values.map(v => v.content)).toEqual(['target-value', 'source-value'])
  })

  it('control: the same merge with `into` already child-backed', async () => {
    await seedWorkspace('children')
    const repo = setup()
    await createBlock(repo, 'into')
    await repo.tx(tx => tx.setProperty('into', statusSchema, 'target-value'),
      {scope: ChangeScope.BlockDefault})
    await createBlock(repo, 'from')
    await repo.tx(tx => tx.setProperty('from', statusSchema, 'source-value'),
      {scope: ChangeScope.BlockDefault})

    await repo.tx(async tx => {
      const into = await tx.get('into')
      const from = await tx.get('from')
      await mergeBlocksInTx(tx, {into: into!, from: from!})
    }, {scope: ChangeScope.BlockDefault})

    // The shape the pre-backfill case above must reproduce exactly.
    expect(await cellValue('into')).toBe('target-value')
    const [intoField] = await liveFieldRows('into')
    const values = (await childrenRows(intoField!.id)).filter(v => v.deleted === 0)
    expect(values.map(v => v.content)).toEqual(['target-value', 'source-value'])
  })
})

describe('the catch-up runs UN-flipped too, and must (km-g5ev)', () => {
  /** The only way to hold a field row before the flip: `::((fieldId))` is
   *  recognized from CONTENT, so the derive pass stamps a hand-written one
   *  the same as a generated one. No pass mints these pre-flip. */
  const handAuthoredFieldRow = async (
    repo: Repo, owner: string, value: string,
  ): Promise<void> => {
    await repo.tx(async tx => {
      await tx.create({
        id: `${owner}-field`, workspaceId: WS, parentId: owner, orderKey: 'a0',
        content: propertyFieldContent(STATUS_FIELD_ID),
      })
      await tx.create({
        id: `${owner}-value`, workspaceId: WS, parentId: `${owner}-field`,
        orderKey: 'a0', content: value,
      })
    }, {scope: ChangeScope.BlockDefault})
  }

  it('keeps the target-wins value reachable through a later flip', async () => {
    await seedWorkspace('cell')
    const repo = setup()
    await seedDefinitionBlock(repo)
    await createBlock(repo, 'into')
    await repo.tx(tx => tx.setProperty('into', statusSchema, 'target-value'),
      {scope: ChangeScope.BlockDefault})
    await createBlock(repo, 'from')
    await handAuthoredFieldRow(repo, 'from', 'source-value')
    // Un-flipped precondition: `into` is cell-only because nothing dual-writes
    // here, and `from`'s row exists only because a user typed it.
    expect(await liveFieldRows('into')).toEqual([])
    expect((await liveFieldRows('from')).length).toBe(1)

    await repo.tx(async tx => {
      const into = await tx.get('into')
      const from = await tx.get('from')
      await mergeBlocksInTx(tx, {into: into!, from: from!})
    }, {scope: ChangeScope.BlockDefault})

    // Gating the catch-up on the flip is the tempting reading of "no pre-flip
    // machinery", and it LOSES DATA: `from`'s row is adopted instead, so
    // `into`'s only value row is the source's and the projection below
    // publishes it over the target's. Measured, not reasoned.
    const [intoField] = await liveFieldRows('into')
    const values = (await childrenRows(intoField!.id)).filter(v => v.deleted === 0)
    expect(values.map(v => v.content)).toEqual(['target-value', 'source-value'])

    // The stake, played out: the projection is dormant until the flip, so the
    // first touch of this field row afterwards is what publishes its first
    // value into the cell. Target-wins has to still hold there.
    await sharedDb.db.execute(
      'UPDATE workspaces SET properties_migration = ? WHERE id = ?', ['children', WS],
    )
    await repo.tx(tx => tx.update(values[1]!.id, {content: 'source-value-edited'}),
      {scope: ChangeScope.BlockDefault})
    expect(await cellValue('into')).toBe('target-value')
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

describe('§9 recognition on the WRITE side (round-2 review fixes)', () => {
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

  it('leaves an UNMARKED look-alike visible in an un-flipped workspace', async () => {
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

    // The child is field-row-SHAPED but UNMARKED (`[[status]]`, no `::`), so
    // `is_field_form` is not stamped and it is an ordinary reference block.
    // Only marked rows classify — which is the whole reason recognition no
    // longer needs to ask whether the workspace is flipped.
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

describe('content <-> value codecs: escaping strings content cannot hold as itself (#688)', () => {
  const urlSchema = defineProperty<string>('link', {
    codec: codecs.url,
    defaultValue: '',
    changeScope: ChangeScope.BlockDefault,
  })
  const UUID = SAMPLE_UUID

  // Every §7 span form, marked and unmarked. The marked ones are the ones that
  // DELETE the property; the rest make a string value a live reference. The
  // predicate is `isWholeContentReference` — the parser itself, plus the embed
  // marker — rather than a second copy of the grammar, so a form added to it is
  // covered here for free.
  const GRAMMAR_SHAPED = [
    `::((${UUID}))`,
    '::[[Some Page]]',
    `::[Mary](((${UUID})))`,
    `((${UUID}))`,
    '[[Some Page]]',
    `[Mary](((${UUID})))`,
    `  ::((${UUID}))  `,
  ]

  it.each(GRAMMAR_SHAPED)('escapes %j and round-trips it exactly', value => {
    for (const schema of [statusSchema, urlSchema]) {
      const content = propertyValueToChildContent(schema, value)
      expectEscapedEnvelope(schema, value, content)
    }
  })

  it('escapes a lone surrogate, which the content column would return as U+FFFD', () => {
    for (const value of ['a\uD800b', 'a\uDC00b', '\uD800']) {
      const content = propertyValueToChildContent(statusSchema, value)
      // JSON spells it `\ud800` — pure ASCII, so nothing below the content
      // column has an ill-formed sequence to replace.
      expectEscapedEnvelope(statusSchema, value, content)
      // ...and specifically ASCII-escaped, which is what the content column
      // needs — a raw surrogate there comes back as U+FFFD.
      expect(/[\uD800-\uDFFF]/.test(content)).toBe(false)
    }
  })

  it('leaves strings content CAN hold verbatim (valid pairs, NUL, controls, padding)', () => {
    for (const value of ['a😀b', 'a\u0000b', 'a\u0001\u001Fb', '  padded  ', 'a\r\nb', '((']) {
      expect(propertyValueToChildContent(statusSchema, value)).toBe(value)
      expect(propertyChildContentToEncodedValue(statusSchema, value)).toBe(value)
    }
  })

  // The recursion's job: without it the escaped content of `'"::((id))"'` and
  // of `'::((id))'` would be the same string, so one of the two could not come
  // back. Nesting is what makes the escape injective.
  it('a value that is ITSELF a quoted escapable string nests one level deeper', () => {
    const inner = `::((${UUID}))`
    const quoted = JSON.stringify(inner)
    expectEscapedEnvelope(statusSchema, quoted,
      propertyValueToChildContent(statusSchema, quoted))
    expect(propertyValueToChildContent(statusSchema, quoted))
      .not.toBe(propertyValueToChildContent(statusSchema, inner))
    for (const value of [inner, quoted, JSON.stringify(quoted)]) {
      const content = propertyValueToChildContent(statusSchema, value)
      expect(propertyChildContentToEncodedValue(statusSchema, content)).toBe(value)
    }
  })

  // A quoted string whose inner text needs NO escaping must stay verbatim, or
  // the decode would unquote a value the user actually typed with quotes.
  it('an ordinary quoted string is still stored verbatim, quotes and all', () => {
    const value = '"hello"'
    expect(propertyValueToChildContent(statusSchema, value)).toBe(value)
    expect(propertyChildContentToEncodedValue(statusSchema, value)).toBe(value)
  })

  // Round 2 of review: the EMBED forms. `((id))` was escaped and `!((id))` was
  // not, though they differ by one character and the inline reader indexes
  // both — so a merge rewrote the second and silently edited the value.
  it.each([
    [`!((${SAMPLE_UUID}))`],
    ['![[Some Page]]'],
    [`  !((${SAMPLE_UUID}))  `],
  ])('escapes the embed form %j, which the whole-block reader alone misses', value => {
    const content = propertyValueToChildContent(statusSchema, value)
    expect(content).not.toBe(value)
    expect(propertyChildContentToEncodedValue(statusSchema, content)).toBe(value)
  })

  // Round 2 of review: quote-wrapping alone was treated as "this is an escaped
  // envelope", so text a PERSON wrote with quotes lost them on the way back.
  // A real envelope carries no literal span opener; this content does.
  it('does not unwrap quoted text that escapeContent could not have produced', () => {
    for (const content of ['"[[Page]]"', `"::((${SAMPLE_UUID}))"`, '"(x)"']) {
      expect(propertyChildContentToEncodedValue(statusSchema, content)).toBe(content)
    }
  })

  // ...while a real envelope still unwraps, including one whose PAYLOAD is a
  // quoted string (the nesting case), which is what stops the discriminator
  // from being "never unwrap".
  it('still unwraps a genuine envelope', () => {
    for (const value of [`::((${SAMPLE_UUID}))`, '[[Page]]', '"null"', 'a\uD800b']) {
      const content = propertyValueToChildContent(statusSchema, value)
      expect(propertyChildContentToEncodedValue(statusSchema, content)).toBe(value)
    }
  })

  // The ref codec renders `((id))` DELIBERATELY (#16) — that branch runs before
  // the string one and must not start escaping its own canonical form.
  it('does not touch the ref codec, whose value content IS a span by design', () => {
    const refSchema = defineProperty<string>('rel', {
      codec: codecs.ref(), defaultValue: '', changeScope: ChangeScope.BlockDefault,
    })
    const content = propertyValueToChildContent(refSchema, UUID)
    expect(content).toBe(`((${UUID}))`)
    expect(propertyChildContentToEncodedValue(refSchema, content)).toBe(UUID)
  })
})

describe('content <-> value codecs: ref values decode from the id-carrying span', () => {
  // A ref value child holds the reference in EDITABLE `((id))` form (the same
  // affordance as any block reference), while the cell keeps a bare id. The
  // read side parses the id out of the span, and accepts the ID-CARRYING forms
  // ONLY (§9; #443 group 3). It used to read `reference_target_id` instead, on
  // a stated invariant — "column is null iff content isn't a resolvable exact
  // ref" — that was false: the derive stamps that column for a whole-block
  // `[[alias]]` too, minting a seat when nothing claims it.
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

  it('reads the bare id back out of the `((id))` span', () => {
    const content = propertyValueToChildContent(refSchema, 'block-abc')
    expect(propertyChildContentToEncodedValue(refSchema, content)).toBe('block-abc')
  })

  it('accepts the aliased blockref form, keeping the id and dropping the label', () => {
    // `[label](((uuid)))` is the other id-carrying form — the one a rename or
    // merge rewrite pins a span to. A ref VALUE written that way still names
    // an id, so it decodes; the label is display text the cell has no room for.
    const uuid = '0123abcd-4567-89ef-0123-456789abcdef'
    expect(propertyChildContentToEncodedValue(refSchema, `[Mary](((${uuid})))`)).toBe(uuid)
  })

  it('rejects prose typed into a ref value instead of coercing it', () => {
    // "people will type text into ref properties, like logs" — the codec
    // throws → the projection skips it → the cell key reads unset while the
    // row text is preserved.
    expect(() =>
      propertyChildContentToEncodedValue(refSchema, 'saw a bug in prod today'),
    ).toThrow()
  })

  // The case the column read got WRONG, and the reason this decode moved to a
  // form check: in a real workspace this content has a non-null
  // `reference_target_id`, so a column-trusting decode wrote a live block id
  // into the cell. The end-to-end test above is the one that proves the column
  // really is populated; here it's the form alone that decides.
  it('rejects a whole-block wikilink', () => {
    expect(() => propertyChildContentToEncodedValue(refSchema, '[[Mary]]')).toThrow()
  })

  // ...and it must be THIS clause doing the refusing, not a downstream codec.
  // For a required ref `codecs.ref().decode(undefined)` throws anyway, so the
  // required case can't tell the two apart. `optionalRef` can: its
  // `decode(undefined)` returns undefined without throwing, which
  // `firstProjectedFieldValue` reads as "nothing parsed" — so a weakened
  // clause here would stop the value scan on a wikilink row and skip a later
  // sibling that does name an id.
  it('rejects a wikilink in an OPTIONAL ref too, where no codec catches it', () => {
    expect(() => propertyChildContentToEncodedValue(optionalRefSchema, '[[Mary]]')).toThrow()
  })

  it('rejects the MARKED id-carrying form — `::((id))` is a field row, not a value', () => {
    // §7: the marker makes the row machinery. Load-bearing through
    // find-replace, whose guard asks this function about PROPOSED content.
    expect(() => propertyChildContentToEncodedValue(refSchema, `::((${STATUS_FIELD_ID}))`))
      .toThrow()
  })

  it('an optional ref preserves an explicit null (sentinel wins over the form check)', () => {
    const content = encodedPropertyValueToChildContent(optionalRefSchema, null)
    expect(content).toBe('null')
    // Must NOT throw despite `null` being no reference form at all — the
    // generic null sentinel runs first, so an intentionally-unset optional ref
    // decodes to its unset form (encoded as null, like every other
    // null-accepting codec).
    expect(propertyChildContentToEncodedValue(optionalRefSchema, content)).toBeNull()
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
