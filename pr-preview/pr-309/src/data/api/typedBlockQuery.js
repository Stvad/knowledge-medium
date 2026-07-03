import { _enum, array, object, record, string, unknown } from "../../../node_modules/zod/v4/classic/schemas.js";
//#region src/data/api/typedBlockQuery.ts
/** Runtime validators for the predicate language above. Co-located with the
*  types so a field added to `BlockPredicate` / `TypedBlockQueryReferenceFilter`
*  can't silently drift from its validator. Shared by the kernel typed-block
*  query and the backlinks / grouped-backlinks plugins. Exposed as bare objects;
*  each call site applies `.optional()` / `.array()` as it needs. */
var referenceFilterSchema = object({
	id: string(),
	sourceField: string().optional()
});
var blockPredicateSchema = object({
	scope: _enum(["self", "ancestor"]).optional(),
	id: string().optional(),
	where: record(string(), unknown()).optional(),
	referencedBy: referenceFilterSchema.optional()
});
var backlinksFilterSchema = object({
	include: array(blockPredicateSchema).optional(),
	exclude: array(blockPredicateSchema).optional()
});
//#endregion
export { backlinksFilterSchema, blockPredicateSchema, referenceFilterSchema };

//# sourceMappingURL=typedBlockQuery.js.map