import { rendererProp } from "../data/properties.js";
import { blockRenderersFacet } from "../extensions/core.js";
import { useData, usePropertyValue } from "./block.js";
import { refreshAppRuntime } from "../facets/runtimeEvents.js";
import { useAppRuntime } from "../extensions/runtimeContext.js";
import { defaultRegistry } from "../extensions/defaultRenderers.js";
//#region src/hooks/useRendererRegistry.tsx
var refreshRendererRegistry = async () => {
	refreshAppRuntime();
};
var useRenderer = ({ block, context }) => {
	"use no memo";
	useData(block);
	/**
	* The above is a cludge to make this re-render on useData changes, compiler would over-memoize this otherwise
	* Ideally we make the dependency clear and structural tho
	*/
	const [rendererKey] = usePropertyValue(block, rendererProp);
	const registry = useAppRuntime().read(blockRenderersFacet);
	if (rendererKey && registry[rendererKey]) return registry[rendererKey];
	return Object.values(registry).filter((renderer) => renderer.canRender?.({
		block,
		context
	})).sort((a, b) => (b.priority?.({
		block,
		context
	}) || 0) - (a.priority?.({
		block,
		context
	}) || 0))[0] ?? registry.default;
};
//#endregion
export { defaultRegistry, refreshRendererRegistry, useRenderer };

//# sourceMappingURL=useRendererRegistry.js.map