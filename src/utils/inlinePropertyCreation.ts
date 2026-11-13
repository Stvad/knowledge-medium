import type {Block} from '@/data/block'
import {ChangeScope, memberCodecOf, type AnyPropertySchema, type AnyResolvedPropertySchema, type BlockData} from '@/data/api'
import {isFieldValueChild, scalarValueRow} from '@/data/propertyChildren'
import {storedPropertyValue} from '@/data/rowProperty'
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
  if (repo.isReadOnly) return null
  return repo.tx(async tx => {
    const parent = await tx.get(owner.id)
    if (!parent || parent.deleted ||
      !await tx.isPropertyChildBackedWorkspace(parent.workspaceId)) return null
    const scaffold = source ? await tx.get(source.id) : null
    if (source && (!scaffold || scaffold.deleted || scaffold.parentId !== owner.id ||
      scaffold.content !== FIELD_FORM_MARKER || Object.keys(scaffold.properties).length > 0 ||
      await tx.hasChildren(source.id))) return null

    // Child-backed resolution has already required durable field identity.
    const resolved = await tx.resolvePropertySchema(owner.id, schema) as AnyResolvedPropertySchema
    const children = await tx.childrenOf(owner.id)
    let field = children.find(row => row.isFieldForm && row.referenceTargetId === resolved.fieldId)
    let childrenOfField: BlockData[] = []
    if (field) {
      childrenOfField = await tx.childrenOf(field.id)
      const values = childrenOfField.filter(isFieldValueChild)
      if (!memberCodecOf(resolved.codec)) {
        const existing = scalarValueRow(resolved, values)
        if (existing) return {fieldId: field.id, valueId: existing.id}
      }
    } else {
      // A cell without children can still be awaiting materialization. Never
      // replace it with an empty value or resurrect intentionally deleted rows.
      if (storedPropertyValue(parent.properties, resolved.name) !== undefined) {
        throw new Error('This property has a stored value but no field row. Open the property panel to inspect it before creating an empty field.')
      }
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
    const valueId = await tx.create({workspaceId: parent.workspaceId, parentId: field.id,
      orderKey: keyAtEnd(childrenOfField.at(-1)?.orderKey), content: ''})
    return {fieldId: field.id, valueId}
  }, {scope: ChangeScope.BlockDefault, description: 'Create inline property'})
}
