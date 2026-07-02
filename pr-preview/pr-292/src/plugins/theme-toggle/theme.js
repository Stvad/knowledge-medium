import { defineFacet } from "../../facets/facet.js";
//#region src/plugins/theme-toggle/theme.ts
var isThemeContribution = (value) => {
	if (!value || typeof value !== "object") return false;
	const v = value;
	return typeof v.id === "string" && typeof v.label === "string" && (v.mode === "light" || v.mode === "dark") && !!v.tokens && typeof v.tokens === "object";
};
var themesFacet = defineFacet({
	id: "theme-toggle.themes",
	validate: isThemeContribution
});
/** Bootstrap sentinel. Used only when the registry is otherwise
*  empty (the few hundred ms between module load and the style-sync
*  effect mounting). Matches the `:root` palette in src/index.css
*  so the visual identity stays consistent during that window. The
*  default-themes plugin contributes a `sunset-warm-light` theme of
*  its own once it loads; from then on this entry is unreferenced. */
var FALLBACK_THEME = {
	id: "sunset-warm-light",
	label: "Sunset Warm Light",
	mode: "light"
};
var registry = [FALLBACK_THEME];
var registryById = new Map([[FALLBACK_THEME.id, FALLBACK_THEME]]);
var getThemes = () => registry;
/** Used by the theme-toggle effect. Plugins should not call this
*  directly — contribute via `themesFacet.of(...)` instead.
*
*  NOTE: this is the "module-global mirror synced by an app effect"
*  pattern. `processorRejectionToast` now reads `repo.facetRuntime`
*  directly instead of mirroring; converging this registry onto that read
*  is deferred to the runtime-composition work. */
var setThemeRegistry = (next) => {
	registry = next;
	registryById = new Map(next.map((t) => [t.id, t]));
};
var THEME_STORAGE_KEY = "theme";
var getDocumentRoot = () => window.document.documentElement;
var resolveTheme = (theme) => typeof theme === "string" ? registryById.get(theme) ?? registry[0] ?? FALLBACK_THEME : theme;
var getCurrentTheme = (root = getDocumentRoot()) => registryById.get(root.dataset.theme ?? "") ?? registry[0] ?? FALLBACK_THEME;
var applyTheme = (theme, root = getDocumentRoot()) => {
	const resolved = resolveTheme(theme);
	root.dataset.theme = resolved.id;
	try {
		window.localStorage?.setItem(THEME_STORAGE_KEY, resolved.id);
	} catch {}
	return resolved;
};
var toggleTheme = (root = getDocumentRoot()) => {
	if (registry.length === 0) return applyTheme(FALLBACK_THEME, root);
	const current = getCurrentTheme(root);
	const idx = registry.findIndex((t) => t.id === current.id);
	const next = registry[(idx + 1) % registry.length];
	return applyTheme(next, root);
};
//#endregion
export { FALLBACK_THEME, THEME_STORAGE_KEY, applyTheme, getCurrentTheme, getThemes, setThemeRegistry, themesFacet, toggleTheme };

//# sourceMappingURL=theme.js.map