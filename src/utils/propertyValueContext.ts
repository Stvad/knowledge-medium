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
import { getPropertyFieldTargetId, isPropertyFieldInstance } from '@/data/propertyChildren'
import { isResolvableFieldDefinition } from '@/data/internals/propertySchemaResolution'

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

  const resolver = repo.propertySchemaResolverFor(workspaceId)
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
    const fieldId = getPropertyFieldTargetId(field)
    if (fieldId === undefined) return
    const resolution = resolver.resolveField(fieldId)
    if (!isPropertyFieldInstance(field, () => isResolvableFieldDefinition(resolution))) return
    // Recognition is shadow-tolerant; a NAME is not. A shadowed definition's
    // rows keep the bare content they show today rather than gaining a label
    // that names the winner's property.
    if (resolution.status !== 'resolved') return
    const ownerId = field.parentId
    if (ownerId === null) return
    const owner = ancestors[1]
    out.set(id, {
      fieldId,
      propertyName: resolution.schema.name,
      ownerId,
      owner: owner && owner.workspaceId === workspaceId ? owner : null,
    })
  })

  return out
}
