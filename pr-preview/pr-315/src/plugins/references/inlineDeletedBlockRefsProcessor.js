import { normalizeReferences } from "../../data/api/blockData.js";
import { CORE_BLOCK_DELETED_EVENT } from "../../data/api/events.js";
import { defineSameTxProcessor } from "../../data/api/sameTxProcessor.js";
import "../../data/api/index.js";
import { inlineBlockRefs } from "./referenceParser.js";
//#region src/plugins/references/inlineDeletedBlockRefsProcessor.ts
/**
* Same-tx processor: when a block is deleted, inline its content into the
* blocks that referenced it via `((id))` syntax.
*
* Without this, deleting a block leaves every `((deletedId))`,
* `!((deletedId))`, and `[label](((deletedId)))` mark in other blocks
* pointing at a tombstone — a dangling reference that renders as nothing
* useful. This processor rewrites those marks in place to the text they
* displayed (the deleted block's content, or the aliased label) and drops
* the now-stale block-ref entries from each referrer's `references` array,
* atomically with the originating delete tx.
*
* It watches `CORE_BLOCK_DELETED_EVENT`, emitted by the `core.delete`
* mutator for each freshly soft-deleted block in the subtree. The reason
* to run same-tx (rather than post-commit, like `parseReferences`) is undo
* coherence: the referrer rewrites land in the same snapshot/undo entry as
* the delete, so one undo restores both, and referrers never transiently
* show a dangling ref.
*
* Transitive deletes: a deleted block's own content may reference another
* block deleted in the same tx (e.g. deleting a subtree where a child
* embeds a sibling). `apply` collects every deleted block's content up
* front and resolves those nested refs (`resolveInlineContent`) before
* inlining, so the text spliced into a referrer never contains a `((id))`
* mark for an also-deleted block — otherwise post-commit `parseReferences`
* would re-derive a brand-new dangling ref from the inlined text, the exact
* failure mode this feature exists to prevent. Reference cycles among
* deleted blocks fall back to raw content (bounded, no fixpoint).
*/
var INLINE_DELETED_BLOCK_REFERENCES_PROCESSOR = "references.inlineDeletedBlockReferences";
var SELECT_LIVE_REFERENCE_SOURCE_IDS_SQL = `
  SELECT DISTINCT br.source_id AS id
  FROM block_references br
  JOIN blocks source ON source.id = br.source_id
  WHERE br.workspace_id = ?
    AND br.target_id = ?
    AND source.deleted = 0
  ORDER BY source.order_key, source.id
`;
/** True for a `references` entry that came from `((id))` block-ref syntax
*  in content: those project to `{id, alias: id}` with no `sourceField`
*  (see the reference parser). Wikilink refs (`alias !== id`) and
*  property-derived refs (`sourceField` set) to the same id are NOT block
*  refs — we only rewrote block-ref content, so those entries stay. */
var isContentBlockRefTo = (ref, deletedId) => ref.id === deletedId && ref.alias === deletedId && ref.sourceField === void 0;
/** The text to splice in for refs to `id`: its own content with refs to
*  the OTHER blocks deleted in this tx already inlined, so the result holds
*  no `((alsoDeleted))` marks. Memoized; a ref cycle among deleted blocks
*  short-circuits to raw content (the `stack` guard) rather than looping. */
var resolveInlineContent = (id, deletedContent, memo, stack) => {
	const cached = memo.get(id);
	if (cached !== void 0) return cached;
	const raw = deletedContent.get(id) ?? "";
	if (stack.has(id)) return raw;
	stack.add(id);
	let resolved = raw;
	for (const otherId of deletedContent.keys()) {
		if (otherId === id) continue;
		resolved = inlineBlockRefs(resolved, otherId, resolveInlineContent(otherId, deletedContent, memo, stack));
	}
	stack.delete(id);
	memo.set(id, resolved);
	return resolved;
};
var inlineSource = async (tx, sourceId, deletedId, inlineContent) => {
	const current = await tx.get(sourceId);
	if (current === null || current.deleted) return;
	const nextContent = inlineBlockRefs(current.content, deletedId, inlineContent);
	const nextReferences = normalizeReferences(current.references.filter((ref) => !isContentBlockRefTo(ref, deletedId)));
	const patch = {};
	if (nextContent !== current.content) patch.content = nextContent;
	if (JSON.stringify(nextReferences) !== JSON.stringify(current.references)) patch.references = nextReferences;
	if (Object.keys(patch).length === 0) return;
	await tx.update(current.id, patch, { skipMetadata: true });
};
var inlineDeletedBlockRefsProcessor = defineSameTxProcessor({
	name: INLINE_DELETED_BLOCK_REFERENCES_PROCESSOR,
	watches: {
		kind: "event",
		events: [CORE_BLOCK_DELETED_EVENT]
	},
	apply: async (event, ctx) => {
		const deletedContent = /* @__PURE__ */ new Map();
		const workspaceById = /* @__PURE__ */ new Map();
		for (const emitted of event.emittedEvents) {
			const { blockId, workspaceId } = emitted.payload;
			const block = await ctx.tx.get(blockId);
			deletedContent.set(blockId, block?.content ?? "");
			workspaceById.set(blockId, workspaceId);
		}
		const memo = /* @__PURE__ */ new Map();
		for (const [blockId, workspaceId] of workspaceById) {
			const sourceRows = await ctx.db.getAll(SELECT_LIVE_REFERENCE_SOURCE_IDS_SQL, [workspaceId, blockId]);
			if (sourceRows.length === 0) continue;
			const inlineContent = resolveInlineContent(blockId, deletedContent, memo, /* @__PURE__ */ new Set());
			for (const { id } of sourceRows) await inlineSource(ctx.tx, id, blockId, inlineContent);
		}
	}
});
//#endregion
export { INLINE_DELETED_BLOCK_REFERENCES_PROCESSOR, inlineDeletedBlockRefsProcessor };

//# sourceMappingURL=inlineDeletedBlockRefsProcessor.js.map