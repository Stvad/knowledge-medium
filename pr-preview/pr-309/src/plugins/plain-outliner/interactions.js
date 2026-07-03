import { useInEditMode } from "../../data/globalState.js";
import { getBlockContentRendererSlot } from "../../extensions/blockInteraction.js";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/plugins/plain-outliner/interactions.tsx
var blockEditingContentRenderer = (context) => {
	const Primary = getBlockContentRendererSlot(context, "primary");
	if (!Primary) return null;
	const Secondary = getBlockContentRendererSlot(context, "secondary") ?? Primary;
	return {
		id: "plain-outliner.editing-dispatcher",
		label: "Editing dispatcher",
		render: Primary === Secondary ? Primary : (() => {
			const Dispatcher = (props) => {
				const $ = c(3);
				const Renderer = useInEditMode(props.block.id) ? Secondary : Primary;
				let t0;
				if ($[0] !== Renderer || $[1] !== props) {
					t0 = /* @__PURE__ */ jsx(Renderer, { ...props });
					$[0] = Renderer;
					$[1] = props;
					$[2] = t0;
				} else t0 = $[2];
				return t0;
			};
			Dispatcher.displayName = "BlockEditingDispatcher";
			return Dispatcher;
		})()
	};
};
//#endregion
export { blockEditingContentRenderer };

//# sourceMappingURL=interactions.js.map