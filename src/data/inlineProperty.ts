import type {Block} from './block'
import {memberCodecOf, scopePoliciesEquivalent, PropertySchemaScopeMismatchError, type Tx, type AnyPropertySchema, type AnyResolvedPropertySchema} from './api'
import {encodedToValueChildContent, isFieldValueChild, scalarValueRow, valueChildContentToEncoded} from './propertyChildren'
import {storedPropertyValue} from './rowProperty'
import {keyBetween} from './orderKey'
import {FIELD_FORM_MARKER} from './referenceBlock'
import {upsertFieldRow} from './internals/propertyChildrenProcessor'

/** Expected fields follow existing children; both rendering and commit use this placement. */
export const expectedPropertyPosition = (childCount: number): number => childCount

export interface InlinePropertySelection {
  schema: AnyResolvedPropertySchema
  orderKey?: string
  fieldRowId?: string
  valueId?: string
}

const resolveInlineSchema = async (tx: Tx, ownerId: string, schema: AnyPropertySchema): Promise<AnyResolvedPropertySchema> => {
  const resolved = await tx.resolvePropertySchema(ownerId, schema) as AnyResolvedPropertySchema
  if (!scopePoliciesEquivalent(schema.changeScope, resolved.changeScope)) {
    throw new PropertySchemaScopeMismatchError(schema.name, schema.changeScope, resolved.changeScope)
  }
  return resolved
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
    const resolved = await resolveInlineSchema(tx, owner.id, schema)
    const field = (await tx.childrenOf(owner.id)).find(row => row.isFieldForm && row.referenceTargetId === resolved.fieldId)
    const values = field ? (await tx.childrenOf(field.id)).filter(isFieldValueChild) : []
    const value = memberCodecOf(resolved.codec) ? undefined : scalarValueRow(resolved, values) ?? values[0]
    if (!field && storedPropertyValue(parent.properties, resolved.name) !== undefined) {
      throw new Error('This property has a stored value awaiting its field row. Open the property panel to inspect it.')
    }
    if (scaffold) await tx.delete(scaffold.id)
    return {schema: resolved, orderKey: scaffold?.orderKey, fieldRowId: field?.id, valueId: value?.id}
  }, {scope: schema.changeScope, description: 'Choose inline property'})
}

/** Scalars use the typed writer; list appends add one row and project the cell.
 * A stored list cell can lag its live members and must never drive an append. */
export const commitInlineProperty = async (
  owner: Block, selection: InlinePropertySelection, content: string,
): Promise<{fieldRowId: string; valueId: string} | null> => {
  if (content === '') return null
  if (owner.repo.isReadOnly) throw new Error('This workspace is read-only.')
  return owner.repo.tx(async tx => {
    const parent = await tx.get(owner.id)
    if (!parent || parent.deleted || !await tx.isPropertyChildBackedWorkspace(parent.workspaceId)) {
      throw new Error('This block no longer supports properties in the outline.')
    }
    const schema = await resolveInlineSchema(tx, owner.id, selection.schema)
    const member = memberCodecOf(schema.codec)
    let value: unknown
    try {
      value = (member ?? schema.codec).decode(valueChildContentToEncoded(schema, content))
    } catch (cause) {
      throw new Error(`Enter a valid value for ${schema.name}. Your draft was kept.`, {cause})
    }
    const ownerChildren = await tx.childrenOf(owner.id)
    const before = ownerChildren.filter(row => row.isFieldForm && row.referenceTargetId === schema.fieldId)
    const previousValues = (await Promise.all(before.map(row => tx.childrenOf(row.id)))).flat().filter(isFieldValueChild)
    if (!member && (previousValues.length || storedPropertyValue(parent.properties, schema.name) !== undefined)) {
      throw new Error('This property now has a value. Edit its existing row instead.')
    }
    let field: {id: string; workspaceId: string}
    let valueId: string
    if (member) {
      field = before.at(-1) ?? await upsertFieldRow(tx, parent, schema.fieldId, [])
      const siblings = await tx.childrenOf(field.id)
      const content = encodedToValueChildContent(schema, member.encode(value))
      valueId = await tx.create({workspaceId: parent.workspaceId, parentId: field.id,
        orderKey: keyBetween(siblings.at(-1)?.orderKey ?? null, null), content,
        references: tx.derivedReferencesFor(content)})
    } else {
      await tx.setProperty(owner.id, schema, value)
      field = (await tx.childrenOf(owner.id)).find(row => row.isFieldForm && row.referenceTargetId === schema.fieldId)!
      valueId = (await tx.childrenOf(field.id)).filter(isFieldValueChild).at(-1)!.id
    }
    if (!before.length) {
      const desired = selection.orderKey
      const next = desired === undefined ? -1 : ownerChildren.findIndex(row => row.orderKey > desired)
      const at = next < 0 ? expectedPropertyPosition(ownerChildren.length) : next
      const orderKey = desired !== undefined && !ownerChildren.some(row => row.orderKey === desired)
        ? desired : keyBetween(ownerChildren[at - 1]?.orderKey ?? null, ownerChildren[at]?.orderKey ?? null)
      await tx.move(field.id, {parentId: owner.id, orderKey})
    }
    return {fieldRowId: field.id, valueId}
  }, {scope: selection.schema.changeScope, description: 'Set inline property'})
}
