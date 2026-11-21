import { ChangeScope, propertyValue, type BlockData, type Tx } from '@/data/api'
import { isPropertyValueEditable } from '@/data/internals/propertyValueEdits'
import { repoFieldDefinitionTest } from '@/data/internals/propertySchemaResolution'
import { outlineSkippedFieldIds } from '@/data/propertyDefinitionRegistry'
import { isPropertyFieldInstance } from '@/data/propertyChildren'
import { hasBlockType } from '@/data/properties'
import type { Repo } from '@/data/repo'
import { createTypedChild } from '@/data/typedRecords'
import { ROW_CAP } from './model'
import { COLUMN_TYPE, TABLE_TYPE, VIEW_TYPE, columnFieldProp } from './schema'

/** The block-scoped properties the host's rows carry, in first-seen order,
 *  minus those the outline's default display hides (types, aliases). */
const rowFieldIds = async (repo: Repo, tx: Tx, host: BlockData, children: readonly BlockData[]) => {
  const isField = repoFieldDefinitionTest(repo, host.workspaceId)
  const definitions = repo.propertyDefinitions
  const skipped = definitions?.workspaceId === host.workspaceId ? outlineSkippedFieldIds(definitions) : new Set<string>()
  const fieldIds: string[] = []
  for (const row of children.slice(0, ROW_CAP)) {
    if (isPropertyFieldInstance(row, isField)) continue
    for (const child of await tx.childrenOf(row.id)) {
      const fieldId = child.referenceTargetId
      if (!fieldId || !isPropertyFieldInstance(child, isField) || fieldIds.includes(fieldId) || skipped.has(fieldId)) continue
      if (isPropertyValueEditable(tx.resolvePropertyFieldSchema(host.workspaceId, fieldId))) fieldIds.push(fieldId)
    }
  }
  return fieldIds
}

/** Tag the block as a table. A block with no view yet gets one, with a column
 *  for its rows' own text and one per property its rows carry now; later
 *  columns are added explicitly. Nothing moves: the children are the rows. */
export const turnIntoTable = (repo: Repo, blockId: string): Promise<void> => repo.tx(async tx => {
  const host = await tx.get(blockId)
  if (!host || host.deleted) return
  if (!hasBlockType(host, TABLE_TYPE)) await repo.addTypeInTx(tx, host.id, TABLE_TYPE)
  const children = await tx.childrenOf(host.id)
  if (children.some(child => hasBlockType(child, VIEW_TYPE))) return
  const fieldIds = await rowFieldIds(repo, tx, host, children)
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
