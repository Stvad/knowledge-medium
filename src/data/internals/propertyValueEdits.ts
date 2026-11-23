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

export type PropertyEditRefusalReason = 'read-only' | 'resolve-in-outline' | 'would-change-stored-value' | 'invalid-text'

export class PropertyEditRefusedError extends Error {
  constructor(readonly reason: PropertyEditRefusalReason, message: string) {
    super(message)
    this.name = 'PropertyEditRefusedError'
  }
}

/** Whether these edits accept the property's resolved definition. The writes also check the owner,
 *  its workspace and the transaction scope. */
export const isPropertyValueEditable = (schema: AnyPropertySchema | null | undefined): boolean =>
  schema?.changeScope === ChangeScope.BlockDefault

/** The owner's field rows and value rows for one property, with its stored value. Every edit
 *  here classifies through this read, and refuses an owner, workspace or definition it cannot edit. */
const readPropertyRows = async (tx: Tx, ownerId: string, fieldId: string) => {
  const owner = await tx.get(ownerId)
  if (!owner || owner.deleted) throw new PropertyEditRefusedError('read-only', 'The property owner is missing or deleted.')
  tx.assertWritableWorkspace(owner.workspaceId)
  if (!await tx.isPropertyChildBackedWorkspace(owner.workspaceId)) throw new PropertyEditRefusedError('read-only', 'This workspace does not store properties as rows.')
  const schema = tx.resolvePropertyFieldSchema(owner.workspaceId, fieldId)
  if (!schema) throw new PropertyEditRefusedError('read-only', 'The property definition is unavailable.')
  if (!isPropertyValueEditable(schema) || tx.meta.scope !== ChangeScope.BlockDefault) {
    throw new PropertyEditRefusedError('read-only', 'Only block-scoped properties can be edited as rows, in a block-scoped transaction.')
  }
  const matched = fieldRowsForSchema(await tx.childrenOf(owner.id), fieldId)
  const fields = await Promise.all(matched.map(async field => ({field, children: await tx.childrenOf(field.id)})))
  if (fields.some(({field, children}) =>
    field.workspaceId !== owner.workspaceId || children.some(child => child.workspaceId !== owner.workspaceId))) {
    throw new PropertyEditRefusedError('resolve-in-outline', 'The property has rows linked across workspaces.')
  }
  const perField = fields.map(group => group.children.filter(isFieldValueChild))
  // Mid-tx the cell is stale, so it is no base to hold a pending member against.
  const stored = hasPendingCellProjection(tx, ownerId, fieldId)
    ? projectFieldRowValues(schema, perField) : storedPropertyValue(owner.properties, schema.name)
  return {owner, fieldId, schema, fields, perField, values: perField.flat(), stored}
}

type PropertyRows = Awaited<ReturnType<typeof readPropertyRows>>


type Field = Pick<BlockData, 'id' | 'workspaceId'>

const appendValue = async (tx: Tx, field: Field, schema: AnyPropertySchema, text: string) => {
  // Read the current order keys after the fold has moved any peers.
  const values = await fieldValueChildren(tx, field.id)
  const keys = memberKeysFor(schema)
  const valueKey = keys.content(text)
  const occurrence = values.filter(value => keys.row(value).key === valueKey).length
  return createValueChild(tx, field, text, freshSlots(values, 1)[0]!, {valueKey, occurrence})
}

const fieldValueUnion = (rows: PropertyRows) => {
  const duplicates = new Map<BlockData, BlockData>()
  if (rows.perField.length < 2) return {values: rows.values, duplicates}
  const values = unionFieldValues(rows.perField, decodedMemberKeysFor(rows.schema), (copy, survivor) => duplicates.set(copy, survivor))
  return {values, duplicates}
}

const planOpenFold = (rows: PropertyRows) => {
  const {values, duplicates} = fieldValueUnion(rows)
  // A stored list can explicitly count copies across fields as distinct occurrences.
  if (duplicates.size && memberCodecOf(rows.schema.codec) && rows.stored !== undefined &&
    !rowsProjectToValue(rows.schema, values, rows.stored) &&
    rowsProjectToValue(rows.schema, rows.values, rows.stored)) {
    duplicates.clear()
    return {values: rows.values, duplicates}
  }
  return {values, duplicates}
}

const foldFields = async (tx: Tx, rows: PropertyRows, duplicates?: ReadonlyMap<BlockData, BlockData>) => {
  // A field fold carries its value children across, but cannot transfer an
  // independent property bag. Nested fields can themselves contain such bags.
  for (const {field, children} of rows.fields.slice(1)) {
    if (Object.keys(field.properties).length || children.some(child => child.isFieldForm)) {
      throw new PropertyEditRefusedError('resolve-in-outline', 'A duplicate field has properties of its own. Resolve it in the outline.')
    }
  }
  if (duplicates) {
    for (const copy of duplicates.keys()) {
      if (Object.keys(copy.properties).length || (await tx.childrenOf(copy.id)).some(child => child.isFieldForm)) {
        throw new PropertyEditRefusedError('resolve-in-outline', 'A duplicate value has properties of its own.')
      }
    }
    for (const [copy, survivor] of duplicates) await collapseDuplicateValueChild(tx, survivor.id, copy)
  }
  return upsertFieldRow(tx, rows.owner, rows.fieldId, rows.fields.map(group => group.field), true)
}

const writableContents = (schema: AnyPropertySchema, encoded: unknown) => {
  const contents = encodedPropertyValueToChildContents(schema, encoded)
  if (contents.some(hasLoneSurrogate)) throw new PropertyEditRefusedError('invalid-text', 'The value cannot be represented in SQLite text.')
  return contents
}

const assertValueText = (text: string) => {
  if (verbatimValueTextProblem(text)) {
    throw new PropertyEditRefusedError('invalid-text', 'This text cannot be stored verbatim as a value block.')
  }
}

interface FoldPlan {
  values: BlockData[]
  duplicates: Map<BlockData, BlockData>
}

/** Fold the property's field rows into one and materialize a stored value that has no rows yet.
 *  Refuses, before any write, a fold or materialization that would change the stored value. */
const materializeFieldRows = async (tx: Tx, rows: PropertyRows, {values, duplicates}: FoldPlan) => {
  const {schema, stored} = rows
  const materialize = rows.values.length === 0 && stored !== undefined
  // The round trip checks members; only the rejection runs a list codec over the whole list.
  if (materialize && (propertyCellValueRejection(schema, stored) || !valueSurvivesChildRoundTrip(schema, stored))) {
    throw new PropertyEditRefusedError('would-change-stored-value', 'This stored value cannot be written out as rows without changing it.')
  }
  if (!materialize && stored !== undefined && rows.fields.length > 1 && !rowsProjectToValue(schema, values, stored)) {
    throw new PropertyEditRefusedError('would-change-stored-value', 'Folding this property\u2019s duplicate field rows would change its stored value.')
  }
  const field = await foldFields(tx, rows, duplicates)
  if (materialize) await reconcileFieldValueChildren(tx, field, schema, stored)
  return field
}

/** Give the owner one field row for this property without opening a value, as `openPropertyValue`
 *  does first. Returns undefined, writing nothing, when it has neither a field row nor a stored value. */
export const materializePropertyField = async (tx: Tx, ownerId: string, fieldId: string): Promise<string | undefined> => {
  const rows = await readPropertyRows(tx, ownerId, fieldId)
  if (rows.fields.length === 0 && rows.stored === undefined) return undefined
  return (await materializeFieldRows(tx, rows, planOpenFold(rows))).id
}

export interface OpenedPropertyValue {
  valueId: string
  created: boolean
  /** The field created for this draft, if finishing may also remove it. */
  draftFieldId?: string
}

/** Give the owner a value row to edit for this property, in the caller's transaction: a stored
 *  value with no rows yet is materialized first, and duplicate field rows are folded. A list
 *  appends an unprojected blank when its member codec permits one, otherwise its last member
 *  opens. `initialText` is written in the same transaction. */
export const openPropertyValue = async (
  tx: Tx, ownerId: string, fieldId: string, {initialText}: {initialText?: string} = {},
): Promise<OpenedPropertyValue> => {
  const rows = await readPropertyRows(tx, ownerId, fieldId)
  if (initialText !== undefined) assertValueText(initialText)
  const {schema, stored} = rows
  const plan = planOpenFold(rows)
  const {values} = plan
  const list = memberCodecOf(schema.codec) !== undefined
  const blankCounts = list && (childContentsToEncodedPropertyValue(schema, ['']) as unknown[]).length > 0
  const target = (candidates: BlockData[]) => {
    if (!list) return scalarValueRow(schema, candidates)
    const last = candidates.at(-1)
    return blankCounts || last?.content === '' ? last : undefined
  }

  const openValue = async (field: Field, existing?: BlockData): Promise<OpenedPropertyValue> => {
    if (existing) {
      if (initialText !== undefined && existing.content !== initialText) {
        await tx.update(existing.id, {content: initialText})
        requestProjection(tx, rows)
      }
      return {valueId: existing.id, created: false}
    }
    const valueId = await appendValue(tx, field, schema, initialText ?? '')
    requestProjection(tx, rows)
    return rows.fields.length || stored !== undefined
      ? {valueId, created: true} : {valueId, created: true, draftFieldId: field.id}
  }

  // Validate before even minting the field: callers can catch a refusal
  // inside their range transaction and still commit its other cells.
  if (values.length === 0 && stored !== undefined) {
    if (blankCounts && !initialText && jsonValuesEqual(stored, [])) {
      throw new PropertyEditRefusedError('would-change-stored-value', 'Opening this empty list would add a stored member.')
    }
    const field = await materializeFieldRows(tx, rows, plan)
    return openValue(field, target(await fieldValueChildren(tx, field.id)))
  }

  const existing = target(values)
  if (stored !== undefined && !existing && !rowsProjectToValue(schema, [...values, ''], stored)) {
    throw new PropertyEditRefusedError('would-change-stored-value', 'Opening this property would change its stored value.')
  }
  return openValue(await materializeFieldRows(tx, rows, plan), existing)
}

const carriesData = async (tx: Tx, row: BlockData) =>
  Object.keys(row.properties).length > 0 || await tx.hasChildren(row.id)

const requestProjection = (tx: Tx, rows: PropertyRows) =>
  requestCellProjection(tx, rows.owner, rows.fieldId, rows.schema)

const preparePaste = (schema: AnyPropertySchema, text: string) => {
  const list = memberCodecOf(schema.codec) !== undefined
  let decoded: unknown
  try {
    const encoded = list ? text.split(/\r?\n/).map(line => valueChildContentToEncoded(schema, line))
      : valueChildContentToEncoded(schema, text)
    decoded = schema.codec.decode(encoded)
  } catch (error) {
    if (!(error instanceof CodecError)) throw error
    if (list) throw new PropertyEditRefusedError('invalid-text', 'A pasted member is invalid for this list.')
    assertValueText(text)
    return {kind: 'draft' as const}
  }
  try {
    const contents = writableContents(schema, schema.codec.encode(decoded))
    return {kind: 'typed' as const, decoded, contents}
  } catch (error) {
    if (!(error instanceof CodecError)) throw error
    throw new PropertyEditRefusedError('invalid-text', 'This value cannot be written with the property codec.')
  }
}

const planTypedPaste = (rows: PropertyRows, contents: string[]) => {
  const {schema, values} = rows
  if (!memberCodecOf(schema.codec)) {
    const content = contents[0]!
    return {removed: scalarDuplicates(values, scalarValueRow(schema, values, content), content)}
  }
  const {kept, surplus, keyByRow} = matchMemberValueChildren(schema, values, contents)
  const retained = new Set(kept)
  const {duplicates} = fieldValueUnion(rows)
  for (const [copy, survivor] of duplicates) {
    if (retained.has(copy) || !retained.has(survivor)) duplicates.delete(copy)
  }
  return {duplicates, removed: surplus.filter(row => !duplicates.has(row) && keyByRow.get(row.id)!.denotesValue)}
}

/** Write the property from text: a scalar replaces its value, a list takes one member per line and
 *  an invalid member refuses the whole edit. Empty text clears. */
export const writePropertyText = async (tx: Tx, ownerId: string, fieldId: string, text: string): Promise<void> => {
  if (text === '') return clearPropertyValue(tx, ownerId, fieldId)
  const rows = await readPropertyRows(tx, ownerId, fieldId)
  const {schema} = rows
  const paste = preparePaste(schema, text)
  const plan = paste.kind === 'typed' ? planTypedPaste(rows, paste.contents) : undefined
  for (const row of plan?.removed ?? []) {
    if (await carriesData(tx, row)) {
      throw new PropertyEditRefusedError('resolve-in-outline', 'Replacing this value would consume an annotated row.')
    }
  }

  const field = await foldFields(tx, rows, plan?.duplicates)
  if (paste.kind === 'typed') return tx.setProperty(ownerId, schema, paste.decoded)
  const target = scalarValueRow(schema, rows.values)
  if (target) await tx.update(target.id, {content: text})
  else await appendValue(tx, field, schema, text)
  requestProjection(tx, rows)
}

/** End an edit of one value row: save the editor's final text, and remove a draft that
 *  `openPropertyValue` created and that is still blank with nothing attached. Only the open
 *  result grants that cleanup; a bare id saves text. */
export const finishPropertyValueEdit = async (
  tx: Tx, ownerId: string, fieldId: string, edit: OpenedPropertyValue | string, finalText: string,
): Promise<void> => {
  const rows = await readPropertyRows(tx, ownerId, fieldId)
  const id = typeof edit === 'string' ? edit : edit.valueId
  const row = rows.values.find(value => value.id === id)
  if (!row) {
    if (finalText !== '') throw new PropertyEditRefusedError('resolve-in-outline', 'The edited row no longer belongs to this property.')
    // The draft was deleted while blank: the field it created goes with it, so an unset property stays unset.
    if (typeof edit !== 'string') await removeDraftField(tx, rows, edit)
    return
  }
  assertValueText(finalText)
  if (row.content !== finalText) {
    await tx.update(id, {content: finalText})
    requestProjection(tx, rows)
  }
  if (finalText !== '' || typeof edit === 'string' || !edit.created || rows.fields.length !== 1) return
  if (await carriesData(tx, row)) return
  if (rows.stored !== undefined && !rowsProjectToValue(rows.schema, rows.values, rows.stored)) return
  const peers = rows.values.filter(value => value.id !== id)
  if (peers.length && (!memberCodecOf(rows.schema.codec) ||
    !jsonValuesEqual(childContentsToEncodedPropertyValue(rows.schema, [...peers, '']),
      childContentsToEncodedPropertyValue(rows.schema, peers)))) return
  await deleteSubtreeAnnouncedInTx(tx, id)
  const {field} = rows.fields[0]!
  if (edit.draftFieldId === field.id && !await carriesData(tx, field)) await deleteSubtreeAnnouncedInTx(tx, field.id)
  requestProjection(tx, rows)
}

const removeDraftField = async (tx: Tx, rows: PropertyRows, edit: OpenedPropertyValue) => {
  const draft = rows.fields.find(({field}) => field.id === edit.draftFieldId)
  if (!draft || await carriesData(tx, draft.field)) return
  await deleteSubtreeAnnouncedInTx(tx, draft.field.id)
  requestProjection(tx, rows)
}

/** Unset the property: every value row goes, then each field row left with no data of its own.
 *  A value row with nested blocks or properties refuses the whole clear before any write: blanking
 *  it would keep the property set, so it is resolved in the outline. */
export const clearPropertyValue = async (tx: Tx, ownerId: string, fieldId: string): Promise<void> => {
  const rows = await readPropertyRows(tx, ownerId, fieldId)
  for (const value of rows.values) {
    if (await carriesData(tx, value)) {
      throw new PropertyEditRefusedError('resolve-in-outline', 'A value has notes or properties of its own. Resolve it in the outline.')
    }
  }
  for (const {field, children} of rows.fields) {
    for (const value of children.filter(isFieldValueChild)) await deleteSubtreeAnnouncedInTx(tx, value.id)
    if (!await carriesData(tx, field)) await deleteSubtreeAnnouncedInTx(tx, field.id)
  }
  requestProjection(tx, rows)
}
