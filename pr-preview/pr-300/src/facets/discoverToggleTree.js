import { walkAppExtension } from "./facet.js";
import { getBoundary } from "./togglable.js";
//#region src/facets/discoverToggleTree.ts
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
var discoveryVisitor = {
	array: (node, sink) => {
		const handle = getBoundary(node);
		if (!handle) return sink;
		const child = {
			handle,
			children: []
		};
		sink.push(child);
		return child.children;
	},
	contribution: (_node, sink) => sink
};
/** Async discovery — required when the tree contains
*  `dynamicExtensionsExtension` (a top-level function that awaits a
*  PowerSync query). Without resolving that function, user-extension
*  shell rows would never surface in the settings tree. */
var discoverToggleTree = async (tree, context) => {
	const roots = [];
	await walkAppExtension(tree, roots, discoveryVisitor, { context });
	return roots;
};
//#endregion
export { discoverToggleTree };

//# sourceMappingURL=discoverToggleTree.js.map