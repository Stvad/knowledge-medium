import { systemToggle } from "../../facets/togglable.js";
import { themesFacet } from "../theme-toggle/theme.js";
import "../theme-toggle/index.js";
import { DEFAULT_THEME_ID_DARK, DEFAULT_THEME_ID_LIGHT, defaultThemeContributions } from "./themes.js";
//#region src/plugins/default-themes/index.ts
var defaultThemesPlugin = systemToggle({
	id: "system:default-themes",
	name: "Default themes",
	description: "Bundles the built-in colour palettes (light, dark, sunset, indigo, solarized). Disabling falls back to the bootstrap palette only."
}).of(defaultThemeContributions.map((theme) => themesFacet.of(theme, { source: "default-themes" })));
//#endregion
export { DEFAULT_THEME_ID_DARK, DEFAULT_THEME_ID_LIGHT, defaultThemeContributions, defaultThemesPlugin };

//# sourceMappingURL=index.js.map