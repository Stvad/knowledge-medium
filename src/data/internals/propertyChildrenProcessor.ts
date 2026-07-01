import {
  defineSameTxProcessor,
  type AnyPropertySchema,
  type BlockData,
  type Tx,
} from '@/data/api'
import { keyAtStart } from '@/data/orderKey'
import {
  encodedPropertyValueToChildContent,
  findSchemaByFieldId,
  getPropertyFieldTargetId,
  propertiesEqual,
  propertyFieldContent,
  propertyChildContentToEncodedValue,
} from '@/data/propertyChildren'

export const MATERIALIZE_PROPERTY_CHILDREN_PROCESSOR_NAME = 'core.materializePropertyChildren'
export const PROJECT_PROPERTY_CHILDREN_PROCESSOR_NAME = 'core.projectPropertyChildren'

export interface PropertyChildrenMaterializationStats {
  rowsVisited: number
  rowsSkippedDeleted: number
  rowsWithoutCandidateProperties: number
  liveParentBatchReads: number
  existingFieldBatchReads: number
  parentChildrenReads: number
  bulkParents: number
  fallbackParents: number
  bulkRowsInserted: number
  bulkInsertStatements: number
  propertiesConsidered: number
  propertiesSkippedMissingSchema: number
  propertiesSkippedInvalidValue: number
  propertiesRemoved: number
  propertiesMaterialized: number
  existingFieldRows: number
  duplicateFieldRows: number
  fieldRowsCreated: number
  fieldRowsUpdated: number
  valueChildrenReads: number
  existingValueRows: number
  duplicateValueRows: number
  valueRowsCreated: number
  valueRowsUpdated: number
  deleteSubtreeCalls: number
  rowsDeleted: number
}

export const createPropertyChildrenMaterializationStats = (): PropertyChildrenMaterializationStats => ({
  rowsVisited: 0,
  rowsSkippedDeleted: 0,
  rowsWithoutCandidateProperties: 0,
  liveParentBatchReads: 0,
  existingFieldBatchReads: 0,
  parentChildrenReads: 0,
  bulkParents: 0,
  fallbackParents: 0,
  bulkRowsInserted: 0,
  bulkInsertStatements: 0,
  propertiesConsidered: 0,
  propertiesSkippedMissingSchema: 0,
  propertiesSkippedInvalidValue: 0,
  propertiesRemoved: 0,
  propertiesMaterialized: 0,
  existingFieldRows: 0,
  duplicateFieldRows: 0,
  fieldRowsCreated: 0,
  fieldRowsUpdated: 0,
  valueChildrenReads: 0,
  existingValueRows: 0,
  duplicateValueRows: 0,
  valueRowsCreated: 0,
  valueRowsUpdated: 0,
  deleteSubtreeCalls: 0,
  rowsDeleted: 0,
})

const addMaterializationStat = (
  stats: PropertyChildrenMaterializationStats | undefined,
  key: keyof PropertyChildrenMaterializationStats,
  amount = 1,
): void => {
  if (!stats) return
  stats[key] += amount
}

interface AffectedProjection {
  readonly parentId: string
  readonly fieldId: string
}

const affectedKey = (affected: AffectedProjection): string =>
  `${affected.parentId}\u0000${affected.fieldId}`

const addAffectedProjection = (
  out: Map<string, AffectedProjection>,
  parentId: string | null,
  fieldId: string | undefined,
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
): void => {
  if (parentId === null) return
  if (fieldId === undefined) return
  if (!findSchemaByFieldId(propertySchemas, fieldId)) return
  const affected = {parentId, fieldId}
  out.set(affectedKey(affected), affected)
}

const collectAffectedProjection = async (
  tx: Tx,
  out: Map<string, AffectedProjection>,
  row: BlockData | null,
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
): Promise<void> => {
  if (row === null) return
  addAffectedProjection(out, row.parentId, getPropertyFieldTargetId(row), propertySchemas)

  if (row.parentId === null) return
  const parent = await tx.get(row.parentId)
  if (parent === null || parent.parentId === null) return
  addAffectedProjection(out, parent.parentId, getPropertyFieldTargetId(parent), propertySchemas)
}

const firstProjectedFieldValue = async (
  tx: Tx,
  schema: AnyPropertySchema,
  fieldRows: readonly BlockData[],
): Promise<unknown | undefined> => {
  for (const fieldRow of fieldRows) {
    const values = await tx.childrenOf(fieldRow.id, undefined, {includePropertyChildren: true})
    for (const value of values) {
      try {
        return propertyChildContentToEncodedValue(schema, value.content)
      } catch {
        // Invalid child text should not preserve a stale parent cache
        // projection. Skip it; if no child under this field parses, the
        // parent property is removed below.
      }
    }
  }
  return undefined
}

const fieldRowsForSchema = (
  children: readonly BlockData[],
  schema: AnyPropertySchema,
): BlockData[] => children.filter(child => getPropertyFieldTargetId(child) === schema.fieldId)

const reprojectParentField = async (
  tx: Tx,
  affected: AffectedProjection,
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
): Promise<void> => {
  const schema = findSchemaByFieldId(propertySchemas, affected.fieldId)
  if (!schema) return

  const parent = await tx.get(affected.parentId)
  if (parent === null || parent.deleted) return

  const children = await tx.childrenOf(affected.parentId, undefined, {includePropertyChildren: true})
  const projected = await firstProjectedFieldValue(tx, schema, fieldRowsForSchema(children, schema))
  const nextProperties = {...parent.properties}
  if (projected === undefined) {
    delete nextProperties[schema.name]
  } else {
    nextProperties[schema.name] = projected
  }
  if (propertiesEqual(parent.properties, nextProperties)) return
  await tx.update(parent.id, {properties: nextProperties}, {skipMetadata: true})
}

const hasOwn = (properties: Record<string, unknown>, name: string): boolean =>
  Object.prototype.hasOwnProperty.call(properties, name)

const encodedEqual = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b)

const changedPropertyNames = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] => {
  const names = new Set([...Object.keys(before), ...Object.keys(after)])
  const changed: string[] = []
  for (const name of names) {
    const beforeValue = hasOwn(before, name) ? before[name] : undefined
    const afterValue = hasOwn(after, name) ? after[name] : undefined
    if (!encodedEqual(beforeValue, afterValue)) changed.push(name)
  }
  return changed
}

export const materializePropertyChildrenForExistingRow = async (
  tx: Tx,
  row: BlockData,
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
  names: readonly string[] = Object.keys(row.properties),
  stats?: PropertyChildrenMaterializationStats,
): Promise<void> => {
  addMaterializationStat(stats, 'rowsVisited')
  if (row.deleted) {
    addMaterializationStat(stats, 'rowsSkippedDeleted')
    return
  }
  if (names.length === 0) {
    addMaterializationStat(stats, 'rowsWithoutCandidateProperties')
    return
  }

  addMaterializationStat(stats, 'parentChildrenReads')
  const children = await tx.childrenOf(row.id, undefined, {includePropertyChildren: true})

  for (const name of names) {
    addMaterializationStat(stats, 'propertiesConsidered')
    const schema = propertySchemas.get(name)
    if (!schema) {
      addMaterializationStat(stats, 'propertiesSkippedMissingSchema')
      continue
    }
    const matchingChildren = fieldRowsForSchema(children, schema)
    const encoded = hasOwn(row.properties, name) ? row.properties[name] : undefined
    if (matchingChildren.length > 0) {
      if (stats) {
        stats.existingFieldRows++
        stats.duplicateFieldRows += Math.max(0, matchingChildren.length - 1)
      }
    }

    if (encoded === undefined) {
      addMaterializationStat(stats, 'propertiesRemoved')
      for (const child of matchingChildren) {
        await deleteSubtree(tx, child.id, stats)
      }
      continue
    }

    try {
      schema.codec.decode(encoded)
    } catch {
      addMaterializationStat(stats, 'propertiesSkippedInvalidValue')
      continue
    }
    addMaterializationStat(stats, 'propertiesMaterialized')

    const content = encodedPropertyValueToChildContent(schema, encoded)
    const [primary, ...duplicates] = matchingChildren
    if (primary) {
      const fieldContent = propertyFieldContent(schema)
      if (primary.content !== fieldContent) {
        addMaterializationStat(stats, 'fieldRowsUpdated')
        await tx.update(primary.id, {content: fieldContent})
      }
      addMaterializationStat(stats, 'valueChildrenReads')
      const values = await tx.childrenOf(primary.id, undefined, {includePropertyChildren: true})
      const [primaryValue, ...duplicateValues] = values
      if (primaryValue) addMaterializationStat(stats, 'existingValueRows')
      if (stats) stats.duplicateValueRows += duplicateValues.length
      if (primaryValue) {
        if (primaryValue.content !== content) {
          addMaterializationStat(stats, 'valueRowsUpdated')
          await tx.update(primaryValue.id, {content})
        }
      } else {
        addMaterializationStat(stats, 'valueRowsCreated')
        await tx.create({
          workspaceId: row.workspaceId,
          parentId: primary.id,
          orderKey: keyAtStart(null),
          content,
        })
      }
      for (const duplicate of duplicateValues) {
        await deleteSubtree(tx, duplicate.id, stats)
      }
    } else {
      addMaterializationStat(stats, 'fieldRowsCreated')
      const fieldRowId = await tx.create({
        workspaceId: row.workspaceId,
        parentId: row.id,
        referenceTargetId: schema.fieldId,
        orderKey: keyAtStart(null),
        content: propertyFieldContent(schema),
      })
      addMaterializationStat(stats, 'valueRowsCreated')
      await tx.create({
        workspaceId: row.workspaceId,
        parentId: fieldRowId,
        orderKey: keyAtStart(null),
        content,
      })
    }

    for (const child of duplicates) {
      await deleteSubtree(tx, child.id, stats)
    }
  }
}

export const materializePropertyFieldSlotsForExistingRow = async (
  tx: Tx,
  row: BlockData,
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
  names: readonly string[],
): Promise<void> => {
  if (row.deleted) return
  if (names.length === 0) return

  const children = await tx.childrenOf(row.id, undefined, {includePropertyChildren: true})
  const existingFieldIds = new Set(
    children.map(child => getPropertyFieldTargetId(child)).filter((id): id is string => id !== undefined),
  )

  for (const name of names) {
    const schema = propertySchemas.get(name)
    if (!schema) continue
    if (existingFieldIds.has(schema.fieldId)) continue

    // If the block already holds a value for this property, we MUST materialize
    // it as the field's value child. A bare (empty) field slot would let the
    // same-tx reverse projection strip the still-present parent property value
    // (adding a type that declares an already-set property → silent data loss).
    const encoded = hasOwn(row.properties, name) ? row.properties[name] : undefined
    let valueContent: string | undefined
    if (encoded !== undefined) {
      try {
        schema.codec.decode(encoded)
        valueContent = encodedPropertyValueToChildContent(schema, encoded)
      } catch {
        // Undecodable stored value: leave it in properties_json untouched
        // rather than create an empty slot that would strip it. A later valid
        // edit re-runs the full materialization.
        continue
      }
    }

    const fieldRowId = await tx.create({
      workspaceId: row.workspaceId,
      parentId: row.id,
      referenceTargetId: schema.fieldId,
      orderKey: keyAtStart(null),
      content: propertyFieldContent(schema),
    })
    if (valueContent !== undefined) {
      await tx.create({
        workspaceId: row.workspaceId,
        parentId: fieldRowId,
        orderKey: keyAtStart(null),
        content: valueContent,
      })
    }
    existingFieldIds.add(schema.fieldId)
  }
}

const materializePropertiesForChangedRow = async (
  tx: Tx,
  row: {before: BlockData | null; after: BlockData | null},
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
): Promise<void> => {
  if (row.after === null || row.after.deleted) return
  const changedNames = changedPropertyNames(row.before?.properties ?? {}, row.after.properties)
  await materializePropertyChildrenForExistingRow(tx, row.after, propertySchemas, changedNames)
}

const deleteSubtree = async (
  tx: Tx,
  id: string,
  stats?: PropertyChildrenMaterializationStats,
): Promise<void> => {
  addMaterializationStat(stats, 'deleteSubtreeCalls')
  const children = await tx.childrenOf(id, undefined, {includePropertyChildren: true})
  for (const child of children) {
    await deleteSubtree(tx, child.id, stats)
  }
  addMaterializationStat(stats, 'rowsDeleted')
  await tx.delete(id)
}

export const MATERIALIZE_PROPERTY_CHILDREN_PROCESSOR = defineSameTxProcessor({
  name: MATERIALIZE_PROPERTY_CHILDREN_PROCESSOR_NAME,
  watches: {kind: 'field', table: 'blocks', fields: ['properties']},
  apply: async (event, ctx) => {
    for (const row of event.changedRows) {
      await materializePropertiesForChangedRow(ctx.tx, row, ctx.propertySchemas)
    }
  },
})

export const PROJECT_PROPERTY_CHILDREN_PROCESSOR = defineSameTxProcessor({
  name: PROJECT_PROPERTY_CHILDREN_PROCESSOR_NAME,
  watches: {kind: 'field', table: 'blocks', fields: ['content', 'referenceTargetId', 'parentId', 'orderKey', 'deleted']},
  apply: async (event, ctx) => {
    const affected = new Map<string, AffectedProjection>()
    for (const row of event.changedRows) {
      await collectAffectedProjection(ctx.tx, affected, row.before, ctx.propertySchemas)
      await collectAffectedProjection(ctx.tx, affected, row.after, ctx.propertySchemas)
    }
    for (const projection of affected.values()) {
      await reprojectParentField(ctx.tx, projection, ctx.propertySchemas)
    }
  },
})
