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

import type {
  AppExtension,
  FacetContribution,
  FacetResolveContext,
} from '@/extensions/facet.js'
import {getBoundary, type Togglable} from '@/extensions/togglable.js'

export interface ToggleNode {
  handle: Togglable
  children: ToggleNode[]
}

const isFacetContribution = (
  value: unknown,
): value is FacetContribution<unknown> =>
  typeof value === 'object' &&
  value !== null &&
  (value as {type?: unknown}).type === 'facet-contribution'

/** Sync discovery — usable on the static extension tree which has no
 *  function-valued nodes. Throws on a function (matches the resolver
 *  sync policy). For the dynamic-extensions case use
 *  `discoverToggleTree` (async). */
export const discoverToggleTreeSync = (
  tree: AppExtension | readonly AppExtension[],
): ToggleNode[] => {
  const roots: ToggleNode[] = []
  walkSync(tree, roots)
  return roots
}

function walkSync(
  node: AppExtension | readonly AppExtension[],
  sink: ToggleNode[],
): void {
  if (!node) return

  if (typeof node === 'function') {
    throw new Error(
      'discoverToggleTreeSync: cannot resolve function-valued AppExtension. ' +
      'Use discoverToggleTree (async) for trees that contain dynamicExtensionsExtension.',
    )
  }

  if (Array.isArray(node)) {
    const handle = getBoundary(node)
    if (handle) {
      const child: ToggleNode = {handle, children: []}
      sink.push(child)
      for (const inner of node) walkSync(inner as AppExtension, child.children)
    } else {
      for (const inner of node) walkSync(inner as AppExtension, sink)
    }
    return
  }

  if (isFacetContribution(node) && node.enables) walkSync(node.enables, sink)
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
  await walk(tree, context, roots)
  return roots
}

async function walk(
  node: AppExtension | readonly AppExtension[],
  context: FacetResolveContext,
  sink: ToggleNode[],
): Promise<void> {
  if (!node) return

  if (typeof node === 'function') {
    try {
      await walk(await node(context), context, sink)
    } catch (error) {
      console.error('discoverToggleTree: failed to resolve function', error)
    }
    return
  }

  if (Array.isArray(node)) {
    const handle = getBoundary(node)
    if (handle) {
      const child: ToggleNode = {handle, children: []}
      sink.push(child)
      for (const inner of node) {
        await walk(inner as AppExtension, context, child.children)
      }
    } else {
      for (const inner of node) {
        await walk(inner as AppExtension, context, sink)
      }
    }
    return
  }

  if (isFacetContribution(node) && node.enables) {
    await walk(node.enables, context, sink)
  }
}
