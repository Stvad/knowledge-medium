import {ChangeScope, memberCodecOf, type AnyPropertySchema, type BlockData, type Tx} from '@/data/api'
import {
  childContentsToEncodedPropertyValue, encodedPropertyValueToChildContents, fieldValueChildren, isFieldValueChild, memberKeysFor, scalarValueRow,
  valueChildContentToEncoded,
} from '@/data/propertyChildren'
import {parseExactReferenceBlockContent} from '@/data/referenceBlock'
import {storedPropertyValue} from '@/data/rowProperty'
import {deleteSubtreeAnnouncedInTx} from '@/data/subtreeDelete'
import {hasLoneSurrogate} from '@/utils/string'
import {jsonValuesEqual} from './jsonCanonical'
import {
  createValueChild, fieldRowsForSchema, freshSlots, hasPendingCellProjection, matchMemberValueChildren,
  projectFieldRowValues, requestCellProjection, upsertFieldRow,
} from './propertyChildrenProcessor'

const readCell = async (tx: Tx, ownerId: string, fieldId: string) => {
  const owner = await tx.get(ownerId)
  if (!owner || owner.deleted) throw new Error('The cell owner is missing or deleted.')
  tx.assertWritableWorkspace(owner.workspaceId)
  if (!await tx.isPropertyChildBackedWorkspace(owner.workspaceId)) throw new Error('Cells require child-backed properties.')
  const schema = tx.resolvePropertyFieldSchema(owner.workspaceId, fieldId)
  if (!schema) throw new Error('The column definition is unavailable.')
  if (schema.changeScope !== ChangeScope.BlockDefault || tx.meta.scope !== ChangeScope.BlockDefault) {
    throw new Error('Cells require a block-scoped property and transaction.')
  }
  const matched = fieldRowsForSchema(await tx.childrenOf(owner.id), fieldId)
  const fields = await Promise.all(matched.map(async field => ({field, children: await tx.childrenOf(field.id)})))
  if (fields.some(({field, children}) =>
    field.workspaceId !== owner.workspaceId || children.some(child => child.workspaceId !== owner.workspaceId))) {
    throw new Error('The cell has rows linked across workspaces.')
  }
  const perField = fields.map(group => group.children.filter(isFieldValueChild))
  const stored = hasPendingCellProjection(tx, ownerId, fieldId)
    ? projectFieldRowValues(schema, perField) : storedPropertyValue(owner.properties, schema.name)
  return {owner, fieldId, schema, fields, values: perField.flat(), stored}
}

type Cell = Awaited<ReturnType<typeof readCell>>
type Field = Pick<BlockData, 'id' | 'workspaceId'>

const appendValue = async (tx: Tx, field: Field, schema: AnyPropertySchema, text: string) => {
  // Read the current order keys after the fold has moved any peers.
  const values = await fieldValueChildren(tx, field.id)
  const keys = memberKeysFor(schema)
  const valueKey = keys.content(text)
  const occurrence = values.filter(value => keys.row(value).key === valueKey).length
  return createValueChild(tx, field, text, freshSlots(values, 1)[0]!, {valueKey, occurrence})
}

const foldFields = (tx: Tx, cell: Cell) => {
  // A field fold carries its value children across, but cannot transfer an
  // independent property bag. Nested fields can themselves contain such bags.
  for (const {field, children} of cell.fields.slice(1)) {
    if (Object.keys(field.properties).length || children.some(child => child.isFieldForm)) {
      throw new Error('A duplicate field has properties of its own. Resolve it in the outline.')
    }
  }
  return upsertFieldRow(tx, cell.owner, cell.fieldId, cell.fields.map(group => group.field), true)
}

const writableContents = (schema: AnyPropertySchema, encoded: unknown) => {
  const contents = encodedPropertyValueToChildContents(schema, encoded)
  if (contents.some(hasLoneSurrogate)) throw new Error('The value cannot be represented in SQLite text.')
  return contents
}

export interface OpenedCell {
  valueId: string
  created: boolean
  /** The field created for this draft, if finishing may also remove it. */
  draftFieldId?: string
}

/** Open in the caller's editing transaction. A list appends an unprojected
 * blank when its member codec permits one. Otherwise edit its last member. */
export const openCell = async (tx: Tx, ownerId: string, fieldId: string): Promise<OpenedCell> => {
  const cell = await readCell(tx, ownerId, fieldId)
  const {schema, stored, values} = cell
  const list = memberCodecOf(schema.codec) !== undefined
  const blankCounts = list && (childContentsToEncodedPropertyValue(schema, ['']) as unknown[]).length > 0
  const target = (rows: BlockData[]) => {
    if (!list) return scalarValueRow(schema, rows)
    const last = rows.at(-1)
    return blankCounts || last?.content === '' ? last : undefined
  }

  const openValue = async (field: Field, existing?: BlockData): Promise<OpenedCell> => {
    if (existing) return {valueId: existing.id, created: false}
    const valueId = await appendValue(tx, field, schema, '')
    return cell.fields.length ? {valueId, created: true} : {valueId, created: true, draftFieldId: field.id}
  }

  // Validate before even minting the field: callers can catch a refusal
  // inside their range transaction and still commit its other cells.
  if (values.length === 0 && stored !== undefined) {
    const decoded = schema.codec.decode(stored)
    const encoded = schema.codec.encode(decoded)
    const projected = childContentsToEncodedPropertyValue(schema, writableContents(schema, encoded))
    if (!jsonValuesEqual(projected, stored)) {
      throw new Error('This stored value cannot be materialized unchanged.')
    }
    if (blankCounts && jsonValuesEqual(stored, [])) {
      throw new Error('Opening this empty list would add a stored member.')
    }
    const field = await foldFields(tx, cell)
    await tx.setProperty(ownerId, schema, decoded)
    const materialized = await fieldValueChildren(tx, field.id)
    return openValue(field, target(materialized))
  }

  const existing = target(values)
  if (stored !== undefined && (cell.fields.length > 1 || !existing)) {
    const after = childContentsToEncodedPropertyValue(schema, existing ? values : [...values, ''])
    if (!jsonValuesEqual(after, stored)) throw new Error('Opening this cell would change its stored value.')
  }
  const field = await foldFields(tx, cell)
  return openValue(field, existing)
}

const carriesData = async (tx: Tx, row: BlockData) =>
  Object.keys(row.properties).length > 0 || await tx.hasChildren(row.id)

const requestProjection = (tx: Tx, cell: Cell) =>
  requestCellProjection(tx, cell.owner, cell.fieldId, cell.schema)

/** Whole-list paste uses one member per line. Invalid list text refuses the
 * whole paste so a subset cannot replace the user's list. */
export const writeCellText = async (tx: Tx, ownerId: string, fieldId: string, text: string): Promise<void> => {
  if (text === '') return clearCell(tx, ownerId, fieldId)
  const cell = await readCell(tx, ownerId, fieldId)
  const {schema} = cell
  if (memberCodecOf(schema.codec)) {
    const lines = text.split(/\r?\n/)
    const encoded = lines.map(line => valueChildContentToEncoded(schema, line))
    const decoded = schema.codec.decode(encoded)
    const contents = writableContents(schema, schema.codec.encode(decoded))
    const {surplus, keyByRow} = matchMemberValueChildren(schema, cell.values, contents)
    for (const row of surplus) {
      if (keyByRow.get(row.id)!.denotesValue && await carriesData(tx, row)) {
        throw new Error('Replacing this list would remove a member with nested data.')
      }
    }
    if (cell.fields.length > 1) await foldFields(tx, cell)
    await tx.setProperty(ownerId, schema, decoded)
    return
  }

  let decoded: unknown
  try {
    decoded = schema.codec.decode(valueChildContentToEncoded(schema, text))
  } catch {
    if (parseExactReferenceBlockContent(text)?.fieldForm || hasLoneSurrogate(text)) {
      throw new Error('This text cannot be stored verbatim as a value block.')
    }
    const field = await foldFields(tx, cell)
    const target = scalarValueRow(schema, cell.values)
    if (!target) await appendValue(tx, field, schema, text)
    else await tx.update(target.id, {content: text})
    requestProjection(tx, cell)
    return
  }
  const [content] = writableContents(schema, schema.codec.encode(decoded))
  const primary = scalarValueRow(schema, cell.values, content)
  for (const value of cell.values) {
    if (value !== primary && value.content === content && await carriesData(tx, value)) {
      throw new Error('Replacing this value would fold an annotated peer. Resolve it in the outline.')
    }
  }
  if (cell.fields.length > 1) await foldFields(tx, cell)
  await tx.setProperty(ownerId, schema, decoded)
}

// Only the open result grants cleanup ownership. A bare id can save text on an existing row.
export const finishCellEdit = async (
  tx: Tx, ownerId: string, fieldId: string, edit: OpenedCell | string, finalText: string,
): Promise<void> => {
  const cell = await readCell(tx, ownerId, fieldId)
  const id = typeof edit === 'string' ? edit : edit.valueId
  const row = cell.values.find(value => value.id === id)
  if (!row) {
    if (finalText !== '') throw new Error('The edited row no longer belongs to this cell.')
    return
  }
  if (parseExactReferenceBlockContent(finalText)?.fieldForm || hasLoneSurrogate(finalText)) {
    throw new Error('This text cannot be stored verbatim as a value block.')
  }
  if (row.content !== finalText) {
    await tx.update(id, {content: finalText})
    requestProjection(tx, cell)
  }
  if (finalText !== '' || typeof edit === 'string' || !edit.created || cell.fields.length !== 1) return
  if (await carriesData(tx, row)) return
  const projected = childContentsToEncodedPropertyValue(cell.schema, cell.values)
  if (cell.stored !== undefined && !jsonValuesEqual(cell.stored, projected)) return
  const peers = cell.values.filter(value => value.id !== id)
  if (peers.length && (!memberCodecOf(cell.schema.codec) ||
    !jsonValuesEqual(childContentsToEncodedPropertyValue(cell.schema, [...peers, '']),
      childContentsToEncodedPropertyValue(cell.schema, peers)))) return
  await deleteSubtreeAnnouncedInTx(tx, id)
  const {field} = cell.fields[0]!
  if (edit.draftFieldId === field.id && !await carriesData(tx, field)) await deleteSubtreeAnnouncedInTx(tx, field.id)
  requestProjection(tx, cell)
}

export const clearCell = async (tx: Tx, ownerId: string, fieldId: string): Promise<void> => {
  const cell = await readCell(tx, ownerId, fieldId)
  for (const {field, children} of cell.fields) {
    for (const value of children.filter(isFieldValueChild)) {
      if (await carriesData(tx, value)) await tx.update(value.id, {content: ''})
      else await deleteSubtreeAnnouncedInTx(tx, value.id)
    }
    if (!await carriesData(tx, field)) await deleteSubtreeAnnouncedInTx(tx, field.id)
  }
  requestProjection(tx, cell)
}
