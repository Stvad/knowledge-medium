import { propertySchemasFacet, typesFacet } from "../../data/facets.js";
import { systemToggle } from "../../facets/togglable.js";
import { actionsFacet, appMountsFacet, blockRenderersFacet } from "../../extensions/core.js";
import { diagnosticsFacet } from "../diagnostics/facet.js";
import { mobileKeyboardToolbarItemsFacet } from "../mobile-keyboard-toolbar/facet.js";
import { ASSETS_TYPE_CONTRIBUTION, MEDIA_PROPERTY_SCHEMAS, MEDIA_TYPE_CONTRIBUTION } from "./mediaBlock.js";
import { audioMediaViewer, imageMediaViewer } from "./mediaViewers.js";
import { mediaViewersFacet } from "./mediaViewersFacet.js";
import { MediaBlockRenderer } from "./MediaBlockRenderer.js";
import { MediaDownLaneReplicator } from "./MediaDownLaneReplicator.js";
import { uploadLaneDiagnosticSource } from "./uploadLaneStatus.js";
import { MediaUploadReconciler } from "./MediaUploadReconciler.js";
import { captureMediaContribution, mediaPasteDecisionContribution } from "./pasteCapture.js";
import { insertImageAction, insertImageNormalModeAction, insertImageToolbarItem } from "./insertImageContribution.js";
import { retryFailedUploadsAction } from "./retryUploadsAction.js";
//#region src/plugins/attachments/index.ts
/**
* The `attachments` plugin (design §11) — packages the media block model + its
* renderer, mirroring the video-player plugin's facet wiring.
*
* Scope: the `media` block TYPE + its property schemas (typesFacet /
* propertySchemasFacet), the {@link MediaBlockRenderer} (blockRenderersFacet), the
* boot upload reconciler (appMountsFacet), and the paste rule that turns a file paste
* into a media capture (pasteDecisionVerb decorator). Everything the feature adds is
* gated on this one toggle — disable it and a file paste falls through to a text
* paste, no media blocks are minted, and the renderer/reconciler aren't mounted.
*/
var attachmentsPlugin = systemToggle({
	id: "system:attachments",
	name: "Attachments",
	description: "Image & file attachments — content-addressed media blocks embedded via !((id))."
}).of([
	typesFacet.of(MEDIA_TYPE_CONTRIBUTION, { source: "attachments" }),
	typesFacet.of(ASSETS_TYPE_CONTRIBUTION, { source: "attachments" }),
	MEDIA_PROPERTY_SCHEMAS.map((schema) => propertySchemasFacet.of(schema, { source: "attachments" })),
	blockRenderersFacet.of({
		id: "media",
		renderer: MediaBlockRenderer
	}, { source: "attachments" }),
	mediaViewersFacet.of(imageMediaViewer, { source: "attachments" }),
	mediaViewersFacet.of(audioMediaViewer, { source: "attachments" }),
	mediaPasteDecisionContribution,
	captureMediaContribution,
	actionsFacet.of(insertImageAction, { source: "attachments" }),
	actionsFacet.of(insertImageNormalModeAction, { source: "attachments" }),
	mobileKeyboardToolbarItemsFacet.of(insertImageToolbarItem, {
		source: "attachments",
		precedence: 50
	}),
	actionsFacet.of(retryFailedUploadsAction, { source: "attachments" }),
	appMountsFacet.of({
		id: "attachments.upload-reconciler",
		component: MediaUploadReconciler
	}, { source: "attachments" }),
	appMountsFacet.of({
		id: "attachments.down-lane-replicator",
		component: MediaDownLaneReplicator
	}, { source: "attachments" }),
	diagnosticsFacet.of(uploadLaneDiagnosticSource, { source: "attachments" })
]);
//#endregion
export { attachmentsPlugin };

//# sourceMappingURL=index.js.map