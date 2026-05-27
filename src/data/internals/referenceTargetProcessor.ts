import {
  defineSameTxProcessor,
  type AnyPropertySchema,
  type BlockData,
  type Tx,
} from '@/data/api'
import { propertyNameProp } from '@/data/properties'
import { findSchemaByFieldId } from '@/data/propertyChildren'
import { parseExactReferenceBlockContent } from '@/data/referenceBlock'

export const DERIVE_REFERENCE_TARGET_PROCESSOR_NAME = 'core.deriveReferenceTarget'

const fieldTargetForAlias = (
  alias: string,
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
): string | null => propertySchemas.get(alias)?.fieldId ?? null

const fieldTargetForBlockRef = async (
  tx: Tx,
  id: string,
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
): Promise<string | null> => {
  if (findSchemaByFieldId(propertySchemas, id)) return id

  const target = await tx.get(id)
  if (target === null || target.parentId === null) return null

  if (target.referenceTargetId === propertyNameProp.fieldId) {
    return target.parentId !== null && findSchemaByFieldId(propertySchemas, target.parentId)
      ? target.parentId
      : null
  }

  const parent = await tx.get(target.parentId)
  if (parent === null || parent.parentId === null) return null
  if (parent.referenceTargetId !== propertyNameProp.fieldId) return null

  return findSchemaByFieldId(propertySchemas, parent.parentId) ? parent.parentId : null
}

const deriveReferenceTargetId = async (
  tx: Tx,
  row: BlockData,
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
): Promise<string | null | undefined> => {
  const exact = parseExactReferenceBlockContent(row.content)
  if (!exact) return null
  if (exact.kind === 'blockRef') {
    return await fieldTargetForBlockRef(tx, exact.id, propertySchemas) ?? exact.id
  }

  const fieldTargetId = fieldTargetForAlias(exact.alias, propertySchemas)
  if (fieldTargetId !== null) return fieldTargetId

  const aliasedTarget = await tx.aliasLookup(exact.alias, row.workspaceId)
  return aliasedTarget?.id
}

export const DERIVE_REFERENCE_TARGET_PROCESSOR = defineSameTxProcessor({
  name: DERIVE_REFERENCE_TARGET_PROCESSOR_NAME,
  watches: {kind: 'field', table: 'blocks', fields: ['content']},
  apply: async (event, ctx) => {
    for (const changed of event.changedRows) {
      const row = changed.after
      if (row === null || row.deleted) continue
      const derivedTargetId = await deriveReferenceTargetId(ctx.tx, row, ctx.propertySchemas)
      const targetId = derivedTargetId === undefined && changed.before === null
        ? row.referenceTargetId
        : derivedTargetId ?? null
      if ((row.referenceTargetId ?? null) === targetId) continue
      await ctx.tx.update(row.id, {referenceTargetId: targetId}, {skipMetadata: true})
    }
  },
})
