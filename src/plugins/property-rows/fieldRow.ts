import type { AnyPropertySchema, BlockData } from '@/data/api'
import { memberCodecOf } from '@/data/api'
import { isPropertyFieldInstance } from '@/data/propertyChildren'
import { isResolvableFieldDefinition } from '@/data/internals/propertySchemaResolution'
import type { Repo } from '@/data/repo'
import type { BlockContextType } from '@/types'

/** What a field row is a row OF: its definition id, the name the outline
 *  labels it with, and the schema when this device can build one. */
export interface FieldRowDefinition {
  readonly fieldId: string
  readonly name: string
  readonly schema: AnyPropertySchema | undefined
}

/** The definition a FIELD ROW (§9 recognition, against the registry this repo
 *  holds for the row's workspace) names, or `undefined` for any other block.
 *  Total and synchronous — it backs `canRender`, which runs above the error
 *  boundary for every block, loaded or not. */
export const fieldRowDefinition = (
  repo: Repo,
  data: Pick<BlockData, 'referenceTargetId' | 'parentId' | 'isFieldForm' | 'workspaceId'> | null | undefined,
): FieldRowDefinition | undefined => {
  if (!data) return undefined
  const resolver = repo.propertySchemaResolverFor(data.workspaceId)
  const isDefinition = (fieldId: string) => isResolvableFieldDefinition(resolver.resolveField(fieldId))
  if (!isPropertyFieldInstance(data, isDefinition)) return undefined
  const fieldId = data.referenceTargetId!
  const resolution = resolver.resolveField(fieldId)
  if (resolution.status === 'resolved') {
    return {fieldId, name: resolution.schema.name, schema: resolution.schema}
  }
  const name = repo.propertyDefinitions?.definitionsByFieldId.get(fieldId)?.name ?? fieldId
  return {fieldId, name, schema: undefined}
}

/** Does one value child hold the whole value? True for a scalar property;
 *  false for a list, whose value children are one MEMBER each — those render
 *  as the ordinary blocks they are, since no editor edits one member.
 *  Defence in depth for `ValueRowRenderer`: a member's content never stores
 *  the whole list, so its owner-value check refuses one too; this keeps list
 *  members off that path before any hook runs. */
export const isSingleValueProperty = (schema: AnyPropertySchema): boolean =>
  memberCodecOf(schema.codec) === undefined

/** Surfaces that show a block as something other than an outline row — a
 *  breadcrumb crumb, an inline reference — keep their own rendering. */
export const drawsPropertyRows = (context: BlockContextType | undefined): boolean =>
  context?.isBreadcrumb !== true && context?.isReference !== true
