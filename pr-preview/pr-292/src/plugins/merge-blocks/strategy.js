import { hasBlockType } from "../../data/properties.js";
import "../../data/blockTypes.js";
//#region src/plugins/merge-blocks/strategy.ts
/**
* Pick the `contentStrategy` for a binary merge based on the two blocks'
* types. Pages don't compose by concatenation — two prose bodies stitched
* together produce a mess — so anything page-flavoured uses `keepTarget`
* (and `keepTarget`'s empty-target fallback covers the canonical-stub-
* absorbs-real-page case). Outline blocks keep the Backspace-style
* `'concat'` behaviour so an interactive "merge this into the picked
* block" feels consistent with what Backspace already does.
*/
var pickMergeContentStrategy = (sourceData, targetData) => {
	if (hasBlockType(sourceData, "page") || hasBlockType(targetData, "page")) return "keepTarget";
	return "concat";
};
//#endregion
export { pickMergeContentStrategy };

//# sourceMappingURL=strategy.js.map