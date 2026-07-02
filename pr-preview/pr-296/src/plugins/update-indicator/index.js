import { propertySchemasFacet } from "../../data/facets.js";
import { systemToggle } from "../../facets/togglable.js";
import { appEffectsFacet } from "../../extensions/core.js";
import { pluginPrefsExtension } from "../../data/pluginStateExtensions.js";
import { blockContentDecoratorsFacet } from "../../extensions/blockInteraction.js";
import { currentLoadTimeProp, previousLoadTimeProp, updateIndicatorLoadTimeEffect, updateIndicatorPrefsType } from "./loadTimes.js";
import { UpdateIndicator } from "./UpdateIndicator.js";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/update-indicator/index.tsx
var updateIndicatorDecorator = () => (Inner) => {
	const Decorated = (props) => {
		const $ = c(7);
		let t0;
		if ($[0] !== props.block) {
			t0 = /* @__PURE__ */ jsx(UpdateIndicator, { block: props.block });
			$[0] = props.block;
			$[1] = t0;
		} else t0 = $[1];
		let t1;
		if ($[2] !== props) {
			t1 = /* @__PURE__ */ jsx(Inner, { ...props });
			$[2] = props;
			$[3] = t1;
		} else t1 = $[3];
		let t2;
		if ($[4] !== t0 || $[5] !== t1) {
			t2 = /* @__PURE__ */ jsxs("div", {
				className: "relative",
				children: [t0, t1]
			});
			$[4] = t0;
			$[5] = t1;
			$[6] = t2;
		} else t2 = $[6];
		return t2;
	};
	Decorated.displayName = "WithUpdateIndicator";
	return Decorated;
};
var updateIndicatorPlugin = systemToggle({
	id: "system:update-indicator",
	name: "Update indicator",
	description: "Subtle indicator when a new app build has been deployed since this tab loaded."
}).of([
	appEffectsFacet.of(updateIndicatorLoadTimeEffect, { source: "update-indicator" }),
	propertySchemasFacet.of(previousLoadTimeProp, { source: "update-indicator" }),
	propertySchemasFacet.of(currentLoadTimeProp, { source: "update-indicator" }),
	...pluginPrefsExtension(updateIndicatorPrefsType, "update-indicator"),
	blockContentDecoratorsFacet.of(updateIndicatorDecorator, { source: "update-indicator" })
]);
//#endregion
export { updateIndicatorPlugin };

//# sourceMappingURL=index.js.map