import {adoptOrCreatePropertySchema} from '@/data/propertySchemaCreation'
import {
  ChangeScope,
  type AnyPropertyEditorOverride,
  type AnyPropertySchema,
  scopePoliciesEquivalent,
  type Tx,
} from '@/data/api'
import type { Block } from '@/data/block'
import { typesProp } from '@/data/properties.js'
import {
  isPropertyPanelHiddenProperty,
  isPropertyPanelReadOnlyProperty,
} from './visibility'
import type { AddPropertyArgs } from './AddPropertyForm'
import {declarationOnlyDefinitionForName} from './declarationOnly'

const canWriteProperty = (block: Block, schema: AnyPropertySchema): boolean =>
  !block.repo.isReadOnly
  && !isPropertyPanelReadOnlyProperty(schema.name)
  && !declarationOnlyDefinitionForName(schema.name, block.repo.propertyDefinitions)

export const resolveAndWriteProperty = async (
  block: Block,
  schema: AnyPropertySchema,
  resolve: (tx: Tx) => Promise<unknown>,
): Promise<boolean> => {
  if (!canWriteProperty(block, schema)) return false
  return block.repo.tx(async tx => {
    const owner = await tx.get(block.id)
    if (owner?.deleted !== false) return false
    const currentSchema = await tx.resolvePropertySchema(block.id, schema)
    if (currentSchema.codec !== schema.codec || !scopePoliciesEquivalent(currentSchema.changeScope, schema.changeScope)
      || !canWriteProperty(block, currentSchema)) return false
    tx.assertWritableWorkspace(owner.workspaceId)
    await tx.setProperty(block.id, currentSchema, await resolve(tx))
    return true
  }, {scope: schema.changeScope, description: `set property ${schema.name} on ${block.id}`})
}

export const writeProperty = (block: Block, schema: AnyPropertySchema, value: unknown): Promise<boolean> =>
  resolveAndWriteProperty(block, schema, async () => value)

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

  try {
    return (await adoptOrCreatePropertySchema(block.repo, {
      ...args,
      adopted: args.adopted ?? schemas.get(name),
      name,
    })).schema
  } catch (err) {
    console.error(`[addProperty] failed to register schema for "${name}":`, err)
    return undefined
  }
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
