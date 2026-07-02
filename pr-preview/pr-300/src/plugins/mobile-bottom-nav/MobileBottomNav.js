import { ActionContextTypes } from "../../shortcuts/types.js";
import { useActiveContextsState } from "../../shortcuts/ActiveContexts.js";
import { useIsMobile } from "../../utils/react.js";
import { dispatchActionWithDeps } from "../../shortcuts/runAction.js";
import { useActionRefItems } from "../../shortcuts/actionRefItems.js";
import { mobileBottomNavItemsFacet } from "./facet.js";
import { MobileBottomNavButton } from "./Button.js";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/plugins/mobile-bottom-nav/MobileBottomNav.tsx
function MobileBottomNavActionButton(t0) {
	const $ = c(9);
	const { action, activeContexts, disabled } = t0;
	let t1;
	if ($[0] !== action.context || $[1] !== action.id || $[2] !== activeContexts) {
		t1 = () => {
			const deps = activeContexts.get(action.context);
			if (!deps) return;
			dispatchActionWithDeps(action.id, deps, new CustomEvent("mobile-bottom-nav-action", { detail: { actionId: action.id } }));
		};
		$[0] = action.context;
		$[1] = action.id;
		$[2] = activeContexts;
		$[3] = t1;
	} else t1 = $[3];
	const handleClick = t1;
	if (!action.icon) return null;
	let t2;
	if ($[4] !== action.description || $[5] !== action.icon || $[6] !== disabled || $[7] !== handleClick) {
		t2 = /* @__PURE__ */ jsx(MobileBottomNavButton, {
			label: action.description,
			icon: action.icon,
			onClick: handleClick,
			disabled
		});
		$[4] = action.description;
		$[5] = action.icon;
		$[6] = disabled;
		$[7] = handleClick;
		$[8] = t2;
	} else t2 = $[8];
	return t2;
}
function MobileBottomNavSurface() {
	const $ = c(8);
	const resolved = useActionRefItems(mobileBottomNavItemsFacet, ActionContextTypes.GLOBAL);
	const activeContexts = useActiveContextsState();
	if (resolved.length === 0) return null;
	let t0;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = { paddingBottom: "env(safe-area-inset-bottom)" };
		$[0] = t0;
	} else t0 = $[0];
	let t1;
	if ($[1] !== activeContexts || $[2] !== resolved) {
		let t2;
		if ($[4] !== activeContexts) {
			t2 = (t3) => {
				const { item, action } = t3;
				return action ? /* @__PURE__ */ jsx(MobileBottomNavActionButton, {
					action,
					activeContexts,
					disabled: !activeContexts.has(action.context)
				}, item.id) : null;
			};
			$[4] = activeContexts;
			$[5] = t2;
		} else t2 = $[5];
		t1 = resolved.map(t2);
		$[1] = activeContexts;
		$[2] = resolved;
		$[3] = t1;
	} else t1 = $[3];
	let t2;
	if ($[6] !== t1) {
		t2 = /* @__PURE__ */ jsx("nav", {
			className: "fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 px-2 backdrop-blur supports-[backdrop-filter]:bg-background/85 md:hidden",
			style: t0,
			"aria-label": "Mobile navigation",
			"data-block-interaction": "ignore",
			children: /* @__PURE__ */ jsx("div", {
				className: "mx-auto flex h-16 max-w-md items-center justify-around",
				children: t1
			})
		});
		$[6] = t1;
		$[7] = t2;
	} else t2 = $[7];
	return t2;
}
function MobileBottomNav() {
	const $ = c(1);
	const isMobile = useIsMobile();
	const activeContexts = useActiveContextsState();
	const isEditing = activeContexts.has(ActionContextTypes.EDIT_MODE_CM) || activeContexts.has(ActionContextTypes.PROPERTY_EDITING);
	if (!isMobile || isEditing) return null;
	let t0;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = /* @__PURE__ */ jsx(MobileBottomNavSurface, {});
		$[0] = t0;
	} else t0 = $[0];
	return t0;
}
//#endregion
export { MobileBottomNav };

//# sourceMappingURL=MobileBottomNav.js.map