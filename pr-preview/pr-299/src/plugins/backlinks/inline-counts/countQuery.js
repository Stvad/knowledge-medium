import { defineQuery } from "../../../data/api/query.js";
import { object, string } from "../../../../node_modules/zod/v4/classic/schemas.js";
import "../../../data/api/index.js";
import { TYPED_BLOCKS_STRUCTURE_CHANNEL, typedBlocksStructureKey } from "../../../data/invalidation.js";
//#region src/plugins/backlinks/inline-counts/countQuery.ts
var BACKLINKS_COUNT_FOR_BLOCK_QUERY = "backlinks.countForBlock";
/** Backlink *count* for the inline badge — the cardinality of the unfiltered
*  `backlinks.forBlock` set without materialising the id list. Drives through
*  the same indexed `block_references` candidate set via `core.typedBlockCount`,
*  so its membership and invalidation match `backlinks.forBlock` exactly, and
*  excludes the self-reference in SQL with a self-scope `exclude` predicate —
*  the SQL analogue of `forBlock`'s `ids.filter(s => s !== id)`.
*
*  Intentionally UNFILTERED, even though the expanded `LinkedReferences` may
*  apply a page / daily-note backlink filter (rendered as "matched / total").
*  The badge tracks the *total* — i.e. the denominator the user sees on
*  expand — so "5" on the badge and "2 / 5" in the expanded header agree.
*
*  Explicit const type (like `backlinksForBlockQuery`) so `typeof` is knowable
*  without inferring this initializer, which would loop through QueryRegistry
*  via the `ctx.run` below. */
var backlinksCountForBlockQuery = defineQuery({
	name: BACKLINKS_COUNT_FOR_BLOCK_QUERY,
	argsSchema: object({
		workspaceId: string(),
		id: string()
	}),
	resultSchema: { parse: (input) => input },
	resolve: async ({ workspaceId, id }, ctx) => {
		if (!workspaceId || !id) return 0;
		ctx.depend({
			kind: "plugin",
			channel: TYPED_BLOCKS_STRUCTURE_CHANNEL,
			key: typedBlocksStructureKey(workspaceId, id)
		});
		return ctx.run("core.typedBlockCount", {
			workspaceId,
			referencedBy: { id },
			exclude: [{
				scope: "self",
				id
			}]
		});
	}
});
//#endregion
export { BACKLINKS_COUNT_FOR_BLOCK_QUERY, backlinksCountForBlockQuery };

//# sourceMappingURL=countQuery.js.map