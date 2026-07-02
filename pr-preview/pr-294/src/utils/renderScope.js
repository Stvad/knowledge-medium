//#region src/utils/renderScope.ts
var encodeScopePart = (value) => encodeURIComponent(value);
var joinScope = (kind, parts) => [kind, ...parts.map(encodeScopePart)].join(":");
var outlineRenderScopeId = (topLevelBlockId) => joinScope("outline", [topLevelBlockId]);
var embedRenderScopeId = (parentRenderScopeId, sourceBlockId, occurrenceId, targetBlockId) => joinScope("embed", [
	sourceBlockId,
	occurrenceId,
	targetBlockId,
	parentRenderScopeId
]);
var backlinkRenderScopeId = (parentRenderScopeId, occurrenceId) => joinScope("backlink", [occurrenceId, parentRenderScopeId]);
var breadcrumbRenderScopeId = (parentRenderScopeId, blockId, occurrenceId) => joinScope("breadcrumb", [
	blockId,
	occurrenceId,
	parentRenderScopeId
]);
//#endregion
export { backlinkRenderScopeId, breadcrumbRenderScopeId, embedRenderScopeId, outlineRenderScopeId };

//# sourceMappingURL=renderScope.js.map