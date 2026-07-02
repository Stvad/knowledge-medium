import { defineFacet } from "../../../../facets/facet.js";
import { isValidElement } from "react";
//#region src/plugins/references/markdown/wikilinks/wikilinkDecorator.ts
/**
* Facet for plugins to override the *display* of a wikilink without
* touching its underlying alias, link target, or storage. The first
* decorator (by precedence order) to return a non-null value wins;
* a null/undefined return falls through to the next decorator and
* ultimately to the wikilink's default rendering (the alias text).
*
* Decorators receive the full link context so they can make
* resolution-aware decisions — e.g. render differently when the alias
* resolved to no block yet, or scope behavior per workspace.
*
* Used by daily-notes to prefix date references with the weekday
* ("Fri, April 26th, 2026") at render time, while the stored alias
* remains the canonical "April 26th, 2026" the link resolver depends on.
*/
var isWikilinkDisplayDecorator = (value) => typeof value === "object" && value !== null && typeof value.id === "string" && typeof value.decorate === "function";
var wikilinkDisplayDecoratorFacet = defineFacet({
	id: "references.wikilink-display-decorator",
	validate: isWikilinkDisplayDecorator
});
var isWikilinkDisplayParts = (value) => typeof value === "object" && value !== null && !Array.isArray(value) && !isValidElement(value) && "content" in value;
/** First decorator (in precedence order) to return a non-null display,
*  or null if every decorator passes. Mirrors `pickBlockDateAdapter`'s
*  first-match semantics. */
var resolveWikilinkDisplay = (runtime, context) => {
	const decorators = runtime.read(wikilinkDisplayDecoratorFacet);
	for (const decorator of decorators) {
		const result = decorator.decorate(context);
		if (result != null) return result;
	}
	return null;
};
//#endregion
export { isWikilinkDisplayParts, resolveWikilinkDisplay, wikilinkDisplayDecoratorFacet };

//# sourceMappingURL=wikilinkDecorator.js.map