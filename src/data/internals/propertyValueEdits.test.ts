// @vitest-environment node

import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {ChangeScope, CodecError, codecs, defineProperty, type AnyPropertySchema, type Tx} from '@/data/api'
import {projectedPropertyDefinitionsFacet} from '@/data/facets'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {PropertyEditRefusedError, clearPropertyValue, finishPropertyValueEdit, isPropertyValueEditable, openPropertyValue, writePropertyText, type PropertyEditRefusalReason} from './propertyValueEdits'

const workspaceId = 'ws-property-cell'
const fieldId = 'definition'
const ownerId = 'owner'
const options = {scope: ChangeScope.BlockDefault}
const textProperty = defineProperty('test:cell-text', {
  codec: codecs.string, defaultValue: 'fallback', changeScope: ChangeScope.BlockDefault,
})
const numberProperty = defineProperty('test:cell-number', {
  codec: codecs.number, defaultValue: 42, changeScope: ChangeScope.BlockDefault,
})
const booleanProperty = defineProperty('test:cell-boolean', {
  codec: codecs.boolean, defaultValue: true, changeScope: ChangeScope.BlockDefault,
})
const refProperty = defineProperty('test:cell-ref', {
  codec: codecs.ref(), defaultValue: '', changeScope: ChangeScope.BlockDefault,
})
const textListProperty = defineProperty('test:cell-text-list', {
  codec: codecs.list(codecs.string), defaultValue: [], changeScope: ChangeScope.BlockDefault,
})
const refListProperty = defineProperty('test:cell-ref-list', {
  codec: codecs.refList(), defaultValue: [], changeScope: ChangeScope.BlockDefault,
})
const choiceProperty = defineProperty('test:cell-choice', {
  codec: codecs.enum(['a', 'b']), defaultValue: 'a', changeScope: ChangeScope.BlockDefault,
})
const distinctListProperty = defineProperty<string[]>('test:cell-distinct-list', {
  codec: {
    ...codecs.list(codecs.string), type: 'test-distinct-list',
    decode(value: unknown) {
      const members = codecs.list(codecs.string).decode(value)
      if (new Set(members).size !== members.length) throw new CodecError('distinct members', value)
      return members
    },
  },
  changeScope: ChangeScope.BlockDefault, defaultValue: [],
})
const uiProperty = defineProperty('test:cell-ui', {
  codec: codecs.string, defaultValue: '', changeScope: ChangeScope.UiState,
})

const retiredProperty = defineProperty<string>('test:retired', {
  codec: {
    ...codecs.string, type: 'test-retired',
    encode(value: string) {
      if (value === 'retired') throw new CodecError('current value', value)
      return value
    },
  },
  changeScope: ChangeScope.BlockDefault, defaultValue: '',
})

let db: TestDb
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => { await resetTestDb(db.db) })

const setup = async (schema: AnyPropertySchema = textProperty, mode = 'children') => {
  await db.db.execute(
    `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time, encryption_mode, properties_migration)
      VALUES (?, 'test', 'test-user', 1, 1, 'none', ?)`,
    [workspaceId, mode],
  )
  const {repo} = createTestRepo({db: db.db})
  repo.setActiveWorkspaceId(workspaceId)
  repo.setRuntimeContributions(projectedPropertyDefinitionsFacet, 'test-definition', [{
    metadata: {
      fieldId, workspaceId, createdAt: 1, name: schema.name,
      changeScope: schema.changeScope, hidden: false, origin: 'user',
    },
    schema,
  }], {workspaceId})
  await seed({id: fieldId, properties: {types: ['property-schema']}})
  return repo
}

interface RawBlock {
  id: string
  parent?: string
  workspace?: string
  content?: string
  properties?: Record<string, unknown>
  references?: Array<{id: string; alias: string; sourceField: string}>
  fieldTarget?: string
  deleted?: boolean
}

const seed = async (...blocks: RawBlock[]) => {
  await db.db.writeTransaction(async tx => {
    for (const {id, parent, workspace, content, properties, references, fieldTarget, deleted} of blocks) {
      await tx.execute(
        `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json,
          references_json, created_at, updated_at, user_updated_at, created_by, updated_by,
          deleted, is_field_form, reference_target_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 'test-user', 'test-user', ?, ?, ?)`,
        [id, workspace ?? workspaceId, parent ?? null, 'a0', content ?? (fieldTarget ? `::((${fieldTarget}))` : ''),
          JSON.stringify(properties ?? {}), JSON.stringify(references ?? []), deleted ? 1 : 0, fieldTarget ? 1 : null, fieldTarget ?? null],
      )
    }
  })
}

const field = (id = 'field-a', parent = ownerId, fieldTarget = fieldId): RawBlock => ({id, parent, fieldTarget})
const value = (id: string, content: string, parent = 'field-a'): RawBlock => ({id, content, parent})
const children = (id: string) => db.db.getAll<{id: string; content: string}>(
  'SELECT id, content FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id', [id],
)
const projection = async (id = ownerId) => {
  const row = await db.db.get<{properties_json: string}>('SELECT properties_json FROM blocks WHERE id = ?', [id])
  return JSON.parse(row.properties_json) as Record<string, unknown>
}
const snapshot = () => db.db.getAll('SELECT * FROM blocks ORDER BY id')
const expectRefusal = async (action: Promise<unknown>, reason: PropertyEditRefusalReason, message?: string) => {
  const error: unknown = await action.then(() => undefined, error => error)
  expect(error).toBeInstanceOf(PropertyEditRefusedError)
  expect(error).toMatchObject({reason})
  if (message) expect(error).toHaveProperty('message', message)
}
const expectCommittedRefusal = async (
  repo: Awaited<ReturnType<typeof setup>>, run: (tx: Tx) => Promise<unknown>,
  reason: PropertyEditRefusalReason, message?: string, scope: ChangeScope = ChangeScope.BlockDefault,
) => {
  const before = await snapshot()
  await repo.tx(async tx => {
    await expectRefusal(run(tx), reason, message)
  }, {scope})
  expect(await snapshot()).toEqual(before)
}

describe('openPropertyValue', () => {
  it('materializes a readable stored value whose codec no longer accepts new writes', async () => {
    const schema = retiredProperty
    const repo = await setup(schema)
    await seed({id: ownerId, properties: {[schema.name]: 'retired'}})
    const edit = await repo.tx(tx => openPropertyValue(tx, ownerId, fieldId), options)
    const [fieldRow] = await children(ownerId)
    expect(await children(fieldRow!.id)).toEqual([{id: edit.valueId, content: '"retired"'}])
    expect(await projection()).toEqual({[schema.name]: 'retired'})
  })

  it('refuses to materialize a stored value outside the column options', async () => {
    const repo = await setup(choiceProperty)
    await seed({id: ownerId, properties: {[choiceProperty.name]: 'retired option'}})
    await expectCommittedRefusal(repo, tx => openPropertyValue(tx, ownerId, fieldId), 'would-change-stored-value')
  })

  // Pins the whole-list rejection leg, which the member round trip cannot see.
  it('refuses to materialize a stored list its codec rejects as a whole', async () => {
    const repo = await setup(distinctListProperty)
    await seed({id: ownerId, properties: {[distinctListProperty.name]: ['x', 'x']}})
    await expectCommittedRefusal(repo, tx => openPropertyValue(tx, ownerId, fieldId), 'would-change-stored-value')
  })

  it('folds an offline copy into the first of a field\'s repeated members', async () => {
    const repo = await setup(textListProperty)
    await seed({id: ownerId, properties: {[textListProperty.name]: ['b', 'b']}}, field(), value('b1', 'b'), value('b2', 'b'),
      field('field-b'), value('b3', 'b', 'field-b'), value('note', 'keep', 'b3'))

    await repo.tx(tx => openPropertyValue(tx, ownerId, fieldId), options)

    expect(await children('b1')).toEqual([{id: 'note', content: 'keep'}])
    expect(await projection()).toEqual({[textListProperty.name]: ['b', 'b']})
  })

  it.each([
    {prior: 'absent', rows: [], stored: undefined, created: true},
    {prior: 'stored only', rows: [], stored: 'old', created: false},
    {prior: 'an existing value', rows: [field(), value('value-a', 'old')], stored: 'old', created: false},
  ])('commits the first character while opening $prior', async ({rows, stored, created}) => {
    const repo = await setup()
    await seed({id: ownerId, properties: stored === undefined ? {} : {[textProperty.name]: stored}}, ...rows)

    const edit = await repo.tx(tx => openPropertyValue(tx, ownerId, fieldId, {initialText: 'h'}), options)
    const [fieldRow] = await children(ownerId)
    expect(await children(fieldRow!.id)).toEqual([{id: rows.length ? 'value-a' : edit.valueId, content: 'h'}])
    expect(edit.created).toBe(created)
    expect(await projection()).toEqual({[textProperty.name]: 'h'})
  })

  it.each([
    ['absent cell', false],
    ['existing empty field', true],
  ])('opens a blank value in an %s', async (_state, hasField) => {
    const repo = await setup()
    await seed({id: ownerId}, ...(hasField ? [field()] : []))

    const {valueId} = await repo.tx(tx => openPropertyValue(tx, ownerId, fieldId), options)

    const fields = await children(ownerId)
    expect(fields).toEqual([{id: hasField ? 'field-a' : expect.any(String), content: '::((definition))'}])
    expect(await children(fields[0]!.id)).toEqual([{id: valueId, content: ''}])
    expect(await projection()).toEqual({[textProperty.name]: ''})
  })

  it.each([
    {schema: booleanProperty, encoded: false, text: 'false', hasField: false},
    {schema: numberProperty, encoded: 0, text: '0', hasField: true},
    {schema: textProperty, encoded: '', text: '', hasField: false},
  ])('materializes stored $encoded with or without a field', async ({schema, encoded, text, hasField}) => {
    const repo = await setup(schema)
    await seed({id: ownerId, properties: {[schema.name]: encoded}}, ...(hasField ? [field()] : []))

    const {valueId} = await repo.tx(tx => openPropertyValue(tx, ownerId, fieldId), options)

    const fields = await children(ownerId)
    expect(fields).toEqual([{id: hasField ? 'field-a' : expect.any(String), content: '::((definition))'}])
    expect(await children(fields[0]!.id)).toEqual([{id: valueId, content: text}])
    expect(await projection()).toEqual({[schema.name]: encoded})
  })

  it.each([false, true])('refuses an unrepresentable stored reference without partial writes (existing field: %s)', async hasField => {
    const repo = await setup(refProperty)
    const encoded = 'an invalid id'
    await seed({id: ownerId, properties: {[refProperty.name]: encoded}, references: [
      {id: encoded, alias: encoded, sourceField: refProperty.name},
    ]}, ...(hasField ? [field()] : []))
    await expectCommittedRefusal(repo, tx => openPropertyValue(tx, ownerId, fieldId), 'would-change-stored-value')
  })

  it.each([
    {state: 'materialize a stored empty reference as an unset projection', schema: refProperty, encoded: '', rows: []},
    {state: 'fold duplicate fields when that would replace the stored projection', schema: numberProperty, encoded: 9,
      rows: [field(), field('field-b'), value('value-a', '5'), value('value-b', '9', 'field-b')]},
  ])('refuses to $state', async ({schema, encoded, rows}) => {
    const repo = await setup(schema)
    await seed({id: ownerId, properties: {[schema.name]: encoded}}, ...rows)
    await expectCommittedRefusal(repo, tx => openPropertyValue(tx, ownerId, fieldId), 'would-change-stored-value')
  })

  it.each([
    {values: [value('value-a', ' 5 ')], encoded: 5, expected: 'value-a'},
    {values: [value('value-a', 'unreadable')], encoded: undefined, expected: 'value-a'},
    {values: [value('value-a', 'unreadable'), value('value-b', ' 5 '), value('value-c', '7')], encoded: 5, expected: 'value-b'},
  ])('returns $expected in projection order without rewriting stored rows', async ({values, encoded, expected}) => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: encoded === undefined ? {} : {[numberProperty.name]: encoded}}, field(), ...values)
    const before = await snapshot()

    await expect(repo.tx(tx => openPropertyValue(tx, ownerId, fieldId), options)).resolves.toMatchObject({valueId: expected, created: false})
    expect(await snapshot()).toEqual(before)
  })

  it('opens a fresh row when no unreadable peer can be selected', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId}, field(), value('value-a', 'incomplete'), value('value-b', 'invalid'))

    const {valueId} = await repo.tx(tx => openPropertyValue(tx, ownerId, fieldId), options)

    expect(await children('field-a')).toEqual(expect.arrayContaining([
      {id: 'value-a', content: 'incomplete'}, {id: 'value-b', content: 'invalid'}, {id: valueId, content: ''},
    ]))
    expect(await projection()).toEqual({})
  })

  it.each([
    {schema: numberProperty, stored: 5, text: '5'},
    {schema: textListProperty, stored: ['x'], text: 'x'},
  ])('opens value-equal offline copies of $schema.name and relocates their notes', async ({schema, stored, text}) => {
    const repo = await setup(schema)
    await seed({id: ownerId, properties: {[schema.name]: stored}}, field(), field('field-b'),
      value('value-a', text), value('value-b', text, 'field-b'),
      value('note-a', 'first note', 'value-a'), value('note-b', 'other note', 'value-b'))

    const edit = await repo.tx(tx => openPropertyValue(tx, ownerId, fieldId), options)
    expect(edit).toMatchObject({valueId: 'value-a', created: false})
    expect(await children(ownerId)).toEqual([{id: 'field-a', content: '::((definition))'}])
    expect(await children('field-a')).toEqual([{id: 'value-a', content: text}])
    expect(await children('value-a')).toEqual([{id: 'note-a', content: 'first note'}, {id: 'note-b', content: 'other note'}])
    expect(await projection()).toEqual({[schema.name]: stored})
  })

  it('folds scalar copies by decoded value and keeps the survivor spelling', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 5}}, field(), field('field-b'),
      value('value-a', ' 5 '), value('value-b', '5', 'field-b'), value('note', 'keep', 'value-b'))
    await repo.tx(tx => openPropertyValue(tx, ownerId, fieldId), options)
    expect(await children('field-a')).toEqual([{id: 'value-a', content: ' 5 '}])
    expect(await children('value-a')).toEqual([{id: 'note', content: 'keep'}])
    expect(await projection()).toEqual({[numberProperty.name]: 5})
  })

  it('keeps independently unreadable scalar rows across fields', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId}, field(), field('field-b'), value('value-a', '?'), value('value-b', '?', 'field-b'))
    const edit = await repo.tx(tx => openPropertyValue(tx, ownerId, fieldId), options)
    expect(await children('field-a')).toEqual([
      {id: 'value-a', content: '?'}, {id: 'value-b', content: '?'}, {id: edit.valueId, content: ''},
    ])
  })

  it.each([
    {metadata: 'a stored property', properties: {annotation: 'keep'}, nested: []},
    {metadata: 'a nested field', properties: {}, nested: [field('nested', 'copy-b')]},
  ])('preserves every row when an offline copy owns $metadata', async ({properties, nested}) => {
    const repo = await setup(textListProperty)
    const members = ['first', 'second']
    await seed({id: ownerId, properties: {[textListProperty.name]: members}}, field(), field('field-b'),
      value('value-a', 'first'), value('value-b', 'second'),
      value('copy-a', 'first', 'field-b'), {...value('copy-b', 'second', 'field-b'), properties}, ...nested)
    await expectCommittedRefusal(repo, tx => openPropertyValue(tx, ownerId, fieldId), 'resolve-in-outline')
  })

  it('keeps both occurrences introduced together by the later field', async () => {
    const repo = await setup(textListProperty)
    const members = ['first', 'second', 'second']
    await seed({id: ownerId, properties: {[textListProperty.name]: members}}, field(), field('field-b'),
      value('value-a', 'first'), value('copy-a', 'first', 'field-b'),
      value('value-b', 'second', 'field-b'), value('value-c', 'second', 'field-b'))
    const edit = await repo.tx(tx => openPropertyValue(tx, ownerId, fieldId), options)
    expect(edit.valueId).toBe('value-c')
    expect(await children('field-a')).toEqual([
      {id: 'value-a', content: 'first'}, {id: 'value-b', content: 'second'}, {id: 'value-c', content: 'second'},
    ])
    expect(await projection()).toEqual({[textListProperty.name]: members})
  })

  it('folds duplicate fields while preserving divergent values and nested notes', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 5}}, field(), field('field-b'),
      value('value-a', '5'), value('value-b', '9', 'field-b'), value('note', 'keep', 'value-b'))

    await expect(repo.tx(tx => openPropertyValue(tx, ownerId, fieldId), options)).resolves.toMatchObject({valueId: 'value-a', created: false})

    expect(await children(ownerId)).toEqual([{id: 'field-a', content: '::((definition))'}])
    expect(await children('field-a')).toEqual([{id: 'value-a', content: '5'}, {id: 'value-b', content: '9'}])
    expect(await children('value-b')).toEqual([{id: 'note', content: 'keep'}])
    expect(await projection()).toEqual({[numberProperty.name]: 5})
  })
})

describe('writePropertyText', () => {
  it('refuses a new value rejected by the write side of a readable codec', async () => {
    const repo = await setup(retiredProperty)
    await seed({id: ownerId})
    await expectCommittedRefusal(repo, tx => writePropertyText(tx, ownerId, fieldId, '"retired"'), 'invalid-text')
  })

  it.each([
    ['absent', undefined, false],
    ['projection only', 7, false],
    ['empty field', undefined, true],
    ['empty field with projection', 7, true],
  ] as const)('writes a valid scalar to a cell with %s', async (_state, encoded, hasField) => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: encoded === undefined ? {} : {[numberProperty.name]: encoded}},
      ...(hasField ? [field()] : []))

    await repo.tx(tx => writePropertyText(tx, ownerId, fieldId, '4'), options)

    const fields = await children(ownerId)
    expect(fields).toEqual([{id: hasField ? 'field-a' : expect.any(String), content: '::((definition))'}])
    expect(await children(fields[0]!.id)).toEqual([{id: expect.any(String), content: '4'}])
    expect(await projection()).toEqual({[numberProperty.name]: 4})
  })

  it.each([
    {text: '6', encoded: 6},
    {text: 'still typing', encoded: 9},
  ])('writes $text to the selected row and preserves divergent peers', async ({text, encoded}) => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 5}}, field(), field('field-b'),
      value('value-a', 'existing invalid'), value('value-b', '5'), value('value-c', '9', 'field-b'))

    await repo.tx(tx => writePropertyText(tx, ownerId, fieldId, text), options)

    expect(await children(ownerId)).toEqual([{id: 'field-a', content: '::((definition))'}])
    expect(await children('field-a')).toEqual([
      {id: 'value-a', content: 'existing invalid'}, {id: 'value-b', content: text}, {id: 'value-c', content: '9'},
    ])
    expect(await projection()).toEqual({[numberProperty.name]: encoded})
  })

  it.each([
    {state: 'properties', properties: {annotation: 'keep'}, notes: []},
    {state: 'a nested note', properties: {}, notes: [value('note', 'keep', 'value-b')]},
  ])('refuses to fold the peer already holding the pasted scalar when it carries $state', async ({properties, notes}) => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 5}}, field(),
      value('value-a', '5'), {...value('value-b', '9'), properties}, ...notes)
    await expectCommittedRefusal(repo, tx => writePropertyText(tx, ownerId, fieldId, '9'), 'resolve-in-outline')
  })

  it('uses the only unreadable row for valid text', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId}, field(), value('value-a', 'unfinished'))

    await repo.tx(tx => writePropertyText(tx, ownerId, fieldId, '6'), options)

    expect(await children('field-a')).toEqual([{id: 'value-a', content: '6'}])
    expect(await projection()).toEqual({[numberProperty.name]: 6})
  })

  it('keeps multiple unreadable peers when there is no identifiable target', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId}, field(), value('value-a', 'incomplete'), value('value-b', 'invalid'))

    await repo.tx(tx => writePropertyText(tx, ownerId, fieldId, '6'), options)

    expect(await children('field-a')).toEqual(expect.arrayContaining([
      {id: 'value-a', content: 'incomplete'}, {id: 'value-b', content: 'invalid'}, {id: expect.any(String), content: '6'},
    ]))
    expect(await projection()).toEqual({[numberProperty.name]: 6})
  })

  it('keeps invalid pasted text with the stale projection removed', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 7}})

    await repo.tx(tx => writePropertyText(tx, ownerId, fieldId, 'unfinished'), options)

    const [fieldRow] = await children(ownerId)
    expect(await children(fieldRow!.id)).toEqual([{id: expect.any(String), content: 'unfinished'}])
    expect(await projection()).toEqual({})
  })

  it('refuses invalid pasted text that would turn a value row into a field', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 5}}, field(), value('value-a', '5'))
    await expectCommittedRefusal(repo, tx => writePropertyText(tx, ownerId, fieldId, '::((definition))'), 'invalid-text')
  })

  it('refuses an invalid draft with an unpaired surrogate before the content column replaces it', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 5}}, field(), value('value-a', '5'))
    await expectCommittedRefusal(repo, tx => writePropertyText(tx, ownerId, fieldId, '\ud800'), 'invalid-text')
  })

  it('clears on empty text', async () => {
    const repo = await setup()
    await seed({id: ownerId, properties: {[textProperty.name]: 'saved'}}, field(), value('value-a', 'saved'))

    await repo.tx(tx => writePropertyText(tx, ownerId, fieldId, ''), options)

    expect(await children(ownerId)).toEqual([])
    expect(await projection()).toEqual({})
  })
})

describe('clearPropertyValue', () => {
  it.each([
    ['absent', undefined, false],
    ['projection only', 'pending', false],
    ['empty field', undefined, true],
    ['empty field with projection', 'pending', true],
  ] as const)('clears a cell with %s and retains other keys', async (_state, encoded, hasField) => {
    const repo = await setup()
    await seed({id: ownerId, properties: {other: 'keep', ...(encoded === undefined ? {} : {[textProperty.name]: encoded})}},
      ...(hasField ? [field()] : []))

    await repo.tx(tx => clearPropertyValue(tx, ownerId, fieldId), options)

    expect(await children(ownerId)).toEqual([])
    expect(await projection()).toEqual({other: 'keep'})
  })

  it('clears childless values in every field, including unreadable and divergent ones', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 5}}, field(), field('field-b'),
      value('value-a', '5'), value('value-b', 'unreadable'), value('value-c', '9', 'field-b'))

    await repo.tx(tx => clearPropertyValue(tx, ownerId, fieldId), options)

    expect(await children(ownerId)).toEqual([])
    expect(await children('field-a')).toEqual([])
    expect(await children('field-b')).toEqual([])
    expect(await projection()).toEqual({})
  })

  it.each([
    {state: 'a nested note', rows: [value('note', 'keep this note', 'value-a')], properties: {}},
    {state: 'properties', rows: [], properties: {annotation: 'keep'}},
  ])('refuses to clear when a value row carries $state', async ({rows, properties}) => {
    const repo = await setup()
    await seed({id: ownerId, properties: {[textProperty.name]: 'first'}}, field(), field('field-b'),
      value('value-b', 'second', 'field-b'), {...value('value-a', 'first'), properties}, ...rows)
    await expectCommittedRefusal(repo, tx => clearPropertyValue(tx, ownerId, fieldId), 'resolve-in-outline')
    await expectCommittedRefusal(repo, tx => writePropertyText(tx, ownerId, fieldId, ''), 'resolve-in-outline')
  })

  it.each([
    {state: 'a nested field', fieldProperties: {}, rows: [field('nested-field', 'field-b'), value('nested-value', 'keep', 'nested-field')]},
    {state: 'properties', fieldProperties: {annotation: 'keep'}, rows: []},
  ])('deletes every value and keeps a field row carrying $state', async ({fieldProperties, rows}) => {
    const repo = await setup()
    await seed({id: ownerId, properties: {[textProperty.name]: 'first'}}, field(), {...field('field-b'), properties: fieldProperties},
      value('value-a', 'first'), value('value-b', 'second', 'field-b'), ...rows)

    await repo.tx(tx => clearPropertyValue(tx, ownerId, fieldId), options)

    expect(await children(ownerId)).toEqual([{id: 'field-b', content: '::((definition))'}])
    expect((await children('field-b')).map(row => row.id)).toEqual(rows.slice(0, 1).map(row => row.id))
    expect(await projection('field-b')).toEqual(fieldProperties)
    expect(await projection()).toEqual({})
  })

  it('clears an empty field projection without deleting its nested field row', async () => {
    const repo = await setup()
    await seed({id: ownerId, properties: {[textProperty.name]: 'pending'}}, field(), field('nested-field', 'field-a'))

    await repo.tx(tx => clearPropertyValue(tx, ownerId, fieldId), options)

    expect(await children(ownerId)).toEqual([{id: 'field-a', content: '::((definition))'}])
    expect(await children('field-a')).toEqual([{id: 'nested-field', content: '::((definition))'}])
    expect(await projection()).toEqual({})
  })

  it('keeps final text live through edit end and a late editor flush', async () => {
    const repo = await setup()
    await seed({id: ownerId})
    const draft = await repo.tx(tx => openPropertyValue(tx, ownerId, fieldId), options)
    await repo.tx(tx => finishPropertyValueEdit(tx, ownerId, fieldId, draft, 'hello'), options)
    expect(await projection()).toEqual({[textProperty.name]: 'hello'})
    await repo.tx(tx => tx.update(draft.valueId, {content: 'hello'}), options)

    expect(await db.db.get('SELECT deleted, content FROM blocks WHERE id = ?', [draft.valueId]))
      .toEqual({deleted: 0, content: 'hello'})
    expect(await projection()).toEqual({[textProperty.name]: 'hello'})
  })

  it.each([true, false])('removes exactly the blank row that finished editing (projected: %s)', async projected => {
    const repo = await setup()
    await seed({id: ownerId, properties: projected ? {[textProperty.name]: ''} : {}}, field(), value('value-a', ''))

    await repo.tx(tx => finishPropertyValueEdit(tx, ownerId, fieldId, {valueId: 'value-a', created: true, draftFieldId: 'field-a'}, ''), options)

    expect(await children(ownerId)).toEqual([])
    expect(await children('field-a')).toEqual([])
    expect(await projection()).toEqual({})
  })

  it.each([
    {state: 'nonempty after the final editor flush', content: 'typed'},
    {state: 'a whitespace-only string', content: ' '},
    {state: 'a replacement row', id: 'new-value'},
    {state: 'a nested note', extra: [value('note', 'keep', 'value-a')]},
    {state: 'properties on the blank value', properties: {annotation: 'keep'}},
    {state: 'another value row', extra: [value('peer', 'keep')]},
    {state: 'another blank value row', extra: [value('z-peer', '')]},
    {state: 'another field with a value', extra: [field('field-b'), value('peer', 'keep', 'field-b')]},
    {state: 'another empty field', extra: [field('field-b')]},
  ])('keeps the cell after editing when it has $state', async ({content = '', id = 'value-a', properties, extra = []}) => {
    const repo = await setup()
    await seed({id: ownerId, properties: {[textProperty.name]: content}}, field(), {...value(id, content), properties}, ...extra)
    const before = await snapshot()

    await repo.tx(tx => finishPropertyValueEdit(tx, ownerId, fieldId, {valueId: 'value-a', created: true, draftFieldId: 'field-a'}, content), options)

    expect(await snapshot()).toEqual(before)
  })

  it.each([
    {state: 'properties', fieldProperties: {annotation: 'keep'}, extra: []},
    {state: 'a nested field', fieldProperties: {}, extra: [field('nested-field', 'field-a', 'other-definition')]},
  ])('removes the blank draft but keeps its draft field when the field gained $state', async ({fieldProperties, extra}) => {
    const repo = await setup()
    await seed({id: ownerId}, {...field(), properties: fieldProperties}, value('value-a', ''), ...extra)

    await repo.tx(tx => finishPropertyValueEdit(tx, ownerId, fieldId, {valueId: 'value-a', created: true, draftFieldId: 'field-a'}, ''), options)

    expect(await children(ownerId)).toEqual([{id: 'field-a', content: `::((${fieldId}))`}])
    expect((await children('field-a')).map(row => row.id)).toEqual(extra.map(row => row.id))
    expect(await projection('field-a')).toEqual(fieldProperties)
  })

  it('saves through a bare id without removing the draft it names', async () => {
    const repo = await setup()
    await seed({id: ownerId})
    const draft = await repo.tx(tx => openPropertyValue(tx, ownerId, fieldId), options)
    const before = await snapshot()

    await repo.tx(tx => finishPropertyValueEdit(tx, ownerId, fieldId, draft.valueId, ''), options)

    expect(await snapshot()).toEqual(before)
  })

  it('keeps a stale stored value when cleaning up the associated blank editor row', async () => {
    const repo = await setup()
    await seed({id: ownerId, properties: {[textProperty.name]: 'pending'}}, field(), value('value-a', ''))
    const before = await snapshot()

    await repo.tx(tx => finishPropertyValueEdit(tx, ownerId, fieldId, {valueId: 'value-a', created: true, draftFieldId: 'field-a'}, ''), options)

    expect(await snapshot()).toEqual(before)
  })

  it('refuses to save final text into a row that moved out of the property', async () => {
    const repo = await setup()
    await seed({id: ownerId}, field(), value('value-a', 'old', ownerId))
    await expectCommittedRefusal(repo, tx => finishPropertyValueEdit(tx, ownerId, fieldId, 'value-a', 'edited'), 'resolve-in-outline')
  })

  it('keeps a pending key when the edited row is already gone', async () => {
    const repo = await setup()
    await seed({id: ownerId, properties: {[textProperty.name]: 'pending'}})
    const before = await snapshot()

    await repo.tx(tx => finishPropertyValueEdit(tx, ownerId, fieldId, {valueId: 'value-a', created: true, draftFieldId: 'field-a'}, ''), options)

    expect(await snapshot()).toEqual(before)
  })
})

it('marks only resolved block-scoped columns editable', () => {
  expect(isPropertyValueEditable(undefined)).toBe(false)
  expect(isPropertyValueEditable(uiProperty)).toBe(false)
  expect(isPropertyValueEditable(textProperty)).toBe(true)
})

const operations = {
  open: openPropertyValue,
  write: (tx: Tx, owner: string, field: string) => writePropertyText(tx, owner, field, 'new text'),
  clear: clearPropertyValue,
  finish: (tx: Tx, owner: string, field: string) => finishPropertyValueEdit(tx, owner, field, 'value-a', 'new text'),
}

describe.each(Object.entries(operations))('%s eligibility', (_operation, run) => {
  it.each([
    {state: 'missing owner', owner: 'missing', error: 'The property owner is missing or deleted.'},
    {state: 'deleted owner', deleted: true, error: 'The property owner is missing or deleted.'},
    {state: 'pre-flip workspace', mode: 'cell', error: 'This workspace does not store properties as rows.'},
    {state: 'unknown definition', definition: 'unknown', error: 'The property definition is unavailable.'},
    {state: 'non-block-scoped definition', schema: uiProperty, error: 'Only block-scoped properties can be edited as rows, in a block-scoped transaction.'},
    {state: 'wrong transaction scope', scope: ChangeScope.UiState, error: 'Only block-scoped properties can be edited as rows, in a block-scoped transaction.'},
  ])('refuses a $state before touching any rows', async ({
    owner = ownerId, deleted = false, mode = 'children', definition = fieldId, schema = textProperty,
    scope = ChangeScope.BlockDefault, error,
  }) => {
    const repo = await setup(schema, mode)
    await seed({id: ownerId, deleted, properties: {[schema.name]: 'old text'}}, field(), value('value-a', 'old text'))
    await expectCommittedRefusal(repo, tx => run(tx, owner, definition), 'read-only', error, scope)
  })
})

describe.each([
  ['open', operations.open],
  ['write', operations.write],
] as const)('%s with duplicate field metadata', (_operation, run) => {
  it.each([
    {state: 'properties', properties: {annotation: 'keep'}, nested: []},
    {state: 'a nested field', properties: {}, nested: [field('nested-field', 'field-b')]},
  ])('refuses to fold a duplicate field carrying $state', async ({properties, nested}) => {
    const repo = await setup()
    await seed({id: ownerId, properties: {[textProperty.name]: 'same'}}, field(),
      {...field('field-b'), properties}, value('value-a', 'same'), ...nested)
    await expectCommittedRefusal(repo, tx => run(tx, ownerId, fieldId), 'resolve-in-outline')
  })
})

describe('list properties', () => {
  it('opens the last text member without appending an empty string to the list', async () => {
    const repo = await setup(textListProperty)
    await seed({id: ownerId, properties: {[textListProperty.name]: ['first', 'last']}}, field(),
      value('value-a', 'first'), value('value-b', 'last'))
    const before = await snapshot()

    await expect(repo.tx(tx => openPropertyValue(tx, ownerId, fieldId), options)).resolves.toMatchObject({valueId: 'value-b', created: false})
    expect(await snapshot()).toEqual(before)
  })

  it.each([false, true])('materializes stored text members in order, including repeats (field: %s)', async hasField => {
    const repo = await setup(textListProperty)
    const members = ['second', 'first', 'second']
    await seed({id: ownerId, properties: {[textListProperty.name]: members}}, ...(hasField ? [field()] : []))

    const {valueId} = await repo.tx(tx => openPropertyValue(tx, ownerId, fieldId), options)

    const [fieldRow] = await children(ownerId)
    const values = await children(fieldRow!.id)
    expect(values.map(row => row.content)).toEqual(members)
    expect(values.at(-1)?.id).toBe(valueId)
    expect(await projection()).toEqual({[textListProperty.name]: members})
  })

  it('refuses to add a text member to a stored empty list just by opening it', async () => {
    const repo = await setup(textListProperty)
    await seed({id: ownerId, properties: {[textListProperty.name]: []}})
    await expectCommittedRefusal(repo, tx => openPropertyValue(tx, ownerId, fieldId), 'would-change-stored-value')
  })

  it.each([false, true])('opens a new reference-list member for a blank property (field: %s)', async hasField => {
    const repo = await setup(refListProperty)
    await seed({id: ownerId}, ...(hasField ? [field()] : []))

    const {valueId} = await repo.tx(tx => openPropertyValue(tx, ownerId, fieldId), options)

    const [fieldRow] = await children(ownerId)
    expect(await children(fieldRow!.id)).toEqual([{id: valueId, content: ''}])
    expect(await projection()).toEqual({[refListProperty.name]: []})
  })

  it('folds duplicate reference-list fields without coalescing repeated members', async () => {
    const repo = await setup(refListProperty)
    await seed({id: ownerId, properties: {[refListProperty.name]: ['target', 'target']}}, field(), field('field-b'),
      value('value-a', '((target))'), value('value-b', '((target))', 'field-b'))

    const {valueId} = await repo.tx(tx => openPropertyValue(tx, ownerId, fieldId), options)

    expect(await children(ownerId)).toEqual([{id: 'field-a', content: '::((definition))'}])
    expect(await children('field-a')).toEqual([
      {id: 'value-a', content: '((target))'}, {id: 'value-b', content: '((target))'}, {id: valueId, content: ''},
    ])
    expect(await projection()).toEqual({[refListProperty.name]: ['target', 'target']})
  })

  it('adds the first typed member to an explicitly empty string list', async () => {
    const repo = await setup(textListProperty)
    await seed({id: ownerId, properties: {[textListProperty.name]: []}})
    const edit = await repo.tx(tx => openPropertyValue(tx, ownerId, fieldId, {initialText: 'first'}), options)
    const [fieldRow] = await children(ownerId)
    expect(await children(fieldRow!.id)).toEqual([{id: edit.valueId, content: 'first'}])
    expect(await projection()).toEqual({[textListProperty.name]: ['first']})
  })

  it('opens a blank reference-list member without projecting it', async () => {
    const repo = await setup(refListProperty)
    await seed({id: ownerId, properties: {[refListProperty.name]: ['target']}}, field(), value('value-a', '((target))'))

    const {valueId} = await repo.tx(tx => openPropertyValue(tx, ownerId, fieldId), options)

    expect(await children('field-a')).toEqual([{id: 'value-a', content: '((target))'}, {id: valueId, content: ''}])
    expect(await projection()).toEqual({[refListProperty.name]: ['target']})
  })

  it.each([
    {state: 'no rows or projection', rows: []},
    {state: 'projection only', stored: ['old'], rows: []},
    {state: 'empty field', rows: [field()]},
    {state: 'existing members', stored: ['old'], rows: [field(), value('value-a', 'old')]},
    {state: 'duplicate fields', stored: ['old'], rows: [field(), field('field-b'), value('value-a', 'old', 'field-b')]},
  ])('replaces the whole list and preserves repetitions with $state', async ({stored, rows}) => {
    const repo = await setup(textListProperty)
    await seed({id: ownerId, properties: stored ? {[textListProperty.name]: stored} : {}}, ...rows)

    await repo.tx(tx => writePropertyText(tx, ownerId, fieldId, 'first\nsecond\nfirst'), options)

    const fields = await children(ownerId)
    expect(fields).toEqual([{id: rows.length ? 'field-a' : expect.any(String), content: '::((definition))'}])
    expect((await children(fields[0]!.id)).map(row => row.content)).toEqual(['first', 'second', 'first'])
    expect(await projection()).toEqual({[textListProperty.name]: ['first', 'second', 'first']})
  })

  it.each([false, true])('pastes the visible lagging member and keeps its note (offline copy: %s)', async copy => {
    const repo = await setup(textListProperty)
    await seed({id: ownerId, properties: {[textListProperty.name]: ['first']}}, field(),
      value('value-a', 'first'), value('lagging', 'second'), value('note', 'keep on second', 'lagging'),
      ...(copy ? [field('field-b'), value('copy', 'second', 'field-b'), value('copy-note', 'also keep', 'copy')] : []))

    await repo.tx(tx => writePropertyText(tx, ownerId, fieldId, 'second\nfirst\nthird'), options)

    expect(await projection()).toEqual({[textListProperty.name]: ['second', 'first', 'third']})
    expect(await children('field-a')).toEqual([
      {id: 'lagging', content: 'second'}, {id: 'value-a', content: 'first'}, {id: expect.any(String), content: 'third'},
    ])
    expect(await children('lagging')).toEqual([
      {id: 'note', content: 'keep on second'}, ...(copy ? [{id: 'copy-note', content: 'also keep'}] : []),
    ])
  })

  it('retains both annotated occurrences when a paste includes both offline rows', async () => {
    const repo = await setup(textListProperty)
    await seed({id: ownerId, properties: {[textListProperty.name]: ['old']}}, field(), field('field-b'),
      value('value-a', 'same'), value('value-b', 'same', 'field-b'), value('note', 'keep', 'value-b'))
    await repo.tx(tx => writePropertyText(tx, ownerId, fieldId, 'same\nsame'), options)
    expect(await children('field-a')).toEqual([{id: 'value-a', content: 'same'}, {id: 'value-b', content: 'same'}])
    expect(await children('value-b')).toEqual([{id: 'note', content: 'keep'}])
    expect(await projection()).toEqual({[textListProperty.name]: ['same', 'same']})
  })

  it('refuses to remove a lagging member whose offline copy carries the only note', async () => {
    const repo = await setup(textListProperty)
    await seed({id: ownerId, properties: {[textListProperty.name]: ['first']}}, field(),
      value('value-a', 'first'), value('lagging', 'second'), field('field-b'),
      value('copy', 'second', 'field-b'), value('note', 'keep', 'copy'))
    await expectCommittedRefusal(repo, tx => writePropertyText(tx, ownerId, fieldId, 'first'), 'resolve-in-outline')
  })

  it('refuses a whole reference list paste when one member is invalid', async () => {
    const repo = await setup(refListProperty)
    await seed({id: ownerId, properties: {[refListProperty.name]: ['target']},
      references: [{id: 'target', alias: 'target', sourceField: refListProperty.name}]},
    field(), value('value-a', '((target))'))
    await expectCommittedRefusal(repo, tx => writePropertyText(tx, ownerId, fieldId, '((replacement))\nunfinished'), 'invalid-text')
  })

  it('refuses a replacement that would remove an annotated list member', async () => {
    const repo = await setup(textListProperty)
    await seed({id: ownerId, properties: {[textListProperty.name]: ['first', 'second']}}, field(),
      value('value-a', 'first'), value('value-b', 'second'), value('note', 'keep', 'value-b'))
    await expectCommittedRefusal(repo, tx => writePropertyText(tx, ownerId, fieldId, 'first'), 'resolve-in-outline')
  })

  it.each([
    {state: 'properties', properties: {annotation: 'keep'}, notes: []},
    {state: 'a nested note', properties: {}, notes: [value('note', 'keep', 'value-b')]},
  ])('refuses to shorten a repeated list member carrying $state', async ({properties, notes}) => {
    const repo = await setup(textListProperty)
    await seed({id: ownerId, properties: {[textListProperty.name]: ['same', 'same']}}, field(),
      value('value-a', 'same'), {...value('value-b', 'same'), properties}, ...notes)
    await expectCommittedRefusal(repo, tx => writePropertyText(tx, ownerId, fieldId, 'same'), 'resolve-in-outline')
  })

  it.each([
    {state: 'no rows or projection', rows: []},
    {state: 'projection only', stored: ['old'], rows: []},
    {state: 'empty field', rows: [field()]},
    {state: 'duplicate fields', stored: ['old'], rows: [field(), field('field-b'), value('value-a', 'old', 'field-b')]},
  ])('clears a list with $state', async ({stored, rows}) => {
    const repo = await setup(textListProperty)
    await seed({id: ownerId, properties: stored ? {[textListProperty.name]: stored} : {}}, ...rows)

    await repo.tx(tx => clearPropertyValue(tx, ownerId, fieldId), options)

    expect(await children(ownerId)).toEqual([])
    expect(await projection()).toEqual({})
  })

  it('refuses to clear a list with an annotated member', async () => {
    const repo = await setup(refListProperty)
    await seed({id: ownerId, properties: {[refListProperty.name]: ['first', 'second']}}, field(),
      value('value-a', '((first))'), value('value-b', '((second))'), value('note', 'keep', 'value-b'))
    await expectCommittedRefusal(repo, tx => clearPropertyValue(tx, ownerId, fieldId), 'resolve-in-outline')
  })
})

describe('range writes', () => {
  it('undoes changes to both owners in one step', async () => {
    const repo = await setup()
    await seed({id: ownerId, properties: {[textProperty.name]: 'before'}}, field(), value('value-a', 'before'),
      {id: 'other-owner', properties: {[textProperty.name]: 'clear me'}}, field('field-b', 'other-owner'),
      value('value-b', 'clear me', 'field-b'))

    await repo.tx(async tx => {
      await writePropertyText(tx, ownerId, fieldId, 'after')
      await clearPropertyValue(tx, 'other-owner', fieldId)
    }, options)
    expect(await children('field-a')).toEqual([{id: 'value-a', content: 'after'}])
    expect(await children('other-owner')).toEqual([])
    expect(await projection()).toEqual({[textProperty.name]: 'after'})
    expect(await projection('other-owner')).toEqual({})

    await repo.undo(ChangeScope.BlockDefault)
    expect(await children('field-a')).toEqual([{id: 'value-a', content: 'before'}])
    expect(await children('other-owner')).toEqual([{id: 'field-b', content: '::((definition))'}])
    expect(await children('field-b')).toEqual([{id: 'value-b', content: 'clear me'}])
    expect(await projection()).toEqual({[textProperty.name]: 'before'})
    expect(await projection('other-owner')).toEqual({[textProperty.name]: 'clear me'})
  })

  it('rolls back the first write when the second refuses the paste', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 5}}, field(), value('value-a', '5'),
      {id: 'other-owner', properties: {[numberProperty.name]: 9}}, field('field-b', 'other-owner'),
      value('value-b', '9', 'field-b'))
    const before = await snapshot()

    await expectRefusal(repo.tx(async tx => {
      await writePropertyText(tx, ownerId, fieldId, '6')
      await writePropertyText(tx, 'other-owner', fieldId, '::((definition))')
    }, options), 'invalid-text')

    expect(await snapshot()).toEqual(before)
  })
})

describe('write boundaries', () => {
  it('refuses navigation in a transaction pinned to a different workspace', async () => {
    const repo = await setup()
    await seed({id: ownerId}, field(), value('value-a', 'saved'))
    await repo.tx(async tx => {
      await tx.create({workspaceId: 'other', parentId: null, content: 'other', orderKey: 'a0'})
      expect(tx.meta.workspaceId).toBe('other')
      await expect(openPropertyValue(tx, ownerId, fieldId)).rejects.toMatchObject({name: 'WorkspaceMismatchError'})
    }, {...options, allowUnloadedWorkspace: true})
  })

  it('refuses a new blank among unreadable scalar peers with a stale stored value', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 2}}, field(), value('value-a', 'one'), value('value-b', 'two'))
    await expectCommittedRefusal(repo, tx => openPropertyValue(tx, ownerId, fieldId), 'would-change-stored-value')
  })

  it('reprojects unchanged unreadable text when the bag has a late value', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 2}}, field(), value('value-a', 'unfinished'))
    await repo.tx(tx => writePropertyText(tx, ownerId, fieldId, 'unfinished'), options)
    expect(await children('field-a')).toEqual([{id: 'value-a', content: 'unfinished'}])
    expect(await projection()).toEqual({})
  })

  it('retains an annotated primary when its scalar is pasted again', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 3}}, field(), value('value-a', '3'), value('note', 'keep', 'value-a'))
    await repo.tx(tx => writePropertyText(tx, ownerId, fieldId, '3'), options)
    expect(await children('value-a')).toEqual([{id: 'note', content: 'keep'}])
    expect(await projection()).toEqual({[numberProperty.name]: 3})
  })

  it('keeps an annotated divergent peer when replacing the scalar', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 3}}, field(), value('value-a', '3'),
      value('value-b', '7'), value('note', 'keep', 'value-b'))
    await repo.tx(tx => writePropertyText(tx, ownerId, fieldId, '4'), options)
    expect(await children('value-b')).toEqual([{id: 'note', content: 'keep'}])
    expect(await projection()).toEqual({[numberProperty.name]: 4})
  })

  it('folds an unannotated scalar peer that already holds the pasted value', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 3}}, field(), value('value-a', '3'), value('value-b', '7'))
    await repo.tx(tx => writePropertyText(tx, ownerId, fieldId, '7'), options)
    expect(await children('field-a')).toEqual([{id: 'value-a', content: '7'}])
  })

  it('preserves an unreadable list member and its notes while replacing valid members', async () => {
    const repo = await setup(refListProperty)
    await seed({id: ownerId}, field(), value('value-a', 'invalid'), value('note', 'keep', 'value-a'))
    await repo.tx(tx => writePropertyText(tx, ownerId, fieldId, '((target))'), options)
    expect(await children('field-a')).toEqual(expect.arrayContaining([{id: 'value-a', content: 'invalid'}]))
    expect(await children('value-a')).toEqual([{id: 'note', content: 'keep'}])
    expect(await projection()).toEqual({[refListProperty.name]: ['target']})
  })
})

describe('several edits to the same property in one transaction', () => {
  it.each([undefined, 5])('keeps the invalid draft after writing a valid scalar (prior: %s)', async prior => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: prior === undefined ? {} : {[numberProperty.name]: prior}},
      ...(prior === undefined ? [] : [field(), value('value-a', String(prior))]))

    await repo.tx(async tx => {
      await writePropertyText(tx, ownerId, fieldId, '6')
      await writePropertyText(tx, ownerId, fieldId, 'unfinished')
    }, options)

    const [fieldRow] = await children(ownerId)
    expect(await children(fieldRow!.id)).toEqual([{id: prior === undefined ? expect.any(String) : 'value-a', content: 'unfinished'}])
    expect(await projection()).toEqual({})
  })

  it('honors a clear after writing a valid scalar', async () => {
    const repo = await setup()
    await seed({id: ownerId, properties: {[textProperty.name]: 'before'}}, field(), value('value-a', 'before'))

    await repo.tx(async tx => {
      await writePropertyText(tx, ownerId, fieldId, 'after')
      await clearPropertyValue(tx, ownerId, fieldId)
    }, options)

    expect(await children(ownerId)).toEqual([])
    expect(await projection()).toEqual({})
  })

  it('keeps an earlier write when a clear of the annotated row refuses', async () => {
    const repo = await setup()
    await seed({id: ownerId, properties: {[textProperty.name]: 'before'}}, field(), value('value-a', 'before'),
      value('note', 'keep', 'value-a'))

    await repo.tx(async tx => {
      await writePropertyText(tx, ownerId, fieldId, 'after')
      await expectRefusal(clearPropertyValue(tx, ownerId, fieldId), 'resolve-in-outline')
    }, options)

    expect(await children('field-a')).toEqual([{id: 'value-a', content: 'after'}])
    expect(await children('value-a')).toEqual([{id: 'note', content: 'keep'}])
    expect(await projection()).toEqual({[textProperty.name]: 'after'})
  })

  it('opens a blank row after clearing a pending key without rematerializing the cleared value', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 5}})

    const {valueId} = await repo.tx(async tx => {
      await clearPropertyValue(tx, ownerId, fieldId)
      return openPropertyValue(tx, ownerId, fieldId)
    }, options)

    const [fieldRow] = await children(ownerId)
    expect(await children(fieldRow!.id)).toEqual([{id: valueId, content: ''}])
    expect(await projection()).toEqual({})
  })

  it('projects the valid edit after an invalid edit to the same row', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 5}}, field(), value('value-a', '5'))

    await repo.tx(async tx => {
      await writePropertyText(tx, ownerId, fieldId, 'unfinished')
      await writePropertyText(tx, ownerId, fieldId, '6')
    }, options)

    expect(await children('field-a')).toEqual([{id: 'value-a', content: '6'}])
    expect(await projection()).toEqual({[numberProperty.name]: 6})
  })
})

describe.each([
  {name: 'initial editor text without rows', existing: false, run: (tx: Tx, text: string) => openPropertyValue(tx, ownerId, fieldId, {initialText: text})},
  {name: 'initial editor text with existing rows', existing: true, run: (tx: Tx, text: string) => openPropertyValue(tx, ownerId, fieldId, {initialText: text})},
  {name: 'final editor text', existing: true, run: (tx: Tx, text: string) => finishPropertyValueEdit(tx, ownerId, fieldId, 'value-a', text)},
])('invalid $name', ({run, existing}) => {
  it.each(['::((definition))', '\ud800'])('refuses %j without partial writes', async text => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 5}},
      ...(existing ? [field(), value('value-a', '5')] : []))
    await expectCommittedRefusal(repo, tx => run(tx, text), 'invalid-text')
  })
})

describe('reference property editing', () => {
  it.each([
    {schema: refProperty, encoded: '\ud800'},
    {schema: refListProperty, encoded: ['\ud800']},
  ])('refuses to materialize an unpaired surrogate stored in $schema.name', async ({schema, encoded}) => {
    const repo = await setup(schema)
    const id = '\ud800'
    await seed({id: ownerId, properties: {[schema.name]: encoded}, references: [{id, alias: id, sourceField: schema.name}]})
    await expectCommittedRefusal(repo, tx => openPropertyValue(tx, ownerId, fieldId), 'would-change-stored-value')
  })

  it.each([refProperty, refListProperty])('refuses a pasted reference to an unpaired surrogate in $name', async schema => {
    const repo = await setup(schema)
    await seed({id: ownerId})
    await expectCommittedRefusal(repo, tx => writePropertyText(tx, ownerId, fieldId, '((\ud800))'), 'invalid-text')
  })

  it('cleans up only the opened reference-list draft on repeated opens and closes', async () => {
    const repo = await setup(refListProperty)
    const original = [value('value-a', '((first))'), value('value-b', '((second))')]
    await seed({
      id: ownerId,
      properties: {[refListProperty.name]: ['first', 'second']},
      references: ['first', 'second'].map(id => ({id, alias: id, sourceField: refListProperty.name})),
    }, field(), ...original, value('note', 'keep', 'value-b'))

    for (let i = 0; i < 2; i += 1) {
      const draft = await repo.tx(tx => openPropertyValue(tx, ownerId, fieldId), options)
      expect(await children('field-a')).toEqual([
        {id: 'value-a', content: '((first))'}, {id: 'value-b', content: '((second))'}, {id: draft.valueId, content: ''},
      ])
      await repo.tx(tx => finishPropertyValueEdit(tx, ownerId, fieldId, draft, ''), options)
      expect(await children('field-a')).toEqual([{id: 'value-a', content: '((first))'}, {id: 'value-b', content: '((second))'}])
      expect(await children('value-b')).toEqual([{id: 'note', content: 'keep'}])
      expect(await projection()).toEqual({[refListProperty.name]: ['first', 'second']})
    }
  })
})

describe('projection and workspace boundaries', () => {
  it('keeps stored keys when a bare projection event names a property', async () => {
    const repo = await setup(textProperty, 'cell')
    await seed({id: ownerId, properties: {[textProperty.name]: 'pending'}})
    const before = await snapshot()

    await repo.tx(async tx => {
      tx.emitEvent('core.reprojectPropertyCell', {ownerId, fieldId}, workspaceId)
    }, options)

    expect(await snapshot()).toEqual(before)
  })

  describe.each(Object.entries(operations))('%s with inconsistent synced rows', (_operation, run) => {
    it.each([
      {state: 'a foreign field', fieldWorkspace: 'other', valueWorkspace: workspaceId},
      {state: 'a foreign value', fieldWorkspace: workspaceId, valueWorkspace: 'other'},
    ])('refuses $state even when the caller catches the error', async ({fieldWorkspace, valueWorkspace}) => {
      const repo = await setup()
      await seed({id: ownerId, properties: {[textProperty.name]: 'saved'}},
        {...field(), workspace: fieldWorkspace}, {...value('value-a', 'saved'), workspace: valueWorkspace})
      await expectCommittedRefusal(repo, tx => run(tx, ownerId, fieldId), 'resolve-in-outline')
    })
  })
})

describe('opening and finishing an edit against existing rows', () => {
  it('opens an existing scalar without reconciling a different stored value over its row', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 2}}, field(), value('value-a', '5'))
    const before = await snapshot()
    await expect(repo.tx(tx => openPropertyValue(tx, ownerId, fieldId), options)).resolves.toMatchObject({valueId: 'value-a', created: false})
    expect(await snapshot()).toEqual(before)
  })

  it.each([
    {schema: refListProperty, stored: [], rows: [field()]},
    {schema: refListProperty, stored: [], rows: []},
    {schema: textProperty, stored: '', rows: [field(), value('value-a', '')]},
    {schema: textProperty, stored: '', rows: []},
  ])('preserves explicit empty $schema.name through open and finish', async ({schema, stored, rows}) => {
    const repo = await setup(schema)
    await seed({id: ownerId, properties: {[schema.name]: stored, other: 'keep'}}, ...rows)
    const edit = await repo.tx(tx => openPropertyValue(tx, ownerId, fieldId), options)
    await repo.tx(tx => finishPropertyValueEdit(tx, ownerId, fieldId, edit, ''), options)

    expect(await projection()).toEqual({[schema.name]: stored, other: 'keep'})
    const [fieldRow] = await children(ownerId)
    expect(fieldRow!.id).toEqual(rows.length ? 'field-a' : expect.any(String))
    expect(await children(fieldRow!.id)).toEqual(schema === refListProperty ? [] : [{id: edit.valueId, content: ''}])
  })

  it('opens an explicitly empty reference list without adding a projected member', async () => {
    const repo = await setup(refListProperty)
    await seed({id: ownerId, properties: {[refListProperty.name]: []}})
    const {valueId: id} = await repo.tx(tx => openPropertyValue(tx, ownerId, fieldId), options)
    expect(await children((await children(ownerId))[0]!.id)).toEqual([{id, content: ''}])
    expect(await projection()).toEqual({[refListProperty.name]: []})
  })

  it('reuses a trailing reference-list draft before edit end', async () => {
    const repo = await setup(refListProperty)
    await seed({id: ownerId, properties: {[refListProperty.name]: []}}, field(), value('value-a', ''))
    const before = await snapshot()
    await expect(repo.tx(tx => openPropertyValue(tx, ownerId, fieldId), options)).resolves.toMatchObject({valueId: 'value-a', created: false})
    expect(await snapshot()).toEqual(before)
  })

  it.each([
    {name: 'a stored empty member', schema: textListProperty, content: 'first', stored: ['first', ''], extra: []},
    {name: 'a draft with a note', schema: refListProperty, content: 'invalid', stored: [], extra: [value('note', 'keep', 'value-b')]},
  ])('keeps $name when ending a list edit', async ({schema, content, stored, extra}) => {
    const repo = await setup(schema)
    await seed({id: ownerId, properties: {[schema.name]: stored}}, field(),
      value('value-a', content), value('value-b', ''), ...extra)
    const before = await snapshot()
    await repo.tx(tx => finishPropertyValueEdit(tx, ownerId, fieldId, 'value-b', ''), options)
    expect(await snapshot()).toEqual(before)
  })
})
