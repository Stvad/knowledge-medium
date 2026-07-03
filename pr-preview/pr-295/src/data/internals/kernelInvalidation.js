import { KERNEL_ALIASES_CHANNEL, KERNEL_CONTENT_CHANNEL, TYPED_BLOCKS_LABEL_CHANNEL, TYPED_BLOCKS_LIVE_CHANNEL, TYPED_BLOCKS_PROPERTY_CHANNEL, TYPED_BLOCKS_REFERENCE_CHANNEL, TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL, TYPED_BLOCKS_REFS_OF_CHANNEL, TYPED_BLOCKS_STRUCTURE_CHANNEL, TYPED_BLOCKS_TYPE_CHANNEL, kernelAliasesKey, kernelContentKey, typedBlocksLabelKey, typedBlocksLiveKey, typedBlocksPropertyKey, typedBlocksReferenceFieldKey, typedBlocksReferenceKey, typedBlocksRefsOfKey, typedBlocksStructureKey, typedBlocksTypeKey } from "../invalidation.js";
//#region src/data/internals/kernelInvalidation.ts
var SEP = "\0";
/** Property name that holds the type list. Mirrors `typesProp.name` from
*  `data/properties.ts`; duplicated here so this module stays free of the
*  property-schema surface (which transitively pulls in codecs etc.). */
var TYPES_PROPERTY_NAME = "types";
/** Property name that holds the alias list. Mirrors `aliasesProp.name`
*  from `data/properties.ts`; duplicated for the same
*  reason as `TYPES_PROPERTY_NAME`. The kernel `block_aliases` trigger
*  derives the index from this exact property key — keeping the rule
*  in sync with the schema. */
var ALIAS_PROPERTY_NAME = "alias";
/** True iff `properties.alias` decodes to at least one string entry —
*  exactly the predicate the `block_aliases` triggers use to gate
*  inserts (`typeof(je.value) = 'text'` in `clientSchema.ts`). The
*  empty string is intentionally included: the trigger indexes it, so
*  an alias-keyed query subscribed to `kernel.aliases` must wake when a
*  row carrying `alias: ['']` enters/leaves the live set or it would
*  silently miss block_aliases updates. */
var hasAlias = (properties) => {
	if (!properties) return false;
	const raw = properties[ALIAS_PROPERTY_NAME];
	if (!Array.isArray(raw)) return false;
	return raw.some((v) => typeof v === "string");
};
var decodeTypes = (properties) => {
	if (!properties) return [];
	const raw = properties[TYPES_PROPERTY_NAME];
	if (!Array.isArray(raw)) return [];
	return raw.filter((t) => typeof t === "string");
};
var encodedEqual = (a, b) => {
	if (a === b) return true;
	if (a === void 0 || b === void 0) return false;
	return JSON.stringify(a) === JSON.stringify(b);
};
var emitTypeChannel = (emit, emitted, workspaceId, type) => {
	const key = typedBlocksTypeKey(workspaceId, type);
	if (emitted.has(key)) return;
	emitted.add(key);
	emit(TYPED_BLOCKS_TYPE_CHANNEL, key);
};
var emitPropertyChannel = (emit, emitted, workspaceId, name) => {
	const key = typedBlocksPropertyKey(workspaceId, name);
	if (emitted.has(key)) return;
	emitted.add(key);
	emit(TYPED_BLOCKS_PROPERTY_CHANNEL, key);
};
var emitReferenceChannels = (emit, emittedTargets, emittedFields, workspaceId, targetId, sourceField) => {
	const targetKey = typedBlocksReferenceKey(workspaceId, targetId);
	if (!emittedTargets.has(targetKey)) {
		emittedTargets.add(targetKey);
		emit(TYPED_BLOCKS_REFERENCE_CHANNEL, targetKey);
	}
	const fieldKey = typedBlocksReferenceFieldKey(workspaceId, targetId, sourceField ?? "");
	if (!emittedFields.has(fieldKey)) {
		emittedFields.add(fieldKey);
		emit(TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL, fieldKey);
	}
};
var emitBlockChannel = (emit, emitted, channel, keyOf, workspaceId, blockId) => {
	if (!blockId) return;
	const key = keyOf(workspaceId, blockId);
	if (emitted.has(key)) return;
	emitted.add(key);
	emit(channel, key);
};
var refKey = (r) => `${r.id}${SEP}${r.sourceField ?? ""}`;
var referenceSetChanged = (before, after) => {
	if (before.length !== after.length) return true;
	const beforeSet = new Set(before.map(refKey));
	for (const ref of after) if (!beforeSet.has(refKey(ref))) return true;
	return false;
};
/** Diff a single ChangeSnapshot and emit every channel this rule owns
*  (typedBlocks.* + kernel.aliases + kernel.content). Pure — no side
*  effects beyond `emit`. */
var emitKernelInvalidations = (snapshot, emit, fallbackBlockId) => {
	const beforeLive = !!snapshot.before && !snapshot.before.deleted;
	const afterLive = !!snapshot.after && !snapshot.after.deleted;
	const blockId = snapshot.after?.id ?? snapshot.before?.id ?? fallbackBlockId;
	const emittedTypes = /* @__PURE__ */ new Set();
	const emittedProps = /* @__PURE__ */ new Set();
	const emittedRefTargets = /* @__PURE__ */ new Set();
	const emittedRefFields = /* @__PURE__ */ new Set();
	const emittedAliases = /* @__PURE__ */ new Set();
	const emittedContent = /* @__PURE__ */ new Set();
	const emittedStructure = /* @__PURE__ */ new Set();
	const emittedRefsOf = /* @__PURE__ */ new Set();
	const emittedLabels = /* @__PURE__ */ new Set();
	const emitAliasesOnce = (workspaceId) => {
		if (emittedAliases.has(workspaceId)) return;
		emittedAliases.add(workspaceId);
		emit(KERNEL_ALIASES_CHANNEL, kernelAliasesKey(workspaceId));
	};
	const emitContentOnce = (workspaceId) => {
		if (emittedContent.has(workspaceId)) return;
		emittedContent.add(workspaceId);
		emit(KERNEL_CONTENT_CHANNEL, kernelContentKey(workspaceId));
	};
	const emitStructure = (workspaceId) => {
		emitBlockChannel(emit, emittedStructure, TYPED_BLOCKS_STRUCTURE_CHANNEL, typedBlocksStructureKey, workspaceId, blockId);
	};
	const emitRefsOf = (workspaceId) => {
		emitBlockChannel(emit, emittedRefsOf, TYPED_BLOCKS_REFS_OF_CHANNEL, typedBlocksRefsOfKey, workspaceId, blockId);
	};
	const emitLabel = (workspaceId) => {
		emitBlockChannel(emit, emittedLabels, TYPED_BLOCKS_LABEL_CHANNEL, typedBlocksLabelKey, workspaceId, blockId);
	};
	const emitLiveSideAxes = (side) => {
		const workspaceId = side.workspaceId;
		if (!workspaceId) return;
		emit(TYPED_BLOCKS_LIVE_CHANNEL, typedBlocksLiveKey(workspaceId));
		for (const t of decodeTypes(side.properties)) emitTypeChannel(emit, emittedTypes, workspaceId, t);
		if (side.properties) for (const name of Object.keys(side.properties)) emitPropertyChannel(emit, emittedProps, workspaceId, name);
		if (side.references) for (const ref of side.references) emitReferenceChannels(emit, emittedRefTargets, emittedRefFields, workspaceId, ref.id, ref.sourceField);
		emitContentOnce(workspaceId);
		emitStructure(workspaceId);
		emitRefsOf(workspaceId);
		emitLabel(workspaceId);
		if (hasAlias(side.properties)) emitAliasesOnce(workspaceId);
	};
	if (beforeLive !== afterLive || beforeLive && afterLive && snapshot.before?.workspaceId !== snapshot.after?.workspaceId) {
		if (beforeLive && snapshot.before) emitLiveSideAxes(snapshot.before);
		if (afterLive && snapshot.after) emitLiveSideAxes(snapshot.after);
		return;
	}
	if (!beforeLive || !afterLive) return;
	const workspaceId = snapshot.after?.workspaceId ?? snapshot.before?.workspaceId;
	if (!workspaceId) return;
	if (snapshot.before?.parentId !== snapshot.after?.parentId) emitStructure(workspaceId);
	const beforeTypes = decodeTypes(snapshot.before?.properties);
	const afterTypes = decodeTypes(snapshot.after?.properties);
	if (beforeTypes.length > 0 || afterTypes.length > 0) {
		const beforeTypeSet = new Set(beforeTypes);
		const afterTypeSet = new Set(afterTypes);
		for (const t of beforeTypes) if (!afterTypeSet.has(t)) emitTypeChannel(emit, emittedTypes, workspaceId, t);
		for (const t of afterTypes) if (!beforeTypeSet.has(t)) emitTypeChannel(emit, emittedTypes, workspaceId, t);
	}
	const beforeProps = snapshot.before?.properties ?? {};
	const afterProps = snapshot.after?.properties ?? {};
	const seenNames = /* @__PURE__ */ new Set();
	for (const name of Object.keys(beforeProps)) {
		seenNames.add(name);
		if (!encodedEqual(beforeProps[name], afterProps[name])) {
			emitPropertyChannel(emit, emittedProps, workspaceId, name);
			if (name === ALIAS_PROPERTY_NAME) {
				emitAliasesOnce(workspaceId);
				emitLabel(workspaceId);
			}
		}
	}
	for (const name of Object.keys(afterProps)) {
		if (seenNames.has(name)) continue;
		if (!encodedEqual(beforeProps[name], afterProps[name])) {
			emitPropertyChannel(emit, emittedProps, workspaceId, name);
			if (name === ALIAS_PROPERTY_NAME) {
				emitAliasesOnce(workspaceId);
				emitLabel(workspaceId);
			}
		}
	}
	if ((snapshot.before?.content ?? "") !== (snapshot.after?.content ?? "")) {
		emitContentOnce(workspaceId);
		emitLabel(workspaceId);
	}
	const beforeRefs = snapshot.before?.references ?? [];
	const afterRefs = snapshot.after?.references ?? [];
	if (beforeRefs.length > 0 || afterRefs.length > 0) {
		const beforeMap = /* @__PURE__ */ new Map();
		for (const r of beforeRefs) beforeMap.set(refKey(r), r);
		const afterMap = /* @__PURE__ */ new Map();
		for (const r of afterRefs) afterMap.set(refKey(r), r);
		for (const [k, r] of beforeMap) if (!afterMap.has(k)) emitReferenceChannels(emit, emittedRefTargets, emittedRefFields, workspaceId, r.id, r.sourceField);
		for (const [k, r] of afterMap) if (!beforeMap.has(k)) emitReferenceChannels(emit, emittedRefTargets, emittedRefFields, workspaceId, r.id, r.sourceField);
	}
	if (referenceSetChanged(beforeRefs, afterRefs)) emitRefsOf(workspaceId);
};
var kernelInvalidationRule = {
	id: "core.kernelInvalidation",
	collectFromSnapshots: (snapshots, emit) => {
		for (const [id, snapshot] of snapshots) emitKernelInvalidations(snapshot, emit, id);
	}
};
//#endregion
export { emitKernelInvalidations, kernelInvalidationRule };

//# sourceMappingURL=kernelInvalidation.js.map