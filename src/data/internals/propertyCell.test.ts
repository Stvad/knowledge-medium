// @vitest-environment node

import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {ChangeScope, codecs, defineProperty, type AnyPropertySchema, type Tx} from '@/data/api'
import {projectedPropertyDefinitionsFacet} from '@/data/facets'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {clearCell, finishCellEdit, openCell, writeCellText} from './propertyCell'

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
const uiProperty = defineProperty('test:cell-ui', {
  codec: codecs.string, defaultValue: '', changeScope: ChangeScope.UiState,
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

describe('openCell', () => {
  it.each([
    {prior: 'absent', rows: [], stored: undefined, created: true},
    {prior: 'stored only', rows: [], stored: 'old', created: false},
    {prior: 'an existing value', rows: [field(), value('value-a', 'old')], stored: 'old', created: false},
  ])('commits the first character while opening $prior', async ({rows, stored, created}) => {
    const repo = await setup()
    await seed({id: ownerId, properties: stored === undefined ? {} : {[textProperty.name]: stored}}, ...rows)

    const edit = await repo.tx(tx => openCell(tx, ownerId, fieldId, {initialText: 'h'}), options)
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

    const {valueId} = await repo.tx(tx => openCell(tx, ownerId, fieldId), options)

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

    const {valueId} = await repo.tx(tx => openCell(tx, ownerId, fieldId), options)

    const fields = await children(ownerId)
    expect(fields).toEqual([{id: hasField ? 'field-a' : expect.any(String), content: '::((definition))'}])
    expect(await children(fields[0]!.id)).toEqual([{id: valueId, content: text}])
    expect(await projection()).toEqual({[schema.name]: encoded})
  })

  it.each([false, true])('rolls back opening an unrepresentable stored reference (existing field: %s)', async hasField => {
    const repo = await setup(refProperty)
    const encoded = 'an invalid id'
    await seed({id: ownerId, properties: {[refProperty.name]: encoded}, references: [
      {id: encoded, alias: encoded, sourceField: refProperty.name},
    ]}, ...(hasField ? [field()] : []))
    const before = await snapshot()

    await expect(repo.tx(tx => openCell(tx, ownerId, fieldId), options)).rejects.toThrow()
    expect(await snapshot()).toEqual(before)
  })

  it('refuses to materialize a stored empty reference as an unset projection', async () => {
    const repo = await setup(refProperty)
    await seed({id: ownerId, properties: {[refProperty.name]: ''}})
    const before = await snapshot()

    await repo.tx(async tx => {
      await expect(openCell(tx, ownerId, fieldId)).rejects.toThrow()
    }, options)
    expect(await snapshot()).toEqual(before)
  })

  it('refuses to fold duplicate fields when that would replace the stored projection', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 9}}, field(), field('field-b'),
      value('value-a', '5'), value('value-b', '9', 'field-b'))
    const before = await snapshot()

    await repo.tx(async tx => {
      await expect(openCell(tx, ownerId, fieldId)).rejects.toThrow()
    }, options)
    expect(await snapshot()).toEqual(before)
  })

  it.each([
    {values: [value('value-a', ' 5 ')], encoded: 5, expected: 'value-a'},
    {values: [value('value-a', 'unreadable')], encoded: undefined, expected: 'value-a'},
    {values: [value('value-a', 'unreadable'), value('value-b', ' 5 '), value('value-c', '7')], encoded: 5, expected: 'value-b'},
  ])('returns $expected in projection order without rewriting stored rows', async ({values, encoded, expected}) => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: encoded === undefined ? {} : {[numberProperty.name]: encoded}}, field(), ...values)
    const before = await snapshot()

    await expect(repo.tx(tx => openCell(tx, ownerId, fieldId), options)).resolves.toMatchObject({valueId: expected, created: false})
    expect(await snapshot()).toEqual(before)
  })

  it('opens a fresh row when no unreadable peer can be selected', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId}, field(), value('value-a', 'incomplete'), value('value-b', 'invalid'))

    const {valueId} = await repo.tx(tx => openCell(tx, ownerId, fieldId), options)

    expect(await children('field-a')).toEqual(expect.arrayContaining([
      {id: 'value-a', content: 'incomplete'}, {id: 'value-b', content: 'invalid'}, {id: valueId, content: ''},
    ]))
    expect(await projection()).toEqual({})
  })

  it('folds duplicate fields while preserving divergent values and nested notes', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 5}}, field(), field('field-b'),
      value('value-a', '5'), value('value-b', '9', 'field-b'), value('note', 'keep', 'value-b'))

    await expect(repo.tx(tx => openCell(tx, ownerId, fieldId), options)).resolves.toMatchObject({valueId: 'value-a', created: false})

    expect(await children(ownerId)).toEqual([{id: 'field-a', content: '::((definition))'}])
    expect(await children('field-a')).toEqual([{id: 'value-a', content: '5'}, {id: 'value-b', content: '9'}])
    expect(await children('value-b')).toEqual([{id: 'note', content: 'keep'}])
    expect(await projection()).toEqual({[numberProperty.name]: 5})
  })
})

describe('writeCellText', () => {
  it.each([
    ['absent', undefined, false],
    ['projection only', 7, false],
    ['empty field', undefined, true],
    ['empty field with projection', 7, true],
  ] as const)('writes a valid scalar to a cell with %s', async (_state, encoded, hasField) => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: encoded === undefined ? {} : {[numberProperty.name]: encoded}},
      ...(hasField ? [field()] : []))

    await repo.tx(tx => writeCellText(tx, ownerId, fieldId, '4'), options)

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

    await repo.tx(tx => writeCellText(tx, ownerId, fieldId, text), options)

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
    const before = await snapshot()

    await expect(repo.tx(tx => writeCellText(tx, ownerId, fieldId, '9'), options)).rejects.toThrow()
    expect(await snapshot()).toEqual(before)
  })

  it('uses the only unreadable row for valid text', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId}, field(), value('value-a', 'unfinished'))

    await repo.tx(tx => writeCellText(tx, ownerId, fieldId, '6'), options)

    expect(await children('field-a')).toEqual([{id: 'value-a', content: '6'}])
    expect(await projection()).toEqual({[numberProperty.name]: 6})
  })

  it('keeps multiple unreadable peers when there is no identifiable target', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId}, field(), value('value-a', 'incomplete'), value('value-b', 'invalid'))

    await repo.tx(tx => writeCellText(tx, ownerId, fieldId, '6'), options)

    expect(await children('field-a')).toEqual(expect.arrayContaining([
      {id: 'value-a', content: 'incomplete'}, {id: 'value-b', content: 'invalid'}, {id: expect.any(String), content: '6'},
    ]))
    expect(await projection()).toEqual({[numberProperty.name]: 6})
  })

  it('keeps invalid pasted text with the stale projection removed', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 7}})

    await repo.tx(tx => writeCellText(tx, ownerId, fieldId, 'unfinished'), options)

    const [fieldRow] = await children(ownerId)
    expect(await children(fieldRow!.id)).toEqual([{id: expect.any(String), content: 'unfinished'}])
    expect(await projection()).toEqual({})
  })

  it('refuses invalid pasted text that would turn a value row into a field', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 5}}, field(), value('value-a', '5'))
    const before = await snapshot()

    await expect(repo.tx(tx => writeCellText(tx, ownerId, fieldId, '::((definition))'), options)).rejects.toThrow()
    expect(await snapshot()).toEqual(before)
  })

  it('refuses an invalid draft with an unpaired surrogate before the content column replaces it', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 5}}, field(), value('value-a', '5'))
    const before = await snapshot()

    await expect(repo.tx(tx => writeCellText(tx, ownerId, fieldId, '\ud800'), options)).rejects.toThrow()
    expect(await snapshot()).toEqual(before)
  })

  it('clears on empty text', async () => {
    const repo = await setup()
    await seed({id: ownerId, properties: {[textProperty.name]: 'saved'}}, field(), value('value-a', 'saved'))

    await repo.tx(tx => writeCellText(tx, ownerId, fieldId, ''), options)

    expect(await children(ownerId)).toEqual([])
    expect(await projection()).toEqual({})
  })
})

describe('clearCell', () => {
  it.each([
    ['absent', undefined, false],
    ['projection only', 'pending', false],
    ['empty field', undefined, true],
    ['empty field with projection', 'pending', true],
  ] as const)('clears a cell with %s and retains other keys', async (_state, encoded, hasField) => {
    const repo = await setup()
    await seed({id: ownerId, properties: {other: 'keep', ...(encoded === undefined ? {} : {[textProperty.name]: encoded})}},
      ...(hasField ? [field()] : []))

    await repo.tx(tx => clearCell(tx, ownerId, fieldId), options)

    expect(await children(ownerId)).toEqual([])
    expect(await projection()).toEqual({other: 'keep'})
  })

  it('clears childless values in every field, including unreadable and divergent ones', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 5}}, field(), field('field-b'),
      value('value-a', '5'), value('value-b', 'unreadable'), value('value-c', '9', 'field-b'))

    await repo.tx(tx => clearCell(tx, ownerId, fieldId), options)

    expect(await children(ownerId)).toEqual([])
    expect(await children('field-a')).toEqual([])
    expect(await children('field-b')).toEqual([])
    expect(await projection()).toEqual({})
  })

  it('clears only the value text when it has a nested note and keeps a field with nested machinery', async () => {
    const repo = await setup()
    await seed({id: ownerId, properties: {[textProperty.name]: 'first'}}, field(), field('field-b'),
      value('value-a', 'first'), value('note', 'keep this note', 'value-a'), value('value-b', 'second', 'field-b'),
      field('nested-field', 'field-b'), value('nested-value', 'keep this property', 'nested-field'))

    await repo.tx(tx => clearCell(tx, ownerId, fieldId), options)

    expect(await children(ownerId)).toEqual([
      {id: 'field-a', content: '::((definition))'}, {id: 'field-b', content: '::((definition))'},
    ])
    expect(await children('field-a')).toEqual([{id: 'value-a', content: ''}])
    expect(await children('field-b')).toEqual([{id: 'nested-field', content: '::((definition))'}])
    expect(await children('value-a')).toEqual([{id: 'note', content: 'keep this note'}])
    expect(await children('nested-field')).toEqual([{id: 'nested-value', content: 'keep this property'}])
    expect(await projection()).toEqual({[textProperty.name]: ''})
  })

  it('clears an empty field projection without deleting its nested field row', async () => {
    const repo = await setup()
    await seed({id: ownerId, properties: {[textProperty.name]: 'pending'}}, field(), field('nested-field', 'field-a'))

    await repo.tx(tx => clearCell(tx, ownerId, fieldId), options)

    expect(await children(ownerId)).toEqual([{id: 'field-a', content: '::((definition))'}])
    expect(await children('field-a')).toEqual([{id: 'nested-field', content: '::((definition))'}])
    expect(await projection()).toEqual({})
  })

  it('retains a value and a field carrying properties without descendant rows', async () => {
    const repo = await setup()
    const properties = {annotation: 'keep'}
    await seed({id: ownerId, properties: {[textProperty.name]: 'before'}}, field(),
      {...field('field-b'), properties}, {...value('value-a', 'before'), properties})

    await repo.tx(tx => clearCell(tx, ownerId, fieldId), options)

    expect(await children(ownerId)).toEqual([
      {id: 'field-a', content: '::((definition))'}, {id: 'field-b', content: '::((definition))'},
    ])
    expect(await children('field-a')).toEqual([{id: 'value-a', content: ''}])
    expect(await projection('value-a')).toEqual(properties)
    expect(await projection('field-b')).toEqual(properties)
    expect(await projection()).toEqual({[textProperty.name]: ''})
  })

  it('keeps final text live through edit end and a late editor flush', async () => {
    const repo = await setup()
    await seed({id: ownerId})
    const draft = await repo.tx(tx => openCell(tx, ownerId, fieldId), options)
    await repo.tx(tx => finishCellEdit(tx, ownerId, fieldId, draft, 'hello'), options)
    expect(await projection()).toEqual({[textProperty.name]: 'hello'})
    await repo.tx(tx => tx.update(draft.valueId, {content: 'hello'}), options)

    expect(await db.db.get('SELECT deleted, content FROM blocks WHERE id = ?', [draft.valueId]))
      .toEqual({deleted: 0, content: 'hello'})
    expect(await projection()).toEqual({[textProperty.name]: 'hello'})
  })

  it.each([true, false])('removes exactly the blank row that finished editing (projected: %s)', async projected => {
    const repo = await setup()
    await seed({id: ownerId, properties: projected ? {[textProperty.name]: ''} : {}}, field(), value('value-a', ''))

    await repo.tx(tx => finishCellEdit(tx, ownerId, fieldId, {valueId: 'value-a', created: true, draftFieldId: 'field-a'}, ''), options)

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

    await repo.tx(tx => finishCellEdit(tx, ownerId, fieldId, {valueId: 'value-a', created: true, draftFieldId: 'field-a'}, content), options)

    expect(await snapshot()).toEqual(before)
  })

  it('keeps a stale stored value when cleaning up the associated blank editor row', async () => {
    const repo = await setup()
    await seed({id: ownerId, properties: {[textProperty.name]: 'pending'}}, field(), value('value-a', ''))
    const before = await snapshot()

    await repo.tx(tx => finishCellEdit(tx, ownerId, fieldId, {valueId: 'value-a', created: true, draftFieldId: 'field-a'}, ''), options)

    expect(await snapshot()).toEqual(before)
  })

  it('keeps a pending key when the edited row is already gone', async () => {
    const repo = await setup()
    await seed({id: ownerId, properties: {[textProperty.name]: 'pending'}})
    const before = await snapshot()

    await repo.tx(tx => finishCellEdit(tx, ownerId, fieldId, {valueId: 'value-a', created: true, draftFieldId: 'field-a'}, ''), options)

    expect(await snapshot()).toEqual(before)
  })
})

const operations = {
  open: openCell,
  write: (tx: Tx, owner: string, field: string) => writeCellText(tx, owner, field, 'new text'),
  clear: clearCell,
}

describe.each(Object.entries(operations))('%s cell eligibility', (_operation, run) => {
  it.each([
    {state: 'missing owner', owner: 'missing', error: 'The cell owner is missing or deleted.'},
    {state: 'deleted owner', deleted: true, error: 'The cell owner is missing or deleted.'},
    {state: 'pre-flip workspace', mode: 'cell', error: 'Cells require child-backed properties.'},
    {state: 'unknown definition', definition: 'unknown', error: 'The column definition is unavailable.'},
    {state: 'non-block-scoped definition', schema: uiProperty, error: 'Cells require a block-scoped property and transaction.'},
    {state: 'wrong transaction scope', scope: ChangeScope.UiState, error: 'Cells require a block-scoped property and transaction.'},
  ])('refuses a $state before touching any rows', async ({
    owner = ownerId, deleted = false, mode = 'children', definition = fieldId, schema = textProperty,
    scope = ChangeScope.BlockDefault, error,
  }) => {
    const repo = await setup(schema, mode)
    await seed({id: ownerId, deleted, properties: {[schema.name]: 'old text'}}, field(), value('value-a', 'old text'))
    const before = await snapshot()

    await expect(repo.tx(async tx => { await run(tx, owner, definition) }, {scope})).rejects.toThrow(error)
    expect(await snapshot()).toEqual(before)
  })
})

describe.each([
  ['open', operations.open],
  ['write', operations.write],
] as const)('%s cell with duplicate field metadata', (_operation, run) => {
  it.each([
    {state: 'properties', properties: {annotation: 'keep'}, nested: []},
    {state: 'a nested field', properties: {}, nested: [field('nested-field', 'field-b')]},
  ])('refuses to fold a duplicate field carrying $state', async ({properties, nested}) => {
    const repo = await setup()
    await seed({id: ownerId, properties: {[textProperty.name]: 'same'}}, field(),
      {...field('field-b'), properties}, value('value-a', 'same'), ...nested)
    const before = await snapshot()

    await repo.tx(async tx => {
      await expect(run(tx, ownerId, fieldId)).rejects.toThrow()
    }, options)
    expect(await snapshot()).toEqual(before)
  })
})

describe('list cells', () => {
  it('opens the last text member without appending an empty string to the list', async () => {
    const repo = await setup(textListProperty)
    await seed({id: ownerId, properties: {[textListProperty.name]: ['first', 'last']}}, field(),
      value('value-a', 'first'), value('value-b', 'last'))
    const before = await snapshot()

    await expect(repo.tx(tx => openCell(tx, ownerId, fieldId), options)).resolves.toMatchObject({valueId: 'value-b', created: false})
    expect(await snapshot()).toEqual(before)
  })

  it.each([false, true])('materializes stored text members in order, including repeats (field: %s)', async hasField => {
    const repo = await setup(textListProperty)
    const members = ['second', 'first', 'second']
    await seed({id: ownerId, properties: {[textListProperty.name]: members}}, ...(hasField ? [field()] : []))

    const {valueId} = await repo.tx(tx => openCell(tx, ownerId, fieldId), options)

    const [fieldRow] = await children(ownerId)
    const values = await children(fieldRow!.id)
    expect(values.map(row => row.content)).toEqual(members)
    expect(values.at(-1)?.id).toBe(valueId)
    expect(await projection()).toEqual({[textListProperty.name]: members})
  })

  it('refuses to add a text member to a stored empty list just by opening it', async () => {
    const repo = await setup(textListProperty)
    await seed({id: ownerId, properties: {[textListProperty.name]: []}})
    const before = await snapshot()

    await repo.tx(async tx => {
      await expect(openCell(tx, ownerId, fieldId)).rejects.toThrow()
    }, options)
    expect(await snapshot()).toEqual(before)
  })

  it.each([false, true])('opens a new reference-list member for a blank cell (field: %s)', async hasField => {
    const repo = await setup(refListProperty)
    await seed({id: ownerId}, ...(hasField ? [field()] : []))

    const {valueId} = await repo.tx(tx => openCell(tx, ownerId, fieldId), options)

    const [fieldRow] = await children(ownerId)
    expect(await children(fieldRow!.id)).toEqual([{id: valueId, content: ''}])
    expect(await projection()).toEqual({[refListProperty.name]: []})
  })

  it('folds duplicate reference-list fields without coalescing repeated members', async () => {
    const repo = await setup(refListProperty)
    await seed({id: ownerId, properties: {[refListProperty.name]: ['target', 'target']}}, field(), field('field-b'),
      value('value-a', '((target))'), value('value-b', '((target))', 'field-b'))

    const {valueId} = await repo.tx(tx => openCell(tx, ownerId, fieldId), options)

    expect(await children(ownerId)).toEqual([{id: 'field-a', content: '::((definition))'}])
    expect(await children('field-a')).toEqual([
      {id: 'value-a', content: '((target))'}, {id: 'value-b', content: '((target))'}, {id: valueId, content: ''},
    ])
    expect(await projection()).toEqual({[refListProperty.name]: ['target', 'target']})
  })

  it('opens a blank reference-list member without projecting it', async () => {
    const repo = await setup(refListProperty)
    await seed({id: ownerId, properties: {[refListProperty.name]: ['target']}}, field(), value('value-a', '((target))'))

    const {valueId} = await repo.tx(tx => openCell(tx, ownerId, fieldId), options)

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

    await repo.tx(tx => writeCellText(tx, ownerId, fieldId, 'first\nsecond\nfirst'), options)

    const fields = await children(ownerId)
    expect(fields).toEqual([{id: rows.length ? 'field-a' : expect.any(String), content: '::((definition))'}])
    expect((await children(fields[0]!.id)).map(row => row.content)).toEqual(['first', 'second', 'first'])
    expect(await projection()).toEqual({[textListProperty.name]: ['first', 'second', 'first']})
  })

  it('rolls back a whole reference list paste when one member is invalid', async () => {
    const repo = await setup(refListProperty)
    await seed({id: ownerId, properties: {[refListProperty.name]: ['target']},
      references: [{id: 'target', alias: 'target', sourceField: refListProperty.name}]},
    field(), value('value-a', '((target))'))
    const before = await snapshot()

    await expect(repo.tx(tx => writeCellText(tx, ownerId, fieldId, '((replacement))\nunfinished'), options))
      .rejects.toThrow()
    expect(await snapshot()).toEqual(before)
  })

  it('refuses a replacement that would remove an annotated list member', async () => {
    const repo = await setup(textListProperty)
    await seed({id: ownerId, properties: {[textListProperty.name]: ['first', 'second']}}, field(),
      value('value-a', 'first'), value('value-b', 'second'), value('note', 'keep', 'value-b'))
    const before = await snapshot()

    await expect(repo.tx(tx => writeCellText(tx, ownerId, fieldId, 'first'), options)).rejects.toThrow()
    expect(await snapshot()).toEqual(before)
  })

  it.each([
    {state: 'properties', properties: {annotation: 'keep'}, notes: []},
    {state: 'a nested note', properties: {}, notes: [value('note', 'keep', 'value-b')]},
  ])('refuses to shorten a repeated list member carrying $state', async ({properties, notes}) => {
    const repo = await setup(textListProperty)
    await seed({id: ownerId, properties: {[textListProperty.name]: ['same', 'same']}}, field(),
      value('value-a', 'same'), {...value('value-b', 'same'), properties}, ...notes)
    const before = await snapshot()

    await expect(repo.tx(tx => writeCellText(tx, ownerId, fieldId, 'same'), options)).rejects.toThrow()
    expect(await snapshot()).toEqual(before)
  })

  it.each([
    {state: 'no rows or projection', rows: []},
    {state: 'projection only', stored: ['old'], rows: []},
    {state: 'empty field', rows: [field()]},
    {state: 'duplicate fields', stored: ['old'], rows: [field(), field('field-b'), value('value-a', 'old', 'field-b')]},
  ])('clears a list with $state', async ({stored, rows}) => {
    const repo = await setup(textListProperty)
    await seed({id: ownerId, properties: stored ? {[textListProperty.name]: stored} : {}}, ...rows)

    await repo.tx(tx => clearCell(tx, ownerId, fieldId), options)

    expect(await children(ownerId)).toEqual([])
    expect(await projection()).toEqual({})
  })

  it('clears the list and preserves the annotated member as a blank value row', async () => {
    const repo = await setup(refListProperty)
    await seed({id: ownerId, properties: {[refListProperty.name]: ['first', 'second']}}, field(),
      value('value-a', '((first))'), value('value-b', '((second))'), value('note', 'keep', 'value-b'))

    await repo.tx(tx => clearCell(tx, ownerId, fieldId), options)

    expect(await children(ownerId)).toEqual([{id: 'field-a', content: '::((definition))'}])
    expect(await children('field-a')).toEqual([{id: 'value-b', content: ''}])
    expect(await children('value-b')).toEqual([{id: 'note', content: 'keep'}])
    expect(await projection()).toEqual({[refListProperty.name]: []})
  })
})

describe('range cell writes', () => {
  it('undoes changes to both cells in one step', async () => {
    const repo = await setup()
    await seed({id: ownerId, properties: {[textProperty.name]: 'before'}}, field(), value('value-a', 'before'),
      {id: 'other-owner', properties: {[textProperty.name]: 'clear me'}}, field('field-b', 'other-owner'),
      value('value-b', 'clear me', 'field-b'))

    await repo.tx(async tx => {
      await writeCellText(tx, ownerId, fieldId, 'after')
      await clearCell(tx, 'other-owner', fieldId)
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

  it('rolls back the first cell when the second refuses the paste', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 5}}, field(), value('value-a', '5'),
      {id: 'other-owner', properties: {[numberProperty.name]: 9}}, field('field-b', 'other-owner'),
      value('value-b', '9', 'field-b'))
    const before = await snapshot()

    await expect(repo.tx(async tx => {
      await writeCellText(tx, ownerId, fieldId, '6')
      await writeCellText(tx, 'other-owner', fieldId, '::((definition))')
    }, options)).rejects.toThrow()

    expect(await snapshot()).toEqual(before)
  })
})

describe('cell write boundaries', () => {
  it('refuses navigation in a transaction pinned to a different workspace', async () => {
    const repo = await setup()
    await seed({id: ownerId}, field(), value('value-a', 'saved'))
    await repo.tx(async tx => {
      await tx.create({workspaceId: 'other', parentId: null, content: 'other', orderKey: 'a0'})
      expect(tx.meta.workspaceId).toBe('other')
      await expect(openCell(tx, ownerId, fieldId)).rejects.toMatchObject({name: 'WorkspaceMismatchError'})
    }, {...options, allowUnloadedWorkspace: true})
  })

  it('refuses a new blank among unreadable scalar peers with a stale stored value', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 2}}, field(), value('value-a', 'one'), value('value-b', 'two'))
    const before = await snapshot()
    await repo.tx(async tx => {
      await expect(openCell(tx, ownerId, fieldId)).rejects.toThrow('would change its stored value')
    }, options)
    expect(await snapshot()).toEqual(before)
  })

  it('reprojects unchanged unreadable text when the bag has a late value', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 2}}, field(), value('value-a', 'unfinished'))
    await repo.tx(tx => writeCellText(tx, ownerId, fieldId, 'unfinished'), options)
    expect(await children('field-a')).toEqual([{id: 'value-a', content: 'unfinished'}])
    expect(await projection()).toEqual({})
  })

  it('retains an annotated primary when its scalar is pasted again', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 3}}, field(), value('value-a', '3'), value('note', 'keep', 'value-a'))
    await repo.tx(tx => writeCellText(tx, ownerId, fieldId, '3'), options)
    expect(await children('value-a')).toEqual([{id: 'note', content: 'keep'}])
    expect(await projection()).toEqual({[numberProperty.name]: 3})
  })

  it('keeps an annotated divergent peer when replacing the scalar', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 3}}, field(), value('value-a', '3'),
      value('value-b', '7'), value('note', 'keep', 'value-b'))
    await repo.tx(tx => writeCellText(tx, ownerId, fieldId, '4'), options)
    expect(await children('value-b')).toEqual([{id: 'note', content: 'keep'}])
    expect(await projection()).toEqual({[numberProperty.name]: 4})
  })

  it('folds an unannotated scalar peer that already holds the pasted value', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 3}}, field(), value('value-a', '3'), value('value-b', '7'))
    await repo.tx(tx => writeCellText(tx, ownerId, fieldId, '7'), options)
    expect(await children('field-a')).toEqual([{id: 'value-a', content: '7'}])
  })

  it('preserves an unreadable list member and its notes while replacing valid members', async () => {
    const repo = await setup(refListProperty)
    await seed({id: ownerId}, field(), value('value-a', 'invalid'), value('note', 'keep', 'value-a'))
    await repo.tx(tx => writeCellText(tx, ownerId, fieldId, '((target))'), options)
    expect(await children('field-a')).toEqual(expect.arrayContaining([{id: 'value-a', content: 'invalid'}]))
    expect(await children('value-a')).toEqual([{id: 'note', content: 'keep'}])
    expect(await projection()).toEqual({[refListProperty.name]: ['target']})
  })
})

describe('several edits to the same cell in one transaction', () => {
  it.each([undefined, 5])('keeps the invalid draft after writing a valid scalar (prior: %s)', async prior => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: prior === undefined ? {} : {[numberProperty.name]: prior}},
      ...(prior === undefined ? [] : [field(), value('value-a', String(prior))]))

    await repo.tx(async tx => {
      await writeCellText(tx, ownerId, fieldId, '6')
      await writeCellText(tx, ownerId, fieldId, 'unfinished')
    }, options)

    const [fieldRow] = await children(ownerId)
    expect(await children(fieldRow!.id)).toEqual([{id: prior === undefined ? expect.any(String) : 'value-a', content: 'unfinished'}])
    expect(await projection()).toEqual({})
  })

  it.each([false, true])('honors a clear after writing a valid scalar (with note: %s)', async withNote => {
    const repo = await setup()
    await seed({id: ownerId, properties: {[textProperty.name]: 'before'}}, field(), value('value-a', 'before'),
      ...(withNote ? [value('note', 'keep', 'value-a')] : []))

    await repo.tx(async tx => {
      await writeCellText(tx, ownerId, fieldId, 'after')
      await clearCell(tx, ownerId, fieldId)
    }, options)

    expect(await children(ownerId)).toEqual(withNote ? [{id: 'field-a', content: '::((definition))'}] : [])
    expect(await children('field-a')).toEqual(withNote ? [{id: 'value-a', content: ''}] : [])
    expect(await children('value-a')).toEqual(withNote ? [{id: 'note', content: 'keep'}] : [])
    expect(await projection()).toEqual(withNote ? {[textProperty.name]: ''} : {})
  })

  it('opens a blank row after clearing a pending key without rematerializing the cleared value', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 5}})

    const {valueId} = await repo.tx(async tx => {
      await clearCell(tx, ownerId, fieldId)
      return openCell(tx, ownerId, fieldId)
    }, options)

    const [fieldRow] = await children(ownerId)
    expect(await children(fieldRow!.id)).toEqual([{id: valueId, content: ''}])
    expect(await projection()).toEqual({})
  })

  it('projects the valid edit after an invalid edit to the same row', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 5}}, field(), value('value-a', '5'))

    await repo.tx(async tx => {
      await writeCellText(tx, ownerId, fieldId, 'unfinished')
      await writeCellText(tx, ownerId, fieldId, '6')
    }, options)

    expect(await children('field-a')).toEqual([{id: 'value-a', content: '6'}])
    expect(await projection()).toEqual({[numberProperty.name]: 6})
  })
})

describe('reference cell editing', () => {
  it.each([
    {schema: refProperty, encoded: '\ud800'},
    {schema: refListProperty, encoded: ['\ud800']},
  ])('refuses to materialize an unpaired surrogate stored in $schema.name', async ({schema, encoded}) => {
    const repo = await setup(schema)
    const id = '\ud800'
    await seed({id: ownerId, properties: {[schema.name]: encoded}, references: [{id, alias: id, sourceField: schema.name}]})
    const before = await snapshot()

    await repo.tx(async tx => {
      await expect(openCell(tx, ownerId, fieldId)).rejects.toThrow()
    }, options)
    expect(await snapshot()).toEqual(before)
  })

  it.each([refProperty, refListProperty])('refuses a pasted reference to an unpaired surrogate in $name', async schema => {
    const repo = await setup(schema)
    await seed({id: ownerId})
    const before = await snapshot()

    await repo.tx(async tx => {
      await expect(writeCellText(tx, ownerId, fieldId, '((\ud800))')).rejects.toThrow()
    }, options)
    expect(await snapshot()).toEqual(before)
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
      const draft = await repo.tx(tx => openCell(tx, ownerId, fieldId), options)
      expect(await children('field-a')).toEqual([
        {id: 'value-a', content: '((first))'}, {id: 'value-b', content: '((second))'}, {id: draft.valueId, content: ''},
      ])
      await repo.tx(tx => finishCellEdit(tx, ownerId, fieldId, draft, ''), options)
      expect(await children('field-a')).toEqual([{id: 'value-a', content: '((first))'}, {id: 'value-b', content: '((second))'}])
      expect(await children('value-b')).toEqual([{id: 'note', content: 'keep'}])
      expect(await projection()).toEqual({[refListProperty.name]: ['first', 'second']})
    }
  })
})

describe('cell projection and workspace boundaries', () => {
  it('keeps stored keys in a cell workspace even when an extension requests projection', async () => {
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
      const before = await snapshot()

      await repo.tx(async tx => {
        await expect(run(tx, ownerId, fieldId)).rejects.toThrow(/workspace/i)
      }, options)

      expect(await snapshot()).toEqual(before)
    })
  })
})

describe('opening and finishing an edit against existing rows', () => {
  it('opens an existing scalar without reconciling a different stored value over its row', async () => {
    const repo = await setup(numberProperty)
    await seed({id: ownerId, properties: {[numberProperty.name]: 2}}, field(), value('value-a', '5'))
    const before = await snapshot()
    await expect(repo.tx(tx => openCell(tx, ownerId, fieldId), options)).resolves.toMatchObject({valueId: 'value-a', created: false})
    expect(await snapshot()).toEqual(before)
  })

  it('opens an explicitly empty reference list without adding a projected member', async () => {
    const repo = await setup(refListProperty)
    await seed({id: ownerId, properties: {[refListProperty.name]: []}})
    const {valueId: id} = await repo.tx(tx => openCell(tx, ownerId, fieldId), options)
    expect(await children((await children(ownerId))[0]!.id)).toEqual([{id, content: ''}])
    expect(await projection()).toEqual({[refListProperty.name]: []})
  })

  it('reuses a trailing reference-list draft before edit end', async () => {
    const repo = await setup(refListProperty)
    await seed({id: ownerId, properties: {[refListProperty.name]: []}}, field(), value('value-a', ''))
    const before = await snapshot()
    await expect(repo.tx(tx => openCell(tx, ownerId, fieldId), options)).resolves.toMatchObject({valueId: 'value-a', created: false})
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
    await repo.tx(tx => finishCellEdit(tx, ownerId, fieldId, 'value-b', ''), options)
    expect(await snapshot()).toEqual(before)
  })
})
