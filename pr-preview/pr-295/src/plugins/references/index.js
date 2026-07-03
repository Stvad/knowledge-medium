import { systemToggle } from "../../facets/togglable.js";
import { codeMirrorExtensionsFacet } from "../../editor/codeMirrorExtensions.js";
import { referencesDataExtension } from "./dataExtension.js";
import { markdownExtensionsFacet } from "../../markdown/extensions.js";
import { blockLayoutFacet } from "../../extensions/blockInteraction.js";
import { referenceLayoutContribution } from "../../components/references/referenceLayout.js";
import { referencesCodeMirrorExtensions } from "./codeMirrorExtensions.js";
import { blockrefMarkdownExtension } from "./markdown/blockrefs/index.js";
import { wikilinkMarkdownExtension } from "./markdown/wikilinks/index.js";
//#region src/plugins/references/index.ts
var referencesPlugin = systemToggle({
	id: "system:references",
	name: "References",
	description: "Wikilink + block-ref parsing, the reference layout, and the wikilink display decorator."
}).of([
	referencesDataExtension,
	markdownExtensionsFacet.of(wikilinkMarkdownExtension, { source: "references" }),
	markdownExtensionsFacet.of(blockrefMarkdownExtension, { source: "references" }),
	blockLayoutFacet.of(referenceLayoutContribution, { source: "references" }),
	codeMirrorExtensionsFacet.of(referencesCodeMirrorExtensions, { source: "references" })
]);
//#endregion
export { referencesPlugin };

//# sourceMappingURL=index.js.map