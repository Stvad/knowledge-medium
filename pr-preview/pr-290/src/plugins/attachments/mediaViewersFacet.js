import { dedupById, defineFacet } from "../../facets/facet.js";
//#region src/plugins/attachments/mediaViewersFacet.ts
var isMediaViewerContribution = (value) => {
	if (typeof value !== "object" || value === null) return false;
	const v = value;
	return typeof v.id === "string" && typeof v.match === "function" && typeof v.Component === "function" && typeof v.eager === "boolean";
};
var MEDIA_VIEWERS_FACET_ID = "attachments.media-viewers";
/** The media-viewer registry facet. Contributions fold into a precedence-ordered list
*  (dedup by id, last-wins per §6); {@link pickMediaViewer} finds the first match. */
var mediaViewersFacet = defineFacet({
	id: MEDIA_VIEWERS_FACET_ID,
	combine: dedupById(MEDIA_VIEWERS_FACET_ID),
	validate: isMediaViewerContribution
});
//#endregion
export { MEDIA_VIEWERS_FACET_ID, isMediaViewerContribution, mediaViewersFacet };

//# sourceMappingURL=mediaViewersFacet.js.map