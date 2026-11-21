import {adoptOrCreatePropertySchema} from './propertySchemaCreation'
import type {Block} from './block'
import {memberCodecOf, scopePoliciesEquivalent, PropertySchemaScopeMismatchError, type Tx, type AnyPropertySchema, type AnyResolvedPropertySchema} from './api'
import {materializePropertyField, openPropertyValue} from './internals/propertyValueEdits'
import {propertyFieldContent} from './propertyChildren'
import {storedPropertyValue} from './rowProperty'

const resolveChosenSchema = async (tx: Tx, owner: Block, requested: AnyPropertySchema) => {
  const schema = await tx.resolvePropertySchema(owner.id, requested) as AnyResolvedPropertySchema
  if (!scopePoliciesEquivalent(requested.changeScope, schema.changeScope)) {
    throw new PropertySchemaScopeMismatchError(schema.name, requested.changeScope, schema.changeScope)
  }
  return schema
}

const validateScaffold = async (tx: Tx, owner: Block, source: Block, content: string, isCurrent: () => boolean) => {
  const scaffold = await tx.get(source.id)
  if (!scaffold || scaffold.deleted || scaffold.parentId !== owner.id || scaffold.content !== content ||
    Object.keys(scaffold.properties).length > 0 || await tx.hasChildren(source.id)) {
    throw new Error('The input block changed. Your text was kept; type :: in an empty child to try again.')
  }
  if (!isCurrent()) throw new Error('The input block changed. Your text was kept.')
}

/** An absent property takes the scaffold as its field row. Otherwise the scaffold goes and the
 *  property's rows materialize as every property edit materializes them. A scalar then opens its
 *  value; a list returns no value, for the caller to append a member (opening would select its last). */
export const choosePropertyField = async (owner: Block, schema: AnyPropertySchema, source: Block, content: string, isCurrent: () => boolean) => {
  if (owner.repo.isReadOnly) throw new Error('This workspace is read-only.')
  return owner.repo.tx(async tx => {
    const resolved = await resolveChosenSchema(tx, owner, schema)
    const fieldRowId = await materializePropertyField(tx, owner.id, resolved.fieldId)
    await validateScaffold(tx, owner, source, content, isCurrent)
    if (fieldRowId === undefined) {
      await tx.update(source.id, {content: propertyFieldContent(resolved.fieldId)})
      return {schema: resolved, fieldRowId: source.id, valueId: undefined}
    }
    await tx.delete(source.id)
    if (memberCodecOf(resolved.codec)) return {schema: resolved, fieldRowId, valueId: undefined}
    return {schema: resolved, fieldRowId, valueId: (await openPropertyValue(tx, owner.id, resolved.fieldId)).valueId}
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
