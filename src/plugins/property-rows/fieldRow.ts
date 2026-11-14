import type { AnyPropertySchema, BlockData } from '@/data/api'
import { memberCodecOf } from '@/data/api'
import { isPropertyFieldInstance } from '@/data/propertyChildren'
import { repoFieldDefinitionTest } from '@/data/drawnSubtree'
import type { Repo } from '@/data/repo'
import type { PropertyDefinitionRegistrySnapshot } from '@/data/propertyDefinitionRegistry'
import { useCallback, useSyncExternalStore } from 'react'
import type { BlockContextType } from '@/types'
import type { Block } from '@/data/block'
import { useHandle } from '@/hooks/block'

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
 *  boundary for every block, loaded or not.
 *
 *  `definitions` is the registry snapshot the answer is read against, passed in
 *  rather than read off `repo` so a render that calls this depends on it: the
 *  React Compiler memoizes on the arguments a call uses, and a registry read
 *  hidden inside would freeze the answer across a rename. */
export const fieldRowDefinition = (
  repo: Repo,
  definitions: PropertyDefinitionRegistrySnapshot | null,
  data: Pick<BlockData, 'referenceTargetId' | 'parentId' | 'isFieldForm' | 'workspaceId'> | null | undefined,
): FieldRowDefinition | undefined => {
  if (!data) return undefined
  if (!isPropertyFieldInstance(data, repoFieldDefinitionTest(repo, data.workspaceId))) return undefined
  const fieldId = data.referenceTargetId!
  const resolution = repo.propertySchemaResolverFor(data.workspaceId).resolveField(fieldId)
  if (resolution.status === 'resolved') {
    return {fieldId, name: resolution.schema.name, schema: resolution.schema}
  }
  const name = definitions?.definitionsByFieldId.get(fieldId)?.name ?? fieldId
  return {fieldId, name, schema: undefined}
}

/** Whether a scalar value child belongs in the property row editor. Lists
 *  store one child per member, while refs stay ordinary reference blocks for
 *  the markdown renderer, accepting its UUID-only block-id grammar rather
 *  than introducing a property-only reference rendering path. */
export const isPropertyValueEditorEligible = (schema: AnyPropertySchema): boolean =>
  memberCodecOf(schema.codec) === undefined && schema.codec.type !== 'ref'

/** Surfaces that show a block as something other than an outline row — a
 *  breadcrumb crumb, an inline reference — keep their own rendering. */
export const drawsPropertyRows = (context: BlockContextType | undefined): boolean =>
  context?.isBreadcrumb !== true && context?.isReference !== true

/** Is `block` a child of `parentId`? The one test both row renderers make
 *  against the context their parent provides (a listing, a field row). */
export const useIsChildOf = (block: Block, parentId: string | null): boolean =>
  useHandle(block, {selector: data => parentId !== null && data?.parentId === parentId})

/** The repo's property-definition registry snapshot, reactively: a new
 *  snapshot on every registry rebuild (a rename, a definition arriving). The
 *  input a render passes to {@link fieldRowDefinition}. */
export const usePropertyDefinitions = (repo: Repo): PropertyDefinitionRegistrySnapshot | null => {
  const subscribe = useCallback((cb: () => void) => repo.onPropertySchemasChange(cb), [repo])
  const snapshot = useCallback(() => repo.propertyDefinitions, [repo])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
