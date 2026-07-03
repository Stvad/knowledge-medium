import { systemToggle } from "../facets/togglable.js";
import { blockRenderersFacet, createRendererRegistry } from "./core.js";
import { markdownExtensionsFacet } from "../markdown/extensions.js";
import { DefaultBlockRenderer } from "../components/renderer/DefaultBlockRenderer.js";
import { BlockTypeBlockRenderer } from "../components/renderer/BlockTypeBlockRenderer.js";
import { CodeMirrorExtensionBlockRenderer } from "../components/renderer/CodeMirrorExtensionBlockRenderer.js";
import { LayoutRenderer } from "../components/renderer/LayoutRenderer.js";
import { MissingDataRenderer } from "../components/renderer/MissingDataRenderer.js";
import { PanelRenderer } from "../components/renderer/PanelRenderer.js";
import { PropertySchemaBlockRenderer } from "../components/renderer/PropertySchemaBlockRenderer.js";
import { TopLevelRenderer } from "../components/renderer/TopLevelRenderer.js";
import { TypesPageBlockRenderer } from "../components/renderer/TypesPageBlockRenderer.js";
import { gfmMarkdownExtension } from "../markdown/defaultMarkdownExtension.js";
//#region src/extensions/defaultRenderers.tsx
var defaultRendererContributions = [
	{
		id: "default",
		renderer: DefaultBlockRenderer
	},
	{
		id: "extension",
		renderer: CodeMirrorExtensionBlockRenderer
	},
	{
		id: "propertySchema",
		renderer: PropertySchemaBlockRenderer
	},
	{
		id: "blockType",
		renderer: BlockTypeBlockRenderer
	},
	{
		id: "typesPage",
		renderer: TypesPageBlockRenderer
	},
	{
		id: "topLevel",
		renderer: TopLevelRenderer
	},
	{
		id: "layout",
		renderer: LayoutRenderer
	},
	{
		id: "panel",
		renderer: PanelRenderer
	},
	{
		id: "missingData",
		renderer: MissingDataRenderer
	}
];
var defaultRegistry = createRendererRegistry(defaultRendererContributions);
var defaultRenderersExtension = systemToggle({
	id: "system:default-renderers",
	name: "Default renderers",
	description: "Block renderer registry and the fallback renderer used when no plugin claims a block.",
	essential: true
}).of([markdownExtensionsFacet.of(gfmMarkdownExtension, { source: "defaultRenderers" }), ...defaultRendererContributions.map((contribution) => blockRenderersFacet.of(contribution))]);
//#endregion
export { defaultRegistry, defaultRendererContributions, defaultRenderersExtension };

//# sourceMappingURL=defaultRenderers.js.map