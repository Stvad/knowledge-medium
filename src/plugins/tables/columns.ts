/** Column gestures. Each writes only the view's column blocks, or the
 *  declaration of a type, in one transaction, so each is one undo step; none
 *  touches a row or its values. */
import { ChangeScope, propertyValue, type BlockData, type Tx } from '@/data/api'
import { loadTypeIdsByBlock } from '@/data/blockTypeLookup'
import { BLOCK_TYPE_TYPE, PROPERTY_SCHEMA_TYPE } from '@/data/blockTypes'
import { isValidSeededDefinition } from '@/data/definitionSeeds'
import { blockTypeLabelProp, blockTypePropertiesProp, hasBlockType } from '@/data/properties'
import { adoptOrCreatePropertySchema, type PropertySchemaChoice } from '@/data/propertySchemaCreation'
import type { Repo } from '@/data/repo'
import { decodeRowProperty } from '@/data/rowProperty'
import { createTypedChild } from '@/data/typedRecords'
import { showInfo } from '@/utils/toast'
import { deleteBlock } from '@/data/mutators'
import { ensureDeletableThroughUi } from '@/utils/deleteBlockThroughUi'
import { COLUMN_TYPE, TABLE_TYPE, VIEW_TYPE, columnFieldProp, columnHiddenProp, columnWidthProp } from './schema'

const options = (description: string) => ({scope: ChangeScope.BlockDefault, description})

/** Narrower than this, a header has no room for its name or its handles. */
export const MIN_COLUMN_WIDTH = 48

/** The width a drag to `width` stores. */
export const columnWidthFor = (width: number): number => Math.max(MIN_COLUMN_WIDTH, Math.round(width))

export const resizeColumn = (repo: Repo, columnId: string, width: number): Promise<void> =>
  repo.tx(tx => tx.setProperty(columnId, columnWidthProp, columnWidthFor(width)), options('resize table column'))

/** Sibling order among the view's column blocks is column order, so a
 *  reorder is one move beside another column of the same view. */
export const moveColumn = async (
  repo: Repo, columnId: string, anchor: {side: 'before' | 'after'; columnId: string},
): Promise<void> => {
  if (anchor.columnId === columnId) return
  const column = repo.block(columnId).peek() ?? await repo.block(columnId).load()
  if (!column?.parentId) return
  await repo.mutate.move({
    id: columnId, parentId: column.parentId, position: {kind: anchor.side, siblingId: anchor.columnId},
  })
}

/** Back to the automatic width. */
export const clearColumnWidth = (repo: Repo, columnId: string): Promise<void> =>
  repo.tx(tx => tx.unsetProperty(columnId, columnWidthProp), options('reset table column width'))

/** A hidden column keeps its block, place and width. Showing it unsets the
 *  flag rather than storing `false`. */
export const setColumnHidden = (repo: Repo, columnId: string, hidden: boolean): Promise<void> =>
  repo.tx(tx => hidden ? tx.setProperty(columnId, columnHiddenProp, true) : tx.unsetProperty(columnId, columnHiddenProp),
    options(hidden ? 'hide table column' : 'show table column'))

export type ColumnDeletion = 'deleted' | 'refused' | 'nested'

/** Deletes the column block and its own property rows; the rows' values stay
 *  where they are. A column with anything else under it is refused, decided in
 *  the deleting transaction: the grid never draws what is nested under a
 *  column, so deleting it from the header would remove blocks the user cannot
 *  see. The outline, which draws them, still deletes it. */
export const deleteColumn = async (repo: Repo, columnId: string): Promise<ColumnDeletion> => {
  if (!await ensureDeletableThroughUi([repo.block(columnId)])) return 'refused'
  return repo.tx(async tx => {
    if ((await tx.childrenOf(columnId, undefined, {propertyChildren: 'none'})).length > 0) return 'nested'
    // The deletion guards ran above; the nested check needs this transaction.
    await tx.run(deleteBlock, {id: columnId})
    return 'deleted'
  }, options('delete table column'))
}

/** A new column showing `fieldId` (null for the row's own text), last in the view. */
const addColumnInTx = (repo: Repo, tx: Tx, viewId: string, fieldId: string | null): Promise<string> =>
  createTypedChild(repo, tx, {
    parentId: viewId, types: [COLUMN_TYPE], position: {kind: 'last'},
    properties: fieldId === null ? [] : [propertyValue(columnFieldProp, fieldId)],
  })

export const addColumn = (repo: Repo, viewId: string, fieldId: string | null): Promise<string> =>
  repo.tx(tx => addColumnInTx(repo, tx, viewId, fieldId), options('add table column'))

/** A column for a property picked by name. A new property is created in the
 *  same transaction as its column, so one undo removes both. */
export const addColumnForChoice = async (repo: Repo, viewId: string, choice: PropertySchemaChoice): Promise<void> => {
  const result = await adoptOrCreatePropertySchema(repo, choice, (tx, fieldId) => addColumnInTx(repo, tx, viewId, fieldId).then(() => {}))
  if (result.kind === 'created') return
  const fieldId = repo.userSchemas.getSchemaBlockId(result.schema.name)
  // A column's field is a definition block, which a code-only property lacks.
  if (!fieldId) {
    showInfo(`“${result.schema.name}” has no definition block, so it cannot be a column.`)
    return
  }
  await addColumn(repo, viewId, fieldId)
}

/** A type a user can declare properties on: a block-type block of their own.
 *  A code-owned type's block is a mirror of its seed and stays read-only. */
const isEditableTypeBlock = (data: BlockData) =>
  !data.deleted && hasBlockType(data, BLOCK_TYPE_TYPE) && !isValidSeededDefinition(data)

/** Add `fieldId` to the properties `typeBlockId` declares. Returns false, writing
 *  nothing, when it is declared already or the type is not the user's own. */
export const addPropertyToType = (repo: Repo, typeBlockId: string, fieldId: string): Promise<boolean> => repo.tx(async tx => {
  const type = await tx.get(typeBlockId)
  const field = await tx.get(fieldId)
  if (!type || !isEditableTypeBlock(type) || !field || field.deleted || !hasBlockType(field, PROPERTY_SCHEMA_TYPE)) return false
  const declared = decodeRowProperty(type, blockTypePropertiesProp)
  if (declared.includes(fieldId)) return false
  await tx.setProperty(typeBlockId, blockTypePropertiesProp, [...declared, fieldId])
  return true
}, options('add property to type'))

export interface TypeTarget {
  readonly typeId: string
  readonly typeBlockId: string
  readonly label: string
}

/** The table's own machinery is never a row's type in the sense meant here. */
const TABLE_TYPES = new Set([TABLE_TYPE, VIEW_TYPE, COLUMN_TYPE])

/** The types a table is built from: in a table of the host's children, the
 *  types every row carries. Only the user's own types, since only those
 *  declare properties a user can edit, and only those that do not declare
 *  `fieldId` already. None for a table with no rows. */
export const typeTargetsFor = async (
  repo: Repo, workspaceId: string, rowIds: readonly string[], fieldId: string,
): Promise<TypeTarget[]> => {
  if (rowIds.length === 0) return []
  const typesByRow = await loadTypeIdsByBlock(repo, workspaceId, rowIds)
  const shared = (typesByRow.get(rowIds[0]!) ?? [])
    .filter(type => !TABLE_TYPES.has(type) && rowIds.every(id => typesByRow.get(id)?.includes(type)))
  const targets: TypeTarget[] = []
  for (const typeId of shared) {
    const typeBlockId = repo.userTypes.getTypeBlockId(typeId)
    if (!typeBlockId) continue
    const type = repo.block(typeBlockId).peek() ?? await repo.block(typeBlockId).load()
    if (!type || !isEditableTypeBlock(type) || decodeRowProperty(type, blockTypePropertiesProp).includes(fieldId)) continue
    targets.push({typeId, typeBlockId, label: decodeRowProperty(type, blockTypeLabelProp) || typeId})
  }
  return targets
}
