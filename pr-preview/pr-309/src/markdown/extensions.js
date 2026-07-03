import { defineFacet, isFunction } from "../facets/facet.js";
//#region src/markdown/extensions.ts
var resolveMarkdownRenderConfig = (extensions, context) => {
	const remarkPlugins = [];
	const components = {};
	for (const extension of extensions) {
		const extensionConfig = extension(context);
		if (!extensionConfig) continue;
		if (extensionConfig.remarkPlugins) remarkPlugins.push(...extensionConfig.remarkPlugins);
		if (extensionConfig.components) Object.assign(components, extensionConfig.components);
	}
	return {
		remarkPlugins,
		components
	};
};
var markdownExtensionsFacet = defineFacet({
	id: "core.markdown-extensions",
	combine: (extensions) => (context) => resolveMarkdownRenderConfig(extensions, context),
	empty: () => () => ({
		remarkPlugins: [],
		components: {}
	}),
	validate: isFunction
});
//#endregion
export { markdownExtensionsFacet, resolveMarkdownRenderConfig };

//# sourceMappingURL=extensions.js.map