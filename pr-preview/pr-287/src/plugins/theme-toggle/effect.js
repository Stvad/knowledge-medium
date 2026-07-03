import { actionsFacet } from "../../extensions/core.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { FALLBACK_THEME, applyTheme, setThemeRegistry, themesFacet } from "./theme.js";
//#region src/plugins/theme-toggle/effect.ts
var STYLE_ELEMENT_ATTR = "data-theme-plugin-managed";
/** Runtime source key for the per-theme apply actions. Held in a
*  dedicated bucket so push-and-replace keeps the action list in sync
*  with the facet rather than appending duplicates. */
var APPLY_ACTIONS_SOURCE = "theme-toggle.apply-actions";
var toDefinition = (c) => ({
	id: c.id,
	label: c.label,
	mode: c.mode
});
var buildThemeRule = (c) => {
	const lines = Object.entries(c.tokens).map(([k, v]) => `  --${k}: ${v};`).join("\n");
	return `[data-theme="${c.id}"] {\n${lines}\n}`;
};
var buildThemeStylesheet = (contributions) => contributions.map(buildThemeRule).join("\n\n");
var buildApplyThemeAction = (theme) => ({
	id: `theme-toggle.apply.${theme.id}`,
	description: `Theme: ${theme.label}`,
	context: ActionContextTypes.GLOBAL,
	handler: () => {
		applyTheme(theme.id);
	}
});
var themeStyleSyncEffect = {
	id: "theme-toggle.style-sync",
	start: ({ runtime }) => {
		const styleEl = document.createElement("style");
		styleEl.setAttribute(STYLE_ELEMENT_ATTR, "");
		document.head.appendChild(styleEl);
		const apply = () => {
			const contributions = runtime.read(themesFacet);
			styleEl.textContent = buildThemeStylesheet(contributions);
			setThemeRegistry(contributions.length === 0 ? [FALLBACK_THEME] : contributions.map(toDefinition));
			runtime.setRuntimeContributions(actionsFacet, APPLY_ACTIONS_SOURCE, contributions.map(buildApplyThemeAction));
		};
		apply();
		const unsubscribe = runtime.onFacetChange(themesFacet.id, apply);
		return () => {
			unsubscribe();
			styleEl.remove();
			setThemeRegistry([FALLBACK_THEME]);
			runtime.setRuntimeContributions(actionsFacet, APPLY_ACTIONS_SOURCE, []);
		};
	}
};
//#endregion
export { buildApplyThemeAction, buildThemeRule, buildThemeStylesheet, themeStyleSyncEffect };

//# sourceMappingURL=effect.js.map