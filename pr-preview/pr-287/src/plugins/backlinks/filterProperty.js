import { ChangeScope } from "../../data/api/changeScope.js";
import { defineProperty } from "../../data/api/propertySchema.js";
import "../../data/api/index.js";
import { normalizeBacklinksFilter } from "./query.js";
//#region src/plugins/backlinks/filterProperty.ts
var EMPTY_BACKLINKS_FILTER = {
	include: [],
	exclude: []
};
var isObjectRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var parsePredicate = (value) => {
	if (!isObjectRecord(value)) return null;
	const out = {};
	if (value.scope === "self" || value.scope === "ancestor") out.scope = value.scope;
	if (typeof value.id === "string") out.id = value.id;
	if (isObjectRecord(value.where) && Object.keys(value.where).length > 0) out.where = value.where;
	if (isObjectRecord(value.referencedBy) && typeof value.referencedBy.id === "string") {
		const ref = { id: value.referencedBy.id };
		if (typeof value.referencedBy.sourceField === "string") ref.sourceField = value.referencedBy.sourceField;
		out.referencedBy = ref;
	}
	return out.where || out.referencedBy || out.id ? out : null;
};
var parsePredicateList = (value) => {
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const entry of value) {
		const parsed = parsePredicate(entry);
		if (parsed) out.push(parsed);
	}
	return out;
};
var parseBacklinksFilter = (value) => {
	if (!isObjectRecord(value)) return {};
	return {
		include: parsePredicateList(value.include),
		exclude: parsePredicateList(value.exclude)
	};
};
/** Filter codec name was bumped from 'backlinks:filter' to
*  'backlinks:predicates' when the storage shape moved from
*  `{includeIds, removeIds}` to `{include, exclude}` of BlockPredicate.
*  Old values stored under the previous name (and its property name)
*  are intentionally discarded. */
var backlinksFilterCodec = {
	type: "backlinks:predicates",
	encode: (value) => normalizeBacklinksFilter(value),
	decode: (value) => normalizeBacklinksFilter(parseBacklinksFilter(value))
};
var backlinksFilterProp = defineProperty("backlinks:predicates", {
	codec: backlinksFilterCodec,
	defaultValue: EMPTY_BACKLINKS_FILTER,
	changeScope: ChangeScope.BlockDefault
});
var readBacklinksFilterProperty = (value) => backlinksFilterProp.codec.decode(value);
//#endregion
export { EMPTY_BACKLINKS_FILTER, backlinksFilterCodec, backlinksFilterProp, readBacklinksFilterProperty };

//# sourceMappingURL=filterProperty.js.map