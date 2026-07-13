import {
  ChangeScope,
  type AnyPropertyEditorOverride,
  type AnyPropertySchema,
} from '@/data/api'
import type { Block } from '@/data/block'
import { typesProp } from '@/data/properties.js'
import { isPropertyPanelHiddenProperty } from './visibility'
import type { AddPropertyArgs } from './AddPropertyForm'
import {declarationOnlyDefinitionForName} from './declarationOnly'

export const writeProperty = (
  block: Block,
  schema: AnyPropertySchema,
  decodedValue: unknown,
): Promise<void> => {
  if (declarationOnlyDefinitionForName(
    schema.name,
    block.repo.propertyDefinitions,
  )) return Promise.resolve()
  return block.set(schema, decodedValue)
}

/** AddPropertyForm submit handler: adopt a registered schema if the
 *  user picked one, or have UserSchemasService.addSchema register a
 *  new one synchronously. The returned schema lets the caller render an
 *  unset row without writing the schema default as stored data. Refuses
 *  hidden / reserved names. */
export const addProperty = async (
  block: Block,
  schemas: ReadonlyMap<string, AnyPropertySchema>,
  uis: ReadonlyMap<string, AnyPropertyEditorOverride>,
  args: AddPropertyArgs,
): Promise<AnyPropertySchema | undefined> => {
  const name = args.name.trim()
  if (!name) return undefined
  if (isPropertyPanelHiddenProperty(name, schemas, uis, block.repo.propertyDefinitions)) {
    return undefined
  }
  if (declarationOnlyDefinitionForName(name, block.repo.propertyDefinitions)) {
    return undefined
  }

  if (args.adopted) {
    return args.adopted
  }

  // Existing registered schema with the same name → adopt it instead
  // of creating a duplicate (the form should have offered it as a
  // suggestion; this is the fallback for non-autocomplete submits).
  const existing = schemas.get(name)
  if (existing) {
    return existing
  }

  try {
    return await block.repo.userSchemas.addSchema({
      name,
      presetId: args.presetId,
    })
  } catch (err) {
    console.error(`[addProperty] failed to register schema for "${name}":`, err)
    return undefined
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
  const definitions = args.block.repo.propertyDefinitions
  if (declarationOnlyDefinitionForName(args.oldName, definitions)) return
  if (declarationOnlyDefinitionForName(nextName, definitions)) return
  if (isPropertyPanelHiddenProperty(args.oldName, args.schemas, args.uis, definitions)) return
  if (isPropertyPanelHiddenProperty(nextName, args.schemas, args.uis, definitions)) return

  const value = args.properties[args.oldName]
  if (value === undefined || !Object.hasOwn(args.properties, args.oldName)) return

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
  if (declarationOnlyDefinitionForName(
    args.name,
    args.block.repo.propertyDefinitions,
  )) return
  if (isPropertyPanelHiddenProperty(
    args.name,
    args.schemas,
    args.uis,
    args.block.repo.propertyDefinitions,
  )) return
  if (!Object.hasOwn(args.properties, args.name)) return

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
