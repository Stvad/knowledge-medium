import {ChangeScope, memberCodecOf, type AnyPropertySchema, type BlockData, type Tx} from '@/data/api'
import {
  childContentsToEncodedPropertyValue, encodedToValueChildContent, fieldValueChildren, isFieldValueChild, memberKeysFor, scalarValueRow,
  valueChildContentToEncoded, valueSurvivesChildRoundTrip,
} from '@/data/propertyChildren'
import {parseExactReferenceBlockContent} from '@/data/referenceBlock'
import {storedPropertyValue} from '@/data/rowProperty'
import {deleteSubtreeAnnouncedInTx} from '@/data/subtreeDelete'
import {hasLoneSurrogate} from '@/utils/string'
import {jsonValuesEqual} from './jsonCanonical'
import {createValueChild, fieldRowsForSchema, freshSlots, REPROJECT_CELL_EVENT, upsertFieldRow} from './propertyChildrenProcessor'

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
  const fields = fieldRowsForSchema(await tx.childrenOf(owner.id), fieldId)
  const groups = await Promise.all(fields.map(async field => ({field, children: await tx.childrenOf(field.id)})))
  const values = groups.flatMap(group => group.children.filter(isFieldValueChild))
  return {owner, fieldId, schema, fields, groups, values, stored: storedPropertyValue(owner.properties, schema.name)}
}

type Cell = Awaited<ReturnType<typeof readCell>>
type Field = Pick<BlockData, 'id' | 'workspaceId'>

const appendValue = (tx: Tx, field: Field, schema: AnyPropertySchema, values: BlockData[], text: string) => {
  const keys = memberKeysFor(schema)
  const valueKey = keys.content(text)
  const occurrence = values.filter(value => keys.row(value).key === valueKey).length
  return createValueChild(tx, field, text, freshSlots(values, 1)[0]!, {valueKey, occurrence})
}

const foldFields = (tx: Tx, cell: Cell) => {
  // A field fold carries its value children across, but cannot transfer an
  // independent property bag. Nested fields can themselves contain such bags.
  for (const {field, children} of cell.groups.slice(1)) {
    if (Object.keys(field.properties).length || children.some(child => child.isFieldForm)) {
      throw new Error('A duplicate field has properties of its own. Resolve it in the outline.')
    }
  }
  return upsertFieldRow(tx, cell.owner, cell.fieldId, cell.fields, true)
}

/** Open in the caller's editing transaction. A list appends an unprojected
 * blank when its member codec permits one. Otherwise edit its last member. */
export const openCell = async (tx: Tx, ownerId: string, fieldId: string): Promise<string> => {
  const cell = await readCell(tx, ownerId, fieldId)
  const {schema, stored, values} = cell
  const list = memberCodecOf(schema.codec) !== undefined
  const blankCounts = list && (childContentsToEncodedPropertyValue(schema, ['']) as unknown[]).length > 0
  const target = (rows: BlockData[]) =>
    list ? (blankCounts ? rows.at(-1) : undefined) : scalarValueRow(schema, rows)

  // Validate before even minting the field: callers can catch a refusal
  // inside their range transaction and still commit its other cells.
  if (values.length === 0 && stored !== undefined) {
    const decoded = schema.codec.decode(stored)
    if (!jsonValuesEqual(schema.codec.encode(decoded), stored) || !valueSurvivesChildRoundTrip(schema, stored)) {
      throw new Error('This stored value cannot be materialized unchanged.')
    }
    if (blankCounts && Array.isArray(stored) && stored.length === 0) {
      throw new Error('Opening this empty list would add a stored member.')
    }
    const field = await foldFields(tx, cell)
    await tx.setProperty(ownerId, schema, decoded)
    const materialized = await fieldValueChildren(tx, field.id)
    return target(materialized)?.id ?? await appendValue(tx, field, schema, materialized, '')
  }

  const existing = target(values)
  if (stored !== undefined && (cell.fields.length > 1 || !existing)) {
    const after = childContentsToEncodedPropertyValue(schema, existing ? values : [...values, ''])
    if (!jsonValuesEqual(after, stored)) throw new Error('Opening this cell would change its stored value.')
  }
  const field = await foldFields(tx, cell)
  if (existing) return existing.id
  // A fold moves values to new sibling positions.
  const siblings = cell.fields.length > 1 ? await fieldValueChildren(tx, field.id) : values
  return appendValue(tx, field, schema, siblings, '')
}

const carriesData = async (tx: Tx, row: BlockData) =>
  Object.keys(row.properties).length > 0 || await tx.hasChildren(row.id)

const requestProjection = (tx: Tx, cell: Cell) =>
  tx.emitEvent(REPROJECT_CELL_EVENT, {ownerId: cell.owner.id, fieldId: cell.fieldId}, cell.owner.workspaceId)

/** Whole-list paste uses one member per line. Invalid list text refuses the
 * whole paste so a subset cannot replace the user's list. */
export const writeCellText = async (tx: Tx, ownerId: string, fieldId: string, text: string): Promise<void> => {
  if (text === '') return clearCell(tx, ownerId, fieldId)
  const cell = await readCell(tx, ownerId, fieldId)
  const {schema} = cell
  if (memberCodecOf(schema.codec)) {
    const lines = text.split(/\r?\n/)
    const encoded = lines.map(line => valueChildContentToEncoded(schema, line))
    const keys = memberKeysFor(schema)
    const remaining = new Map<string, number>()
    for (const line of lines) {
      const key = keys.content(line)
      remaining.set(key, (remaining.get(key) ?? 0) + 1)
    }
    for (const value of cell.values) {
      const {key, denotesValue} = keys.row(value)
      const count = remaining.get(key) ?? 0
      if (count > 0) remaining.set(key, count - 1)
      else if (denotesValue && await carriesData(tx, value)) {
        throw new Error('Replacing this list would remove a member with nested data.')
      }
    }
    const decoded = schema.codec.decode(encoded)
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
    const values = await fieldValueChildren(tx, field.id)
    const target = scalarValueRow(schema, values)
    if (!target) await appendValue(tx, field, schema, values, text)
    else if (target.content !== text) await tx.update(target.id, {content: text})
    else requestProjection(tx, cell)
    return
  }
  const content = encodedToValueChildContent(schema, schema.codec.encode(decoded))
  const primary = scalarValueRow(schema, cell.values, content)
  for (const value of cell.values) {
    if (value !== primary && value.content === content && await carriesData(tx, value)) {
      throw new Error('Replacing this value would fold an annotated peer. Resolve it in the outline.')
    }
  }
  if (cell.fields.length > 1) await foldFields(tx, cell)
  await tx.setProperty(ownerId, schema, decoded)
}

/** Pass ifBlankValueId only after the editor's final flush. The identity,
 * peers, content and descendants are all checked under the write lock. */
export const clearCell = async (
  tx: Tx, ownerId: string, fieldId: string, options?: {ifBlankValueId: string},
): Promise<void> => {
  const cell = await readCell(tx, ownerId, fieldId)
  if (options) {
    if (cell.fields.length !== 1) return
    const {values} = cell
    if (values.length !== 1 || values[0]!.id !== options.ifBlankValueId || values[0]!.content !== '') return
    if (await carriesData(tx, values[0]!)) return
    if (cell.stored !== undefined && !jsonValuesEqual(cell.stored, childContentsToEncodedPropertyValue(cell.schema, values))) return
  }
  for (const {field, children} of cell.groups) {
    for (const value of children.filter(isFieldValueChild)) {
      if (await carriesData(tx, value)) await tx.update(value.id, {content: ''})
      else await deleteSubtreeAnnouncedInTx(tx, value.id)
    }
    if (!await carriesData(tx, field)) await deleteSubtreeAnnouncedInTx(tx, field.id)
  }
  requestProjection(tx, cell)
}
