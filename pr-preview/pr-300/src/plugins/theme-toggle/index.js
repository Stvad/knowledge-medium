import { systemToggle } from "../../facets/togglable.js";
import { actionsFacet, appEffectsFacet } from "../../extensions/core.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { FALLBACK_THEME, THEME_STORAGE_KEY, applyTheme, getCurrentTheme, getThemes, setThemeRegistry, themesFacet, toggleTheme } from "./theme.js";
import { themeStyleSyncEffect } from "./effect.js";
import { ThemeToggle } from "./ThemeToggle.js";
//#region src/plugins/theme-toggle/index.ts
var toggleThemeAction = {
	id: "theme-toggle.toggle",
	description: "Cycle through themes",
	context: ActionContextTypes.GLOBAL,
	handler: () => {
		toggleTheme();
	}
};
var themeTogglePlugin = systemToggle({
	id: "system:theme-toggle",
	name: "Theme toggle",
	description: "Cycle through the registered colour themes."
}).of([actionsFacet.of(toggleThemeAction, { source: "theme-toggle" }), appEffectsFacet.of(themeStyleSyncEffect, { source: "theme-toggle" })]);
//#endregion
export { FALLBACK_THEME, THEME_STORAGE_KEY, ThemeToggle, applyTheme, getCurrentTheme, getThemes, setThemeRegistry, themeStyleSyncEffect, themeTogglePlugin, themesFacet, toggleTheme, toggleThemeAction };

//# sourceMappingURL=index.js.map