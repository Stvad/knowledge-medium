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
  getPropertyFieldId,
  propertiesEqual,
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

const collectAffectedProjection = (
  out: Map<string, AffectedProjection>,
  row: BlockData | null,
): void => {
  if (row === null) return
  if (row.parentId === null) return
  const fieldId = getPropertyFieldId(row)
  if (fieldId === undefined) return
  const affected = {parentId: row.parentId, fieldId}
  out.set(affectedKey(affected), affected)
}

const firstProjectedChildValue = (
  schema: AnyPropertySchema,
  children: readonly BlockData[],
): unknown | undefined => {
  for (const child of children) {
    if (getPropertyFieldId(child) !== schema.fieldId) continue
    try {
      return propertyChildContentToEncodedValue(schema, child.content)
    } catch {
      // Invalid child text should not preserve a stale parent cache
      // projection. Skip it; if no child under this field parses, the
      // parent property is removed below.
    }
  }
  return undefined
}

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
  const projected = firstProjectedChildValue(schema, children)
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

const materializePropertiesForRow = async (
  tx: Tx,
  row: {before: BlockData | null; after: BlockData | null},
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
): Promise<void> => {
  if (row.after === null || row.after.deleted) return
  const changedNames = changedPropertyNames(row.before?.properties ?? {}, row.after.properties)
  if (changedNames.length === 0) return

  const children = await tx.childrenOf(row.after.id, undefined, {includePropertyChildren: true})

  for (const name of changedNames) {
    const schema = propertySchemas.get(name)
    if (!schema) continue
    const matchingChildren = children.filter(child => getPropertyFieldId(child) === schema.fieldId)
    const encoded = hasOwn(row.after.properties, name) ? row.after.properties[name] : undefined

    if (encoded === undefined) {
      for (const child of matchingChildren) {
        await tx.delete(child.id)
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
      if (primary.content !== content) {
        await tx.update(primary.id, {content})
      }
    } else {
      await tx.create({
        workspaceId: row.after.workspaceId,
        parentId: row.after.id,
        fieldId: schema.fieldId,
        orderKey: keyAtStart(null),
        content,
      })
    }

    for (const child of duplicates) {
      await tx.delete(child.id)
    }
  }
}

export const MATERIALIZE_PROPERTY_CHILDREN_PROCESSOR = defineSameTxProcessor({
  name: MATERIALIZE_PROPERTY_CHILDREN_PROCESSOR_NAME,
  watches: {kind: 'field', table: 'blocks', fields: ['properties']},
  apply: async (event, ctx) => {
    for (const row of event.changedRows) {
      await materializePropertiesForRow(ctx.tx, row, ctx.propertySchemas)
    }
  },
})

export const PROJECT_PROPERTY_CHILDREN_PROCESSOR = defineSameTxProcessor({
  name: PROJECT_PROPERTY_CHILDREN_PROCESSOR_NAME,
  watches: {kind: 'field', table: 'blocks', fields: ['content', 'fieldId', 'parentId', 'orderKey', 'deleted']},
  apply: async (event, ctx) => {
    const affected = new Map<string, AffectedProjection>()
    for (const row of event.changedRows) {
      collectAffectedProjection(affected, row.before)
      collectAffectedProjection(affected, row.after)
    }
    for (const projection of affected.values()) {
      await reprojectParentField(ctx.tx, projection, ctx.propertySchemas)
    }
  },
})
