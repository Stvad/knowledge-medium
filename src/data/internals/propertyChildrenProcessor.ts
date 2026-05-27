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
): Promise<void> => {
  if (row.deleted) return
  if (names.length === 0) return

  const children = await tx.childrenOf(row.id, undefined, {includePropertyChildren: true})

  for (const name of names) {
    const schema = propertySchemas.get(name)
    if (!schema) continue
    const matchingChildren = fieldRowsForSchema(children, schema)
    const encoded = hasOwn(row.properties, name) ? row.properties[name] : undefined

    if (encoded === undefined) {
      for (const child of matchingChildren) {
        await deleteSubtree(tx, child.id)
      }
      continue
    }

    try {
      schema.codec.decode(encoded)
    } catch {
      continue
    }

    const content = encodedPropertyValueToChildContent(schema, encoded)
    const [primary, ...duplicates] = matchingChildren
    if (primary) {
      const fieldContent = propertyFieldContent(schema)
      if (primary.content !== fieldContent) {
        await tx.update(primary.id, {content: fieldContent})
      }
      const values = await tx.childrenOf(primary.id, undefined, {includePropertyChildren: true})
      const [primaryValue, ...duplicateValues] = values
      if (primaryValue) {
        if (primaryValue.content !== content) {
          await tx.update(primaryValue.id, {content})
        }
      } else {
        await tx.create({
          workspaceId: row.workspaceId,
          parentId: primary.id,
          orderKey: keyAtStart(null),
          content,
        })
      }
      for (const duplicate of duplicateValues) {
        await deleteSubtree(tx, duplicate.id)
      }
    } else {
      const fieldRowId = await tx.create({
        workspaceId: row.workspaceId,
        parentId: row.id,
        referenceTargetId: schema.fieldId,
        orderKey: keyAtStart(null),
        content: propertyFieldContent(schema),
      })
      await tx.create({
        workspaceId: row.workspaceId,
        parentId: fieldRowId,
        orderKey: keyAtStart(null),
        content,
      })
    }

    for (const child of duplicates) {
      await deleteSubtree(tx, child.id)
    }
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

const deleteSubtree = async (tx: Tx, id: string): Promise<void> => {
  const children = await tx.childrenOf(id, undefined, {includePropertyChildren: true})
  for (const child of children) {
    await deleteSubtree(tx, child.id)
  }
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
