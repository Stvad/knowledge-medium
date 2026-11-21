import {ChangeScope, CodecError, memberCodecOf, type AnyPropertySchema, type BlockData, type Tx} from '@/data/api'
import {
  childContentsToEncodedPropertyValue, decodedMemberKeysFor, encodedPropertyValueToChildContents, fieldRowsForSchema, fieldValueChildren,
  isFieldValueChild, memberKeysFor, propertyCellValueRejection, rowsProjectToValue, scalarDuplicates, scalarValueRow,
  unionFieldValues, valueChildContentToEncoded, valueSurvivesChildRoundTrip, verbatimValueTextProblem,
} from '@/data/propertyChildren'
import {storedPropertyValue} from '@/data/rowProperty'
import {deleteSubtreeAnnouncedInTx} from '@/data/subtreeDelete'
import {hasLoneSurrogate} from '@/utils/string'
import {jsonValuesEqual} from './jsonCanonical'
import {
  collapseDuplicateValueChild, createValueChild, freshSlots, hasPendingCellProjection, matchMemberValueChildren,
  projectFieldRowValues, reconcileFieldValueChildren, requestCellProjection, upsertFieldRow,
} from './propertyChildrenProcessor'

export type CellRefusalReason = 'read-only' | 'resolve-in-outline' | 'would-change-stored-value' | 'invalid-text'

export class CellRefusedError extends Error {
  constructor(readonly reason: CellRefusalReason, message: string) {
    super(message)
    this.name = 'CellRefusedError'
  }
}

/** Whether the column's resolved definition supports block-scoped cell edits. */
export const isCellEditable = (schema: AnyPropertySchema | null | undefined): boolean =>
  schema?.changeScope === ChangeScope.BlockDefault

const readCell = async (tx: Tx, ownerId: string, fieldId: string) => {
  const owner = await tx.get(ownerId)
  if (!owner || owner.deleted) throw new CellRefusedError('read-only', 'The cell owner is missing or deleted.')
  tx.assertWritableWorkspace(owner.workspaceId)
  if (!await tx.isPropertyChildBackedWorkspace(owner.workspaceId)) throw new CellRefusedError('read-only', 'Cells require child-backed properties.')
  const schema = tx.resolvePropertyFieldSchema(owner.workspaceId, fieldId)
  if (!schema) throw new CellRefusedError('read-only', 'The column definition is unavailable.')
  if (!isCellEditable(schema) || tx.meta.scope !== ChangeScope.BlockDefault) {
    throw new CellRefusedError('read-only', 'Cells require a block-scoped property and transaction.')
  }
  const matched = fieldRowsForSchema(await tx.childrenOf(owner.id), fieldId)
  const fields = await Promise.all(matched.map(async field => ({field, children: await tx.childrenOf(field.id)})))
  if (fields.some(({field, children}) =>
    field.workspaceId !== owner.workspaceId || children.some(child => child.workspaceId !== owner.workspaceId))) {
    throw new CellRefusedError('resolve-in-outline', 'The cell has rows linked across workspaces.')
  }
  const perField = fields.map(group => group.children.filter(isFieldValueChild))
  const stored = hasPendingCellProjection(tx, ownerId, fieldId)
    ? projectFieldRowValues(schema, perField) : storedPropertyValue(owner.properties, schema.name)
  return {owner, fieldId, schema, fields, perField, values: perField.flat(), stored}
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

const fieldValueUnion = (cell: Cell) => {
  const duplicates = new Map<BlockData, BlockData>()
  if (cell.perField.length < 2) return {values: cell.values, duplicates}
  const values = unionFieldValues(cell.perField, decodedMemberKeysFor(cell.schema), (copy, survivor) => duplicates.set(copy, survivor))
  return {values, duplicates}
}

const planOpenFold = (cell: Cell) => {
  const {values, duplicates} = fieldValueUnion(cell)
  // A stored list can explicitly count copies across fields as distinct occurrences.
  if (duplicates.size && memberCodecOf(cell.schema.codec) && cell.stored !== undefined &&
    !rowsProjectToValue(cell.schema, values, cell.stored) &&
    rowsProjectToValue(cell.schema, cell.values, cell.stored)) {
    duplicates.clear()
    return {values: cell.values, duplicates}
  }
  return {values, duplicates}
}

const foldFields = async (tx: Tx, cell: Cell, duplicates?: ReadonlyMap<BlockData, BlockData>) => {
  // A field fold carries its value children across, but cannot transfer an
  // independent property bag. Nested fields can themselves contain such bags.
  for (const {field, children} of cell.fields.slice(1)) {
    if (Object.keys(field.properties).length || children.some(child => child.isFieldForm)) {
      throw new CellRefusedError('resolve-in-outline', 'A duplicate field has properties of its own. Resolve it in the outline.')
    }
  }
  if (duplicates) {
    for (const copy of duplicates.keys()) {
      if (Object.keys(copy.properties).length || (await tx.childrenOf(copy.id)).some(child => child.isFieldForm)) {
        throw new CellRefusedError('resolve-in-outline', 'A duplicate value has properties of its own.')
      }
    }
    for (const [copy, survivor] of duplicates) await collapseDuplicateValueChild(tx, survivor.id, copy)
  }
  return upsertFieldRow(tx, cell.owner, cell.fieldId, cell.fields.map(group => group.field), true)
}

const writableContents = (schema: AnyPropertySchema, encoded: unknown) => {
  const contents = encodedPropertyValueToChildContents(schema, encoded)
  if (contents.some(hasLoneSurrogate)) throw new CellRefusedError('invalid-text', 'The value cannot be represented in SQLite text.')
  return contents
}

const assertValueText = (text: string) => {
  if (verbatimValueTextProblem(text)) {
    throw new CellRefusedError('invalid-text', 'This text cannot be stored verbatim as a value block.')
  }
}

export interface OpenedCell {
  valueId: string
  created: boolean
  /** The field created for this draft, if finishing may also remove it. */
  draftFieldId?: string
}

/** Open in the caller's editing transaction. A list appends an unprojected
 * blank when its member codec permits one. Otherwise edit its last member. */
export const openCell = async (
  tx: Tx, ownerId: string, fieldId: string, {initialText}: {initialText?: string} = {},
): Promise<OpenedCell> => {
  const cell = await readCell(tx, ownerId, fieldId)
  if (initialText !== undefined) assertValueText(initialText)
  const {schema, stored} = cell
  const {values, duplicates} = planOpenFold(cell)
  const list = memberCodecOf(schema.codec) !== undefined
  const blankCounts = list && (childContentsToEncodedPropertyValue(schema, ['']) as unknown[]).length > 0
  const target = (rows: BlockData[]) => {
    if (!list) return scalarValueRow(schema, rows)
    const last = rows.at(-1)
    return blankCounts || last?.content === '' ? last : undefined
  }

  const openValue = async (field: Field, existing?: BlockData): Promise<OpenedCell> => {
    if (existing) {
      if (initialText !== undefined && existing.content !== initialText) {
        await tx.update(existing.id, {content: initialText})
        requestProjection(tx, cell)
      }
      return {valueId: existing.id, created: false}
    }
    const valueId = await appendValue(tx, field, schema, initialText ?? '')
    requestProjection(tx, cell)
    return cell.fields.length || stored !== undefined
      ? {valueId, created: true} : {valueId, created: true, draftFieldId: field.id}
  }

  // Validate before even minting the field: callers can catch a refusal
  // inside their range transaction and still commit its other cells.
  if (values.length === 0 && stored !== undefined) {
    if (propertyCellValueRejection(schema, stored) || !valueSurvivesChildRoundTrip(schema, stored)) {
      throw new CellRefusedError('would-change-stored-value', 'This stored value cannot be materialized unchanged.')
    }
    if (blankCounts && !initialText && jsonValuesEqual(stored, [])) {
      throw new CellRefusedError('would-change-stored-value', 'Opening this empty list would add a stored member.')
    }
    const field = await foldFields(tx, cell, duplicates)
    await reconcileFieldValueChildren(tx, field, schema, stored)
    const materialized = await fieldValueChildren(tx, field.id)
    return openValue(field, target(materialized))
  }

  const existing = target(values)
  if (stored !== undefined && (cell.fields.length > 1 || !existing) &&
    !rowsProjectToValue(schema, existing ? values : [...values, ''], stored)) {
    throw new CellRefusedError('would-change-stored-value', 'Opening this cell would change its stored value.')
  }
  const field = await foldFields(tx, cell, duplicates)
  return openValue(field, existing)
}

const carriesData = async (tx: Tx, row: BlockData) =>
  Object.keys(row.properties).length > 0 || await tx.hasChildren(row.id)

const requestProjection = (tx: Tx, cell: Cell) =>
  requestCellProjection(tx, cell.owner, cell.fieldId, cell.schema)

const preparePaste = (schema: AnyPropertySchema, text: string) => {
  const list = memberCodecOf(schema.codec) !== undefined
  let decoded: unknown
  try {
    const encoded = list ? text.split(/\r?\n/).map(line => valueChildContentToEncoded(schema, line))
      : valueChildContentToEncoded(schema, text)
    decoded = schema.codec.decode(encoded)
  } catch (error) {
    if (!(error instanceof CodecError)) throw error
    if (list) throw new CellRefusedError('invalid-text', 'A pasted member is invalid for this list.')
    assertValueText(text)
    return {kind: 'draft' as const}
  }
  try {
    const contents = writableContents(schema, schema.codec.encode(decoded))
    return {kind: 'typed' as const, decoded, contents}
  } catch (error) {
    if (!(error instanceof CodecError)) throw error
    throw new CellRefusedError('invalid-text', 'This value cannot be written with the column codec.')
  }
}

const planTypedPaste = (cell: Cell, contents: string[]) => {
  const {schema, values} = cell
  if (!memberCodecOf(schema.codec)) {
    const content = contents[0]!
    return {removed: scalarDuplicates(values, scalarValueRow(schema, values, content), content)}
  }
  const {kept, surplus, keyByRow} = matchMemberValueChildren(schema, values, contents)
  const retained = new Set(kept)
  const {duplicates} = fieldValueUnion(cell)
  for (const [copy, survivor] of duplicates) {
    if (retained.has(copy) || !retained.has(survivor)) duplicates.delete(copy)
  }
  return {duplicates, removed: surplus.filter(row => !duplicates.has(row) && keyByRow.get(row.id)!.denotesValue)}
}

/** Whole-list paste takes one member per line. An invalid member refuses the whole edit. */
export const writeCellText = async (tx: Tx, ownerId: string, fieldId: string, text: string): Promise<void> => {
  if (text === '') return clearCell(tx, ownerId, fieldId)
  const cell = await readCell(tx, ownerId, fieldId)
  const {schema} = cell
  const paste = preparePaste(schema, text)
  const plan = paste.kind === 'typed' ? planTypedPaste(cell, paste.contents) : undefined
  for (const row of plan?.removed ?? []) {
    if (await carriesData(tx, row)) {
      throw new CellRefusedError('resolve-in-outline', 'Replacing this value would consume an annotated row.')
    }
  }

  const field = await foldFields(tx, cell, plan?.duplicates)
  if (paste.kind === 'typed') return tx.setProperty(ownerId, schema, paste.decoded)
  const target = scalarValueRow(schema, cell.values)
  if (target) await tx.update(target.id, {content: text})
  else await appendValue(tx, field, schema, text)
  requestProjection(tx, cell)
}

// Only the open result grants cleanup ownership. A bare id can save text on an existing row.
export const finishCellEdit = async (
  tx: Tx, ownerId: string, fieldId: string, edit: OpenedCell | string, finalText: string,
): Promise<void> => {
  const cell = await readCell(tx, ownerId, fieldId)
  const id = typeof edit === 'string' ? edit : edit.valueId
  const row = cell.values.find(value => value.id === id)
  if (!row) {
    if (finalText !== '') throw new CellRefusedError('resolve-in-outline', 'The edited row no longer belongs to this cell.')
    return
  }
  assertValueText(finalText)
  if (row.content !== finalText) {
    await tx.update(id, {content: finalText})
    requestProjection(tx, cell)
  }
  if (finalText !== '' || typeof edit === 'string' || !edit.created || cell.fields.length !== 1) return
  if (await carriesData(tx, row)) return
  if (cell.stored !== undefined && !rowsProjectToValue(cell.schema, cell.values, cell.stored)) return
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
