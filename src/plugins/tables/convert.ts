import { ChangeScope, propertyValue, type BlockData, type Tx } from '@/data/api'
import { repoPropertyRowClassifier } from '@/data/drawnSubtree'
import { isPropertyValueEditable } from '@/data/internals/propertyValueEdits'
import { isPropertyFieldInstance, type PropertyRowClassifier } from '@/data/propertyChildren'
import { hasBlockType } from '@/data/properties'
import type { Repo } from '@/data/repo'
import { createTypedChild } from '@/data/typedRecords'
import { ROW_CAP } from './model'
import { COLUMN_TYPE, TABLE_TYPE, VIEW_TYPE, columnFieldProp } from './schema'

/** A field row or one of its values. Its children are the property's values,
 *  so a view block added under it would be read as a value. */
const isPropertyRow = async (tx: Tx, classifier: PropertyRowClassifier, block: BlockData) => {
  if (isPropertyFieldInstance(block, classifier.isFieldDefinition)) return true
  const parent = block.parentId ? await tx.get(block.parentId) : null
  return parent !== null && isPropertyFieldInstance(parent, classifier.isFieldDefinition)
}

/** The block-scoped properties the host's rows carry, in first-seen order,
 *  minus those the outline's default display hides (types, aliases). */
const rowFieldIds = async (tx: Tx, classifier: PropertyRowClassifier, host: BlockData, rows: readonly BlockData[]) => {
  const fieldIds: string[] = []
  for (const row of rows.slice(0, ROW_CAP)) {
    for (const child of await tx.childrenOf(row.id)) {
      const fieldId = child.referenceTargetId
      if (!fieldId || !isPropertyFieldInstance(child, classifier.isFieldDefinition) || fieldIds.includes(fieldId) ||
        classifier.isOutlineSkipped(fieldId)) continue
      if (isPropertyValueEditable(tx.resolvePropertyFieldSchema(host.workspaceId, fieldId))) fieldIds.push(fieldId)
    }
  }
  return fieldIds
}

/** Tag the block as a table. A block with no view yet gets one, with a column
 *  for its rows' own text and one per property its rows carry now; later
 *  columns are added explicitly. Nothing moves: the children are the rows.
 *  A property row is refused, writing nothing. */
export const turnIntoTable = (repo: Repo, blockId: string): Promise<void> => repo.tx(async tx => {
  const host = await tx.get(blockId)
  if (!host || host.deleted) return
  const classifier = repoPropertyRowClassifier(repo, host.workspaceId)
  if (await isPropertyRow(tx, classifier, host)) return
  if (!hasBlockType(host, TABLE_TYPE)) await repo.addTypeInTx(tx, host.id, TABLE_TYPE)
  const children = await tx.childrenOf(host.id, undefined, {propertyChildren: 'none'})
  if (children.some(child => hasBlockType(child, VIEW_TYPE))) return
  const fieldIds = await rowFieldIds(tx, classifier, host, children)
  const viewId = await createTypedChild(repo, tx, {
    parentId: host.id, content: 'Default', types: [VIEW_TYPE], position: {kind: 'first'},
  })
  await createTypedChild(repo, tx, {parentId: viewId, types: [COLUMN_TYPE]})
  for (const fieldId of fieldIds) {
    await createTypedChild(repo, tx, {
      parentId: viewId, types: [COLUMN_TYPE], properties: [propertyValue(columnFieldProp, fieldId)],
    })
  }
}, {scope: ChangeScope.BlockDefault, description: 'turn into table'})

/** Draw the block as an outline again. Its view and columns stay, as ordinary
 *  children, so turning it back into a table restores them. */
export const showTableAsOutline = (repo: Repo, blockId: string): Promise<void> => repo.tx(
  tx => repo.removeTypeInTx(tx, blockId, TABLE_TYPE),
  {scope: ChangeScope.BlockDefault, description: 'show table as outline'},
)
