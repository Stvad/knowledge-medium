import type {Block} from './block'
import {ChangeScope, memberCodecOf, type AnyPropertySchema, type AnyResolvedPropertySchema} from './api'
import {isFieldValueChild, scalarValueRow, valueChildContentToEncoded} from './propertyChildren'
import {storedPropertyValue} from './rowProperty'
import {keyBetween} from './orderKey'
import {FIELD_FORM_MARKER} from './referenceBlock'

/** Expected fields follow existing children; both rendering and commit use this placement. */
export const expectedPropertyPosition = (childCount: number): number => childCount

export interface InlinePropertySelection {
  schema: AnyResolvedPropertySchema
  orderKey?: string
  fieldRowId?: string
  valueId?: string
}

/** Remove only a verified empty scaffold. Selecting a schema never writes a value. */
export const selectInlineProperty = async (
  owner: Block, schema: AnyPropertySchema, source?: Block,
): Promise<InlinePropertySelection> => {
  if (owner.repo.isReadOnly) throw new Error('This workspace is read-only.')
  return owner.repo.tx(async tx => {
    const parent = await tx.get(owner.id)
    if (!parent || parent.deleted || !await tx.isPropertyChildBackedWorkspace(parent.workspaceId)) {
      throw new Error('This block no longer supports properties in the outline.')
    }
    const scaffold = source ? await tx.get(source.id) : null
    if (source && (!scaffold || scaffold.deleted || scaffold.parentId !== owner.id ||
      scaffold.content !== FIELD_FORM_MARKER || Object.keys(scaffold.properties).length > 0 ||
      await tx.hasChildren(source.id))) {
      throw new Error('The input block changed. Your text was kept; type :: in an empty child to try again.')
    }
    const resolved = await tx.resolvePropertySchema(owner.id, schema) as AnyResolvedPropertySchema
    const field = (await tx.childrenOf(owner.id)).find(row => row.isFieldForm && row.referenceTargetId === resolved.fieldId)
    const values = field ? (await tx.childrenOf(field.id)).filter(isFieldValueChild) : []
    const value = memberCodecOf(resolved.codec) ? undefined : scalarValueRow(resolved, values) ?? values[0]
    if (!field && storedPropertyValue(parent.properties, resolved.name) !== undefined) {
      throw new Error('This property has a stored value awaiting its field row. Open the property panel to inspect it.')
    }
    if (scaffold) await tx.delete(scaffold.id)
    return {schema: resolved, orderKey: scaffold?.orderKey, fieldRowId: field?.id, valueId: value?.id}
  }, {scope: ChangeScope.BlockDefault, description: 'Choose inline property'})
}

/** Commit a draft through the ordinary typed writer, including list append.
 * The writer owns canonical field/value rows, reference prefill and undo. */
export const commitInlineProperty = async (
  owner: Block, selection: InlinePropertySelection, content: string,
): Promise<{fieldRowId: string; valueId: string} | null> => {
  if (content.trim() === '') return null
  if (owner.repo.isReadOnly) throw new Error('This workspace is read-only.')
  const {schema} = selection
  const member = memberCodecOf(schema.codec)
  const encoded = valueChildContentToEncoded(schema, content)
  const value = (member ?? schema.codec).decode(encoded)
  return owner.repo.tx(async tx => {
    const parent = await tx.get(owner.id)
    if (!parent || parent.deleted || !await tx.isPropertyChildBackedWorkspace(parent.workspaceId)) {
      throw new Error('This block no longer supports properties in the outline.')
    }
    const ownerChildren = await tx.childrenOf(owner.id)
    const before = ownerChildren.filter(row => row.isFieldForm && row.referenceTargetId === schema.fieldId)
    if (!member && (before.length || storedPropertyValue(parent.properties, schema.name) !== undefined)) {
      throw new Error('This property now has a value. Edit its existing row instead.')
    }
    const oldIds = new Set(before.length ? (await tx.childrenOf(before[0].id)).map(row => row.id) : [])
    await tx.setProperty(owner.id, schema, member
      ? (current: unknown) => [...(Array.isArray(current) ? current : []), value]
      : value)
    const field = (await tx.childrenOf(owner.id)).find(row => row.isFieldForm && row.referenceTargetId === schema.fieldId)!
    if (!before.length) {
      const at = expectedPropertyPosition(ownerChildren.length)
      const orderKey = selection.orderKey ?? keyBetween(ownerChildren[at - 1]?.orderKey ?? null, ownerChildren[at]?.orderKey ?? null)
      await tx.move(field.id, {parentId: owner.id, orderKey})
    }
    const values = (await tx.childrenOf(field.id)).filter(isFieldValueChild)
    const target = values.find(row => !oldIds.has(row.id)) ?? values.at(-1)!
    return {fieldRowId: field.id, valueId: target.id}
  }, {scope: schema.changeScope, description: 'Set inline property'})
}
