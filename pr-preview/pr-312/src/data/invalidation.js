//#region src/data/invalidation.ts
var emitPluginInvalidation = (out, channel, key) => {
	if (!channel || !key) return;
	let keys = out.get(channel);
	if (!keys) {
		keys = /* @__PURE__ */ new Set();
		out.set(channel, keys);
	}
	keys.add(key);
};
var createPluginInvalidationEmitter = (out) => (channel, key) => emitPluginInvalidation(out, channel, key);
var collectPluginInvalidationsFromSnapshots = (rules, snapshots) => {
	if (rules.length === 0 || snapshots.size === 0) return void 0;
	const out = /* @__PURE__ */ new Map();
	const emit = createPluginInvalidationEmitter(out);
	for (const rule of rules) try {
		rule.collectFromSnapshots?.(snapshots, emit);
	} catch (err) {
		console.warn(`[invalidation] rule "${rule.id}" threw; keeping its emissions so far, dropping the rest`, err);
	}
	return out.size > 0 ? out : void 0;
};
var pluginInvalidationSize = (pluginInvalidations) => {
	if (!pluginInvalidations) return 0;
	let total = 0;
	for (const keys of pluginInvalidations.values()) total += "size" in keys ? keys.size : keys.length;
	return total;
};
var TYPED_BLOCKS_LIVE_CHANNEL = "typedBlocks.live";
var TYPED_BLOCKS_TYPE_CHANNEL = "typedBlocks.type";
var TYPED_BLOCKS_PROPERTY_CHANNEL = "typedBlocks.property";
var TYPED_BLOCKS_REFERENCE_CHANNEL = "typedBlocks.reference";
var TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL = "typedBlocks.referenceField";
var TYPED_BLOCKS_STRUCTURE_CHANNEL = "typedBlocks.structure";
var TYPED_BLOCKS_REFS_OF_CHANNEL = "typedBlocks.refsOf";
var TYPED_BLOCKS_LABEL_CHANNEL = "typedBlocks.label";
var KERNEL_ALIASES_CHANNEL = "kernel.aliases";
var KERNEL_CONTENT_CHANNEL = "kernel.content";
var SEP = "\0";
var typedBlocksLiveKey = (workspaceId) => workspaceId;
var typedBlocksTypeKey = (workspaceId, type) => `${workspaceId}${SEP}${type}`;
var typedBlocksPropertyKey = (workspaceId, name) => `${workspaceId}${SEP}${name}`;
var typedBlocksReferenceKey = (workspaceId, targetId) => `${workspaceId}${SEP}${targetId}`;
var typedBlocksReferenceFieldKey = (workspaceId, targetId, sourceField) => `${workspaceId}${SEP}${targetId}${SEP}${sourceField}`;
var typedBlocksStructureKey = (workspaceId, blockId) => `${workspaceId}${SEP}${blockId}`;
var typedBlocksRefsOfKey = (workspaceId, blockId) => `${workspaceId}${SEP}${blockId}`;
var typedBlocksLabelKey = (workspaceId, blockId) => `${workspaceId}${SEP}${blockId}`;
var kernelAliasesKey = (workspaceId) => workspaceId;
var kernelContentKey = (workspaceId) => workspaceId;
//#endregion
export { KERNEL_ALIASES_CHANNEL, KERNEL_CONTENT_CHANNEL, TYPED_BLOCKS_LABEL_CHANNEL, TYPED_BLOCKS_LIVE_CHANNEL, TYPED_BLOCKS_PROPERTY_CHANNEL, TYPED_BLOCKS_REFERENCE_CHANNEL, TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL, TYPED_BLOCKS_REFS_OF_CHANNEL, TYPED_BLOCKS_STRUCTURE_CHANNEL, TYPED_BLOCKS_TYPE_CHANNEL, collectPluginInvalidationsFromSnapshots, createPluginInvalidationEmitter, emitPluginInvalidation, kernelAliasesKey, kernelContentKey, pluginInvalidationSize, typedBlocksLabelKey, typedBlocksLiveKey, typedBlocksPropertyKey, typedBlocksReferenceFieldKey, typedBlocksReferenceKey, typedBlocksRefsOfKey, typedBlocksStructureKey, typedBlocksTypeKey };

//# sourceMappingURL=invalidation.js.map