import { topLevelBlockIdProp } from "../data/properties.js";
import { useBlockContext } from "../context/block.js";
import { useUIStateProperty } from "../data/globalState.js";
//#region src/hooks/useIsFocalRender.ts
/**
* "Is this block being rendered as the document body of its panel?" —
* the question the five top-level affordances (force-open, hide-bullet,
* top-level CSS, breadcrumbs header, backlinks footer) all want to
* answer.
*
* Two axes are tangled in the naive `block.id === topLevelBlockId`
* check: focal-block identity (correct) and render surface (missing).
* An embed of the focal block, or a backlink entry whose shown block
* happens to equal the focal block, both pass the id check but should
* not inherit the focal affordances.
*
* Render surface is encoded as flags on `BlockContextType` set by every
* non-document mount (`BlockEmbed`, `BacklinkEntry`, breadcrumb list).
* The umbrella `isNestedSurface` is what this hook consults, so a new
* surface only has to set the umbrella to be excluded automatically.
*/
var useIsFocalRender = (block) => {
	const [topLevelBlockId] = useUIStateProperty(topLevelBlockIdProp);
	const { isNestedSurface } = useBlockContext();
	return block.id === topLevelBlockId && !isNestedSurface;
};
/** Non-hook variant for facet contributions that receive a
*  `BlockResolveContext`. Same policy as `useIsFocalRender`. */
var isFocalRender = (ctx) => ctx.isTopLevel && !ctx.blockContext?.isNestedSurface;
//#endregion
export { isFocalRender, useIsFocalRender };

//# sourceMappingURL=useIsFocalRender.js.map