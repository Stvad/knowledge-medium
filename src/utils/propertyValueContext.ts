/**
 * Where a row that lives under a property FIELD ROW belongs — the property it
 * holds a value for, and the block that property is on.
 *
 * Properties-as-blocks makes a property a real child subtree (see
 * `@/data/propertyChildren`), so a property's values are ordinary blocks and
 * turn up in ordinary content search. That is the model working as intended,
 * not a leak — but a bare line of content is then ambiguous in a way it never
 * was: a page's `alias` value row has the SAME content as the page itself, so
 * a picker shows the two side by side with nothing to tell them apart. This
 * resolves the missing half of that row's identity so a surface can say
 * "alias of <page>" and can order the page ahead of its own machinery.
 *
 * Recognition is `isPropertyFieldInstance` applied to the row's PARENT — the
 * §9 predicate, composed rather than restated. It answers about the parent,
 * so a nested `::` row under a field row resolves the same context its value
 * siblings do. Deliberate: this describes where a row LIVES, which is true of
 * both, and the value-set discipline that must distinguish them governs
 * selection for WRITES, not a label.
 */

import type { BlockData } from '@/data/api'
import type { Repo } from '@/data/repo'
import {
  getPropertyFieldTargetId,
  isPropertyFieldInstance,
  type IsPropertyFieldDefinition,
} from '@/data/propertyChildren'

/** fieldId → what a person calls that property, or `undefined` when this
 *  workspace's registry cannot answer for the id. */
export type PropertyNameResolver = (fieldId: string) => string | undefined

/** Names for a workspace's property definitions, bound once.
 *
 *  Deliberately NARROWER than §9 recognition, which is shadow-tolerant so a
 *  shadowed definition's field rows keep classifying. A shadowed definition
 *  has no name of its own to show, and showing the WINNER's name would label
 *  a row with a property it is not — so it answers `undefined` and the
 *  surface falls back to whatever it does for a row it cannot place. */
export const propertyNameResolverFor = (
  repo: Repo,
  workspaceId: string,
): PropertyNameResolver => {
  const resolver = repo.propertySchemaResolverFor(workspaceId)
  return fieldId => {
    const resolution = resolver.resolveField(fieldId)
    return resolution.status === 'resolved' ? resolution.schema.name : undefined
  }
}

/** The property a row IS, when it is a field row this workspace recognizes and
 *  can name — §9 recognition composed with the name resolver, which is the
 *  only form either consumer wants.
 *
 *  `undefined` for everything else, and the cases are worth naming because
 *  they read alike and are not: an unmarked row; a marked row at the
 *  workspace ROOT, which has no owner to be a field OF, so its marker is
 *  ordinary content (§9); a target that resolves to no definition, which is
 *  a `::` block someone typed by hand; and a shadowed definition, whose name
 *  belongs to the winner. A caller falls back to whatever it does for a row
 *  it cannot place.
 *
 *  Call this rather than restating it; a restatement drops a clause. */
export interface RecognizedPropertyField {
  /** The definition this field row points at. */
  readonly fieldId: string
  /** What a person calls that property. */
  readonly name: string
}

export const recognizePropertyField = (
  data: Pick<BlockData, 'referenceTargetId' | 'parentId' | 'isFieldForm'>,
  propertyName: PropertyNameResolver,
): RecognizedPropertyField | undefined => {
  const fieldId = getPropertyFieldTargetId(data)
  const name = fieldId === undefined ? undefined : propertyName(fieldId)
  if (fieldId === undefined || name === undefined) return undefined
  const isNamedDefinition: IsPropertyFieldDefinition = id => propertyName(id) !== undefined
  return isPropertyFieldInstance(data, isNamedDefinition) ? {fieldId, name} : undefined
}

export interface PropertyValueContext {
  /** The definition the owning field row points at. */
  readonly fieldId: string
  /** The property's resolved name, e.g. `alias`. */
  readonly propertyName: string
  /** The block the property is ON — the field row's parent. */
  readonly ownerId: string
  /** The owner's row, or `null` when the walk could not see it (a
   *  soft-deleted owner stops the climb, and an owner in another workspace
   *  is refused). The id is still known from the field row's parent edge,
   *  which is what ordering needs; only a LABEL is unavailable. */
  readonly owner: BlockData | null
}

/** Contexts for whichever of `blockIds` sit under a property field row, keyed
 *  by block id; ids that don't are absent.
 *
 *  One `core.ancestors` handle per id, which the ancestor batcher coalesces
 *  into a single statement — the same read `useAncestorCrumbs` makes for
 *  breadcrumbs, so a surface that already crumbs pays nothing new.
 *
 *  A failed walk drops that id rather than rejecting: this annotates rows that
 *  are already on their way to the screen, and must never take the search down
 *  with it. */
export const propertyValueContexts = async (
  repo: Repo,
  workspaceId: string,
  blockIds: readonly string[],
): Promise<ReadonlyMap<string, PropertyValueContext>> => {
  const out = new Map<string, PropertyValueContext>()
  const ids = [...new Set(blockIds)]
  if (!workspaceId || ids.length === 0) return out

  const propertyName = propertyNameResolverFor(repo, workspaceId)
  const walks = await Promise.all(ids.map(id =>
    repo.query.ancestors({id}).load().catch(() => null),
  ))

  ids.forEach((id, index) => {
    const ancestors = walks[index]?.ancestors ?? []
    const field = ancestors[0]
    // The ancestor walk carries no workspace predicate (`manyAncestorsSql`),
    // and sync applies `parent_id` verbatim — so a cross-workspace edge is
    // refused here rather than trusted, same rule as `crumbsFromAncestors`.
    if (!field || field.workspaceId !== workspaceId) return
    const recognized = recognizePropertyField(field, propertyName)
    // `parentId` is non-null whenever recognition passed; read for the type.
    const ownerId = field.parentId
    if (recognized === undefined || ownerId === null) return
    const owner = ancestors[1]
    out.set(id, {
      fieldId: recognized.fieldId,
      propertyName: recognized.name,
      ownerId,
      owner: owner && owner.workspaceId === workspaceId ? owner : null,
    })
  })

  return out
}
