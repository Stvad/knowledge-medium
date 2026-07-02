//#region src/plugins/spatial-navigation/surface.ts
var surfaceFromContext = (context) => {
	if (context.isBreadcrumb) return "breadcrumb";
	if (context.isBacklink) return "backlink";
	if (context.isEmbedded) return "embedded";
	if (context.isNestedSurface) return "nested";
	return "outline";
};
//#endregion
export { surfaceFromContext };

//# sourceMappingURL=surface.js.map