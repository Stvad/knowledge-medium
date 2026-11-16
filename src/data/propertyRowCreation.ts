import {adoptOrCreatePropertySchema} from './propertySchemaCreation'
import type {Block} from './block'
import {memberCodecOf, scopePoliciesEquivalent, PropertySchemaScopeMismatchError, type Tx, type AnyPropertySchema, type AnyResolvedPropertySchema, type BlockData} from './api'
import {fieldValueChildren, propertyFieldContent, scalarValueRow} from './propertyChildren'
import {storedPropertyValue} from './rowProperty'

const fieldRowsFor = (rows: readonly BlockData[], fieldId: string) =>
  rows.filter(row => row.isFieldForm && row.referenceTargetId === fieldId)

const fieldContext = async (tx: Tx, owner: Block, requested: AnyPropertySchema) => {
  const parent = await tx.get(owner.id)
  if (!parent || parent.deleted || !await tx.isPropertyChildBackedWorkspace(parent.workspaceId)) {
    throw new Error('This block no longer supports properties in the outline.')
  }
  const schema = await tx.resolvePropertySchema(owner.id, requested) as AnyResolvedPropertySchema
  if (!scopePoliciesEquivalent(requested.changeScope, schema.changeScope)) {
    throw new PropertySchemaScopeMismatchError(schema.name, requested.changeScope, schema.changeScope)
  }
  const fields = fieldRowsFor(await tx.childrenOf(owner.id), schema.fieldId)
  if (!fields.length && storedPropertyValue(parent.properties, schema.name) !== undefined) {
    throw new Error('This property has a stored value awaiting its field row. Open the property panel to inspect it.')
  }
  const field = memberCodecOf(schema.codec) ? fields.at(-1) : fields[0]
  const values = field ? await fieldValueChildren(tx, field.id) : []
  return {parent, schema, field, values}
}

const validateScaffold = async (tx: Tx, owner: Block, source: Block, content: string, isCurrent: () => boolean) => {
  const scaffold = await tx.get(source.id)
  if (!scaffold || scaffold.deleted || scaffold.parentId !== owner.id || scaffold.content !== content ||
    Object.keys(scaffold.properties).length > 0 || await tx.hasChildren(source.id)) {
    throw new Error('The input block changed. Your text was kept; type :: in an empty child to try again.')
  }
  if (!isCurrent()) throw new Error('The input block changed. Your text was kept.')
}

/** Convert in place; an existing field consumes only the verified scaffold. */
export const choosePropertyField = async (owner: Block, schema: AnyPropertySchema, source: Block, content: string, isCurrent: () => boolean) => {
  if (owner.repo.isReadOnly) throw new Error('This workspace is read-only.')
  return owner.repo.tx(async tx => {
    const context = await fieldContext(tx, owner, schema)
    await validateScaffold(tx, owner, source, content, isCurrent)
    const {field, values, schema: resolved} = context
    if (field) await tx.delete(source.id)
    else await tx.update(source.id, {content: propertyFieldContent(resolved.fieldId)})
    const value = memberCodecOf(resolved.codec) ? undefined : scalarValueRow(resolved, values) ?? values[0]
    return {schema: resolved, fieldRowId: field?.id ?? source.id, valueId: value?.id}
  }, {scope: schema.changeScope, description: 'Choose property field'})
}

/** Definition and scaffold commit together; a refused conversion leaves no definition. */
export const createPropertyField = async (owner: Block, source: Block, name: string, presetId: string, content: string, isCurrent: () => boolean) => {
  if (owner.repo.isReadOnly) throw new Error('This workspace is read-only.')
  name = name.trim()
  const result = await adoptOrCreatePropertySchema(owner.repo, {name, presetId}, async (tx, fieldId) => {
    await validateScaffold(tx, owner, source, content, isCurrent)
    const parent = await tx.get(owner.id)
    if (!parent || parent.deleted || !await tx.isPropertyChildBackedWorkspace(parent.workspaceId) || storedPropertyValue(parent.properties, name) !== undefined) {
      throw new Error('This block no longer supports creating this property in the outline.')
    }
    await tx.update(source.id, {content: propertyFieldContent(fieldId)})
  })
  return result.kind === 'adopted'
    ? choosePropertyField(owner, result.schema, source, content, isCurrent)
    : {schema: result.schema, fieldRowId: source.id, valueId: undefined}
}
