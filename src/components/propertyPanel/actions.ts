import {
  ChangeScope,
  type AnyPropertySchema,
  type AnyPropertyUiContribution,
} from '@/data/api'
import type { Block } from '@/data/block'
import { typesProp } from '@/data/properties.ts'
import {
  adhocSchema,
  defaultValueForShape,
} from '@/components/propertyEditors/defaults'
import { isPropertyPanelHiddenProperty } from './visibility'
import type { AddablePropertyShape } from './shapes'

const hasOwn = (properties: Record<string, unknown>, name: string): boolean =>
  Object.prototype.hasOwnProperty.call(properties, name)

export const writeProperty = (
  block: Block,
  schema: AnyPropertySchema,
  decodedValue: unknown,
) => {
  void block.set(schema, decodedValue)
}

export const addProperty = (
  block: Block,
  schemas: ReadonlyMap<string, AnyPropertySchema>,
  uis: ReadonlyMap<string, AnyPropertyUiContribution>,
  rawName: string,
  shape: AddablePropertyShape,
) => {
  const name = rawName.trim()
  if (!name || isPropertyPanelHiddenProperty(name, schemas, uis)) return

  const registered = schemas.get(name)
  if (registered) writeProperty(block, registered, registered.defaultValue)
  else writeProperty(block, adhocSchema(name, shape), defaultValueForShape(shape))
}

export const changeAdhocPropertyShape = (
  block: Block,
  schemas: ReadonlyMap<string, AnyPropertySchema>,
  uis: ReadonlyMap<string, AnyPropertyUiContribution>,
  name: string,
  shape: AddablePropertyShape,
) => {
  if (isPropertyPanelHiddenProperty(name, schemas, uis) || schemas.has(name)) return
  void block.set(adhocSchema(name, shape), defaultValueForShape(shape))
}

export const renameProperty = async (args: {
  block: Block
  properties: Record<string, unknown>
  schemas: ReadonlyMap<string, AnyPropertySchema>
  uis: ReadonlyMap<string, AnyPropertyUiContribution>
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
  uis: ReadonlyMap<string, AnyPropertyUiContribution>
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
