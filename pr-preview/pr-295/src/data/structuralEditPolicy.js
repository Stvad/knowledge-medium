import { isCollapsedProp } from "./properties.js";
//#region src/data/structuralEditPolicy.ts
var resolveStructuralEditPolicy = ({ blockId, parentId, hasUncollapsedChildren, scopeRootId }) => {
	const isScopeRoot = scopeRootId !== void 0 && blockId === scopeRootId;
	return {
		isScopeRoot,
		createBelowPlacement: isScopeRoot || hasUncollapsedChildren ? "child-first" : "sibling-below",
		createAbovePlacement: isScopeRoot ? "child-first" : "sibling-above",
		canIndent: !isScopeRoot,
		canOutdent: !isScopeRoot && parentId !== scopeRootId,
		canMergeUp: !isScopeRoot
	};
};
/**
* Convenience resolver that reads the inputs `resolveStructuralEditPolicy`
* needs from a live `Block`, centralizing the load idiom the structural
* action handlers used to repeat (`load` + `childIds` + `isCollapsed`).
*/
var structuralEditPolicyForBlock = async (block, scopeRootId) => {
	const data = block.peek() ?? await block.load();
	const childIds = await block.childIds.load();
	const isCollapsed = block.peekProperty(isCollapsedProp) ?? false;
	return resolveStructuralEditPolicy({
		blockId: block.id,
		parentId: data?.parentId ?? null,
		hasUncollapsedChildren: childIds.length > 0 && !isCollapsed,
		scopeRootId
	});
};
//#endregion
export { resolveStructuralEditPolicy, structuralEditPolicyForBlock };

//# sourceMappingURL=structuralEditPolicy.js.map