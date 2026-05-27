import {
  defineSameTxProcessor,
  type AnyPropertySchema,
  type BlockData,
  type Tx,
} from '@/data/api'
import {
  findSchemaByFieldBlockId,
  getPropertyFieldId,
  propertiesEqual,
  propertyChildContentToEncodedValue,
} from '@/data/propertyChildren'

export const PROJECT_PROPERTY_CHILDREN_PROCESSOR_NAME = 'core.projectPropertyChildren'

interface AffectedProjection {
  readonly parentId: string
  readonly fieldBlockId: string
}

const affectedKey = (affected: AffectedProjection): string =>
  `${affected.parentId}\u0000${affected.fieldBlockId}`

const collectAffectedProjection = (
  out: Map<string, AffectedProjection>,
  row: BlockData | null,
): void => {
  if (row === null) return
  if (row.parentId === null) return
  const fieldBlockId = getPropertyFieldId(row)
  if (fieldBlockId === undefined) return
  const affected = {parentId: row.parentId, fieldBlockId}
  out.set(affectedKey(affected), affected)
}

const firstProjectedChildValue = (
  schema: AnyPropertySchema,
  children: readonly BlockData[],
): unknown | undefined => {
  for (const child of children) {
    if (getPropertyFieldId(child) !== schema.fieldBlockId) continue
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
  const schema = findSchemaByFieldBlockId(propertySchemas, affected.fieldBlockId)
  if (!schema) return

  const parent = await tx.get(affected.parentId)
  if (parent === null || parent.deleted) return

  const children = await tx.childrenOf(affected.parentId)
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

export const PROJECT_PROPERTY_CHILDREN_PROCESSOR = defineSameTxProcessor({
  name: PROJECT_PROPERTY_CHILDREN_PROCESSOR_NAME,
  watches: {kind: 'field', table: 'blocks', fields: ['content', 'properties', 'parentId', 'orderKey', 'deleted']},
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
