import type {Block} from '@/data/block'
import {ChangeScope, memberCodecOf, type AnyPropertySchema} from '@/data/api'
import {isResolvedPropertySchema} from '@/data/internals/propertySchemaResolution'
import {isFieldValueChild, scalarValueRow} from '@/data/propertyChildren'
import {keyAtEnd} from '@/data/orderKey'
import {FIELD_FORM_MARKER, referenceBlockContentForId} from '@/data/referenceBlock'

export interface InlinePropertyTarget {
  readonly fieldId: string
  readonly valueId: string
}

/** Convert a typed scaffold, or add a field directly. Existing scalar values
 * are navigation targets; a list receives a new member without replacing any. */
export const createInlineProperty = async (
  owner: Block,
  schema: AnyPropertySchema,
  source?: Block,
): Promise<InlinePropertyTarget | null> => {
  const repo = owner.repo
  const ownerData = await owner.load()
  if (repo.isReadOnly || !ownerData) return null
  return repo.tx(async tx => {
    const parent = await tx.get(owner.id)
    if (!parent || parent.deleted || parent.workspaceId !== ownerData.workspaceId ||
      !await tx.isPropertyChildBackedWorkspace(parent.workspaceId)) return null
    const scaffold = source ? await tx.get(source.id) : null
    if (source && (!scaffold || scaffold.deleted || scaffold.parentId !== owner.id ||
      scaffold.content !== FIELD_FORM_MARKER || Object.keys(scaffold.properties).length > 0 ||
      await tx.hasChildren(source.id))) return null

    const resolved = await tx.resolvePropertySchema(owner.id, schema)
    if (!isResolvedPropertySchema(resolved)) throw new Error('Property definition is unavailable')
    const children = await tx.childrenOf(owner.id)
    let field = children.find(row => row.isFieldForm && row.referenceTargetId === resolved.fieldId)
    if (field) {
      const values = (await tx.childrenOf(field.id)).filter(isFieldValueChild)
      if (!memberCodecOf(resolved.codec)) {
        const existing = scalarValueRow(resolved, values)
        if (existing) return {fieldId: field.id, valueId: existing.id}
      }
    } else {
      const content = FIELD_FORM_MARKER + referenceBlockContentForId(resolved.fieldId)
      if (scaffold) {
        await tx.update(scaffold.id, {content, referenceTargetId: resolved.fieldId, isFieldForm: true})
        field = {...scaffold, content, referenceTargetId: resolved.fieldId, isFieldForm: true}
      } else {
        const id = await tx.create({workspaceId: parent.workspaceId, parentId: owner.id,
          orderKey: keyAtEnd(children.at(-1)?.orderKey), content,
          referenceTargetId: resolved.fieldId, isFieldForm: true})
        field = (await tx.get(id))!
      }
    }
    const values = await tx.childrenOf(field.id)
    const valueId = await tx.create({workspaceId: parent.workspaceId, parentId: field.id,
      orderKey: keyAtEnd(values.at(-1)?.orderKey), content: ''})
    return {fieldId: field.id, valueId}
  }, {scope: ChangeScope.BlockDefault, description: 'Create inline property'})
}
