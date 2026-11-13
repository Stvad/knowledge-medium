import type { SubtreeRow } from '@/data/api'
import { isResolvableFieldDefinition } from '@/data/internals/propertySchemaResolution'
import { outlineSkippedFieldIds } from '@/data/propertyDefinitionRegistry'
import type { Block } from '@/data/block'
import { isLeftOutOfChildrenView, isPropertyFieldInstance, type PropertyRowClassifier } from '@/data/propertyChildren'
import {
  childrenViewIn,
  NO_PROPERTY_DISPLAY_SCOPE,
  type PropertyDisplayScopeLevels,
} from '@/data/propertyDisplayMode'
import type { Repo } from '@/data/repo'

/** Which property rows a copy of a subtree carries: those a surface with this
 *  scope draws, or `'all'` — every row, including those the outline skips
 *  (the structural subtree). */
export type PropertyCopy = PropertyDisplayScopeLevels | 'all'

/** `rows` (a subtree in pre-order, root first) cut to what a surface with
 *  `scope` draws: a row its parent's view leaves out goes, and its whole
 *  subtree with it — as the outline, which never reaches below a row it does
 *  not draw. */
export const pruneSubtreeToDrawn = (
  rows: readonly SubtreeRow[],
  scope: PropertyDisplayScopeLevels,
  classifier: PropertyRowClassifier,
): SubtreeRow[] => {
  const kept = new Map<string, SubtreeRow>()
  const out: SubtreeRow[] = []
  for (const [index, row] of rows.entries()) {
    const parent = row.parentId === null ? undefined : kept.get(row.parentId)
    if (index > 0 && (parent === undefined
      || isLeftOutOfChildrenView(row, childrenViewIn(scope, parent), classifier))) continue
    kept.set(row.id, row)
    out.push(row)
  }
  return out
}

/** The classifier for `workspaceId` from the repo's live registry: the same
 *  recognition and skip set the outline's queries bind. */
export const repoPropertyRowClassifier = (repo: Repo, workspaceId: string): PropertyRowClassifier => {
  const resolver = repo.propertySchemaResolverFor(workspaceId)
  const registry = repo.propertyDefinitions
  const skipped = registry?.workspaceId === workspaceId ? outlineSkippedFieldIds(registry) : new Set<string>()
  return {
    isFieldDefinition: fieldId => isResolvableFieldDefinition(resolver.resolveField(fieldId)),
    isOutlineSkipped: fieldId => skipped.has(fieldId),
  }
}

/** Whether a surface with `scope` draws `block` as a PROPERTY ROW — the
 *  property's name beside its value, in place of the row's own `::((id))`
 *  text: a recognized field row under a parent whose listing there shows
 *  property rows. (In a listing that shows none, a field row on screen — the
 *  focused one — is an ordinary block showing its text.) */
export const isDrawnAsPropertyRow = async (
  block: Block,
  scope: PropertyDisplayScopeLevels,
): Promise<boolean> => {
  if (!scope.childBacked) return false
  const data = await block.load()
  if (!data?.parentId) return false
  const {isFieldDefinition} = repoPropertyRowClassifier(block.repo, data.workspaceId)
  if (!isPropertyFieldInstance(data, isFieldDefinition)) return false
  return childrenViewIn(scope, await block.repo.load(data.parentId)) !== 'none'
}

/** The subtree under `id` a copy carries (see {@link PropertyCopy}), in
 *  pre-order with root-relative depths. On a child-backed workspace the prune
 *  recognizes rows through the resolver, not the outline's SQL: the two agree
 *  except for an unmaterialized seed whose name is ambiguous, which the
 *  resolver does not count as a definition. */
export const copiedSubtree = async (
  repo: Repo,
  id: string,
  properties: PropertyCopy = NO_PROPERTY_DISPLAY_SCOPE,
): Promise<SubtreeRow[]> => {
  if (properties === 'all') return repo.query.subtree({id, propertyChildren: 'all'}).load()
  if (!properties.childBacked) return repo.query.subtree({id, propertyChildren: 'none'}).load()
  const rows = await repo.query.subtree({id, propertyChildren: 'all'}).load()
  if (rows.length === 0) return rows
  return pruneSubtreeToDrawn(rows, properties, repoPropertyRowClassifier(repo, rows[0]!.workspaceId))
}
