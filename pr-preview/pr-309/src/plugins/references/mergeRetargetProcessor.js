import { normalizeReferences } from "../../data/api/blockData.js";
import { CORE_BLOCK_MERGED_EVENT } from "../../data/api/events.js";
import { defineSameTxProcessor } from "../../data/api/sameTxProcessor.js";
import "../../data/api/index.js";
import { parseReferences, renderAliasedBlockref, renderWikilink, rewriteBlockRefs, rewriteWikilinks } from "./referenceParser.js";
import { inlineDeletedBlockRefsProcessor } from "./inlineDeletedBlockRefsProcessor.js";
//#region src/plugins/references/mergeRetargetProcessor.ts
var RETARGET_MERGED_BLOCK_REFERENCES_PROCESSOR = "references.retargetMergedBlockReferences";
var SELECT_LIVE_REFERENCE_SOURCE_IDS_SQL = `
  SELECT DISTINCT br.source_id AS id
  FROM block_references br
  JOIN blocks source ON source.id = br.source_id
  WHERE br.workspace_id = ?
    AND br.target_id = ?
    AND source.deleted = 0
  ORDER BY source.order_key, source.id
`;
var replacementForAlias = (alias, targetId) => {
	const candidate = renderWikilink(alias);
	if (parseReferences(candidate)[0]?.alias === alias) return candidate;
	return renderAliasedBlockref(alias, targetId);
};
var retargetReference = (ref, fromId, intoId, aliasRewrites) => {
	if (ref.id !== fromId) return ref;
	const nextAlias = ref.alias === fromId ? intoId : aliasRewrites.get(ref.alias) ?? ref.alias;
	return ref.sourceField === void 0 ? {
		id: intoId,
		alias: nextAlias
	} : {
		id: intoId,
		alias: nextAlias,
		sourceField: ref.sourceField
	};
};
var retargetReferenceContent = (content, fromId, intoId, aliasRewrites) => {
	let next = rewriteBlockRefs(content, fromId, intoId);
	for (const [fromAlias, toAlias] of aliasRewrites) next = rewriteWikilinks(next, fromAlias, replacementForAlias(toAlias, intoId));
	return next;
};
var retargetSource = async (tx, sourceId, event, aliasRewrites) => {
	const current = await tx.get(sourceId);
	if (current === null || current.deleted) return;
	const nextReferences = normalizeReferences(current.references.map((ref) => retargetReference(ref, event.fromId, event.intoId, aliasRewrites)));
	const nextContent = retargetReferenceContent(current.content, event.fromId, event.intoId, aliasRewrites);
	const patch = {};
	if (nextContent !== current.content) patch.content = nextContent;
	if (JSON.stringify(nextReferences) !== JSON.stringify(current.references)) patch.references = nextReferences;
	if (Object.keys(patch).length === 0) return;
	await tx.update(current.id, patch, { skipMetadata: true });
};
var retargetMergedBlockReferences = async (event, ctx) => {
	const sourceRows = await ctx.db.getAll(SELECT_LIVE_REFERENCE_SOURCE_IDS_SQL, [event.workspaceId, event.fromId]);
	if (sourceRows.length === 0) return;
	const aliasRewrites = new Map(event.aliasRewrites.map(({ fromAlias, toAlias }) => [fromAlias, toAlias]));
	for (const { id } of sourceRows) await retargetSource(ctx.tx, id, event, aliasRewrites);
};
var retargetMergedBlockReferencesProcessor = defineSameTxProcessor({
	name: RETARGET_MERGED_BLOCK_REFERENCES_PROCESSOR,
	watches: {
		kind: "event",
		events: [CORE_BLOCK_MERGED_EVENT]
	},
	apply: async (event, ctx) => {
		for (const emitted of event.emittedEvents) await retargetMergedBlockReferences(emitted.payload, ctx);
	}
});
var referencesSameTxProcessors = [retargetMergedBlockReferencesProcessor, inlineDeletedBlockRefsProcessor];
//#endregion
export { RETARGET_MERGED_BLOCK_REFERENCES_PROCESSOR, referencesSameTxProcessors, retargetMergedBlockReferencesProcessor };

//# sourceMappingURL=mergeRetargetProcessor.js.map