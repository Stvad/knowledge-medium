/**
 * Toggle-tree discovery for the settings UI.
 *
 * Same walk shape as the resolver pair (sync + async), minus the
 * `isEnabled` filter — the settings tree must surface *every*
 * togglable so the user can re-enable a disabled one. The walk
 * produces a forest of `ToggleNode` keyed by the boundary handle.
 *
 *   - boundary arrays produce a node and descend into its `children`
 *   - non-boundary arrays descend into the *current* sink
 *   - `FacetContribution.enables` also descends into the current sink
 *     (drag-along contributions don't get their own UI row;
 *     togglables inside them surface as siblings under the enclosing
 *     boundary, or at root if there is no enclosing boundary)
 *   - sync throws on function-valued nodes (matches the resolver);
 *     async awaits and recurses, logging + recovering on rejection
 */

import {
  walkAppExtension,
  walkAppExtensionSync,
  type AppExtension,
  type AppExtensionVisitor,
  type FacetResolveContext,
} from '@/extensions/facet.js'
import {getBoundary, type Togglable} from '@/extensions/togglable.js'

export interface ToggleNode {
  handle: Togglable
  children: ToggleNode[]
}

/** Discovery's configuration of the shared walker. The threaded `sink`
 *  is the `ToggleNode[]` we're filling:
 *
 *   - a boundary array produces a node and retargets descent into its
 *     `children`; a non-boundary array descends into the current sink
 *   - a contribution produces no row of its own, but `enables` descends
 *     into the current sink (so any togglable inside a drag-along
 *     surfaces as a sibling under the enclosing boundary, or at root)
 *
 *  No `isEnabled` filter — the settings tree must surface *every*
 *  togglable so the user can re-enable a disabled one. No dedup. */
const discoveryVisitor: AppExtensionVisitor<ToggleNode[]> = {
  array: (node, sink) => {
    const handle = getBoundary(node)
    if (!handle) return sink
    const child: ToggleNode = {handle, children: []}
    sink.push(child)
    return child.children
  },
  contribution: (_node, sink) => sink,
}

/** Sync discovery — usable on the static extension tree which has no
 *  function-valued nodes. Throws on a function (matches the resolver
 *  sync policy). For the dynamic-extensions case use
 *  `discoverToggleTree` (async). */
export const discoverToggleTreeSync = (
  tree: AppExtension | readonly AppExtension[],
): ToggleNode[] => {
  const roots: ToggleNode[] = []
  walkAppExtensionSync(tree, roots, discoveryVisitor, {
    onFunction:
      'discoverToggleTreeSync: cannot resolve function-valued AppExtension. ' +
      'Use discoverToggleTree (async) for trees that contain dynamicExtensionsExtension.',
  })
  return roots
}

/** Async discovery — required when the tree contains
 *  `dynamicExtensionsExtension` (a top-level function that awaits a
 *  PowerSync query). Without resolving that function, user-extension
 *  shell rows would never surface in the settings tree. */
export const discoverToggleTree = async (
  tree: AppExtension | readonly AppExtension[],
  context: FacetResolveContext,
): Promise<ToggleNode[]> => {
  const roots: ToggleNode[] = []
  await walkAppExtension(tree, roots, discoveryVisitor, {context})
  return roots
}
