import {
  ChangeScope,
  type AnyPropertyEditorOverride,
  type AnyPropertySchema,
} from '@/data/api'
import type { Block } from '@/data/block'
import { typesProp } from '@/data/properties.ts'
import { isPropertyPanelHiddenProperty } from './visibility'
import type { AddPropertyArgs } from './AddPropertyForm'

const hasOwn = (properties: Record<string, unknown>, name: string): boolean =>
  Object.prototype.hasOwnProperty.call(properties, name)

export const writeProperty = (
  block: Block,
  schema: AnyPropertySchema,
  decodedValue: unknown,
): Promise<void> =>
  block.set(schema, decodedValue)

/** AddPropertyForm submit handler: adopt a registered schema if the
 *  user picked one, or have UserSchemasService.addSchema register a
 *  new one synchronously. Either way, write the schema's defaultValue
 *  on the target block as the property's initial value. Refuses
 *  hidden / reserved names. */
export const addProperty = async (
  block: Block,
  schemas: ReadonlyMap<string, AnyPropertySchema>,
  uis: ReadonlyMap<string, AnyPropertyEditorOverride>,
  args: AddPropertyArgs,
): Promise<void> => {
  const name = args.name.trim()
  if (!name) return
  if (isPropertyPanelHiddenProperty(name, schemas, uis)) return

  if (args.adopted) {
    await writeProperty(block, args.adopted, args.adopted.defaultValue)
    return
  }

  // Existing registered schema with the same name → adopt it instead
  // of creating a duplicate (the form should have offered it as a
  // suggestion; this is the fallback for non-autocomplete submits).
  const existing = schemas.get(name)
  if (existing) {
    await writeProperty(block, existing, existing.defaultValue)
    return
  }

  try {
    const schema = await block.repo.userSchemas.addSchema({
      name,
      presetId: args.presetId,
    })
    await writeProperty(block, schema, schema.defaultValue)
  } catch (err) {
    console.error(`[addProperty] failed to register schema for "${name}":`, err)
  }
}

export const renameProperty = async (args: {
  block: Block
  properties: Record<string, unknown>
  schemas: ReadonlyMap<string, AnyPropertySchema>
  uis: ReadonlyMap<string, AnyPropertyEditorOverride>
  oldName: string
  newName: string
}) => {
  const nextName = args.newName.trim()
  if (!nextName || nextName === args.oldName) return
  if (args.oldName === typesProp.name || nextName === typesProp.name) return
  if (args.schemas.has(args.oldName) || args.schemas.has(nextName)) return
  if (isPropertyPanelHiddenProperty(args.oldName, args.schemas, args.uis)) return
  if (isPropertyPanelHiddenProperty(nextName, args.schemas, args.uis)) return

  const value = args.properties[args.oldName]
  if (value === undefined || !hasOwn(args.properties, args.oldName)) return

  await args.block.repo.tx(async tx => {
    const next = {...args.properties}
    delete next[args.oldName]
    next[nextName] = value
    await tx.update(args.block.id, {properties: next})
  }, {
    scope: ChangeScope.BlockDefault,
    description: `rename property ${args.oldName} to ${nextName}`,
  })
}

export const deleteProperty = async (args: {
  block: Block
  properties: Record<string, unknown>
  schemas: ReadonlyMap<string, AnyPropertySchema>
  uis: ReadonlyMap<string, AnyPropertyEditorOverride>
  name: string
}) => {
  if (args.name === typesProp.name) return
  if (isPropertyPanelHiddenProperty(args.name, args.schemas, args.uis)) return
  if (!hasOwn(args.properties, args.name)) return

  const next = {...args.properties}
  delete next[args.name]
  const schema = args.schemas.get(args.name)

  await args.block.repo.tx(async tx => {
    await tx.update(args.block.id, {properties: next})
  }, {
    scope: schema?.changeScope ?? ChangeScope.BlockDefault,
    description: `delete property ${args.name}`,
  })
}
