import type {Block} from './block'
import {memberCodecOf, scopePoliciesEquivalent, PropertySchemaScopeMismatchError, type Tx, type AnyPropertySchema, type AnyResolvedPropertySchema, type BlockData} from './api'
import {fieldValueChildren, propertyFieldContent, scalarValueRow, memberKeysFor} from './propertyChildren'
import {storedPropertyValue} from './rowProperty'
import {keyBetween} from './orderKey'
import type {PropertyChildSlot} from './derivedIds'
import {mintPropertyChildRow} from './internals/propertyChildMint'

const fieldContext = async (tx: Tx, owner: Block, requested: AnyPropertySchema) => {
  const parent = await tx.get(owner.id)
  if (!parent || parent.deleted || !await tx.isPropertyChildBackedWorkspace(parent.workspaceId)) {
    throw new Error('This block no longer supports properties in the outline.')
  }
  const schema = await tx.resolvePropertySchema(owner.id, requested) as AnyResolvedPropertySchema
  if (!scopePoliciesEquivalent(requested.changeScope, schema.changeScope)) {
    throw new PropertySchemaScopeMismatchError(schema.name, requested.changeScope, schema.changeScope)
  }
  const fields = (await tx.childrenOf(owner.id)).filter(row => row.isFieldForm && row.referenceTargetId === schema.fieldId)
  if (!fields.length && storedPropertyValue(parent.properties, schema.name) !== undefined) {
    throw new Error('This property has a stored value awaiting its field row. Open the property panel to inspect it.')
  }
  const field = memberCodecOf(schema.codec) ? fields.at(-1) : fields[0]
  const values = field ? await fieldValueChildren(tx, field.id) : []
  return {parent, schema, field, values}
}

/** Convert in place; an existing field consumes only the verified scaffold. */
export const choosePropertyField = async (owner: Block, schema: AnyPropertySchema, source: Block, content = '::', isCurrent = () => true) => {
  if (owner.repo.isReadOnly) throw new Error('This workspace is read-only.')
  return owner.repo.tx(async tx => {
    const context = await fieldContext(tx, owner, schema)
    const scaffold = await tx.get(source.id)
    if (!scaffold || scaffold.deleted || scaffold.parentId !== owner.id || scaffold.content !== content ||
      Object.keys(scaffold.properties).length > 0 || await tx.hasChildren(source.id)) {
      throw new Error('The input block changed. Your text was kept; type :: in an empty child to try again.')
    }
    if (!isCurrent()) throw new Error('The input block changed. Your text was kept.')
    const {field, values, schema: resolved} = context
    if (field) await tx.delete(scaffold.id)
    else await tx.update(scaffold.id, {content: propertyFieldContent(resolved.fieldId)})
    const value = memberCodecOf(resolved.codec) ? undefined : scalarValueRow(resolved, values) ?? values[0]
    return {schema: resolved, fieldRowId: field?.id ?? scaffold.id, valueId: value?.id}
  }, {scope: schema.changeScope, description: 'Choose property field'})
}

/** Both ghost fields and new members appear after the parent's existing children. */
const appendPropertyRow = async (tx: Tx, parent: Pick<BlockData, 'id' | 'workspaceId'>, content: string, slot: PropertyChildSlot) => {
  const siblings = await tx.childrenOf(parent.id)
  return mintPropertyChildRow(tx, {workspaceId: parent.workspaceId, parentId: parent.id,
    orderKey: keyBetween(siblings.at(-1)?.orderKey ?? null, null), content,
    references: tx.derivedReferencesFor(content)}, slot)
}

/** First input is raw block text, including undecodable text. Never rewrite a list cell to append. */
export const insertPropertyValue = async (owner: Block, requested: AnyPropertySchema, content: string) => {
  if (content === '') return null
  if (owner.repo.isReadOnly) throw new Error('This workspace is read-only.')
  return owner.repo.tx(async tx => {
    const {parent, schema, field: existing, values} = await fieldContext(tx, owner, requested)
    if (!memberCodecOf(schema.codec) && values.length) throw new Error('This property now has a value. Edit its existing row instead.')
    const field = existing ?? {workspaceId: parent.workspaceId, id: await appendPropertyRow(tx, parent, propertyFieldContent(schema.fieldId), {kind: 'field', fieldId: schema.fieldId})}
    const keys = memberKeysFor(schema)
    const valueKey = keys.content(content)
    const valueId = await appendPropertyRow(tx, field, content, {kind: 'value', valueKey, occurrence: values.filter(row => keys.row(row).key === valueKey).length})
    return {fieldRowId: field.id, valueId}
  }, {scope: requested.changeScope, description: 'Enter property value'})
}
