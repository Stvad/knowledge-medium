import {
  ChangeScope,
  type AnyPropertyEditorOverride,
  type AnyPropertySchema,
} from '@/data/api'
import type { Block } from '@/data/block'
import { typesProp } from '@/data/properties.js'
import {
  isPropertyPanelHiddenProperty,
  isPropertyPanelReadOnlyProperty,
} from './visibility'
import type { AddPropertyArgs } from './AddPropertyForm'
import {declarationOnlyDefinitionForName} from './declarationOnly'

export const writeProperty = (
  block: Block,
  schema: AnyPropertySchema,
  decodedValue: unknown,
): Promise<void> => {
  if (isPropertyPanelReadOnlyProperty(schema.name)) return Promise.resolve()
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
  if (
    isPropertyPanelReadOnlyProperty(args.oldName) ||
    isPropertyPanelReadOnlyProperty(nextName)
  ) return
  if (args.schemas.has(args.oldName) || args.schemas.has(nextName)) return
  const definitions = args.block.repo.propertyDefinitions
  if (declarationOnlyDefinitionForName(args.oldName, definitions)) return
  if (declarationOnlyDefinitionForName(nextName, definitions)) return
  if (isPropertyPanelHiddenProperty(args.oldName, args.schemas, args.uis, definitions)) return
  if (isPropertyPanelHiddenProperty(nextName, args.schemas, args.uis, definitions)) return

  // Cheap pre-gate on the panel snapshot; the authoritative check is in-tx.
  if (!Object.hasOwn(args.properties, args.oldName)) return

  await args.block.repo.tx(async tx => {
    // Re-read the CURRENT bag inside the tx rather than trusting the panel's
    // (possibly stale) `args.properties` snapshot — a whole-bag write off the
    // snapshot would clobber any OTHER property a concurrent write changed
    // between the panel opening and this commit. The tx serialises read+write.
    const current = await tx.get(args.block.id)
    if (!current || !Object.hasOwn(current.properties, args.oldName)) return
    const next = {...current.properties}
    next[nextName] = next[args.oldName]
    delete next[args.oldName]
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
  if (isPropertyPanelReadOnlyProperty(args.name)) return
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

  const schema = args.schemas.get(args.name)

  await args.block.repo.tx(async tx => {
    if (schema) {
      // Typed path: unsetProperty resolves identity, runs the same
      // scope-consistency guard (resolved scope vs the scope this tx was
      // admitted under, = schema.changeScope), removes just this key — no
      // whole-bag replace — and, in a child-backed workspace, eagerly
      // soft-deletes the field-row children (symmetric with setProperty's
      // inline dual-write).
      await tx.unsetProperty(args.block.id, schema)
    } else {
      // Schema-less transitional key (no registered definition): unsetProperty
      // would throw on the unresolvable schema, so drop the bare cell key
      // directly. Such a key has no children to reconcile (no schema → never
      // materialized); the migration backfill is what gives it a definition.
      // Re-read fresh inside the tx (not the panel's stale snapshot) so the
      // whole-bag write can't clobber a concurrently-changed sibling key.
      const current = await tx.get(args.block.id)
      if (!current || !Object.hasOwn(current.properties, args.name)) return
      const next = {...current.properties}
      delete next[args.name]
      await tx.update(args.block.id, {properties: next})
    }
  }, {
    scope: schema?.changeScope ?? ChangeScope.BlockDefault,
    description: `delete property ${args.name}`,
  })
}
