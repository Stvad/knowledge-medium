import { ChangeScope } from "../../data/api/changeScope.js";
import { defineMutator } from "../../data/api/mutator.js";
import { array, object, string } from "../../../node_modules/zod/v4/classic/schemas.js";
import "../../data/api/index.js";
import { aliasesProp } from "../../data/properties.js";
import { mergeProperties } from "../../data/mergeProperties.js";
import { mergeBlocksInTx } from "../../data/blockMerge.js";
//#region src/plugins/alias/collisionMerge.ts
var ALIAS_COLLISION_MERGE_MUTATOR = "alias.mergeCollision";
var aliasCollisionMergeArgsSchema = object({
	intoId: string(),
	fromId: string(),
	collisionAlias: string(),
	dropSourceAliases: array(string()).optional()
});
var decodeAliases = (block) => {
	const encoded = block.properties[aliasesProp.name];
	if (encoded === void 0) return [];
	try {
		return aliasesProp.codec.decode(encoded);
	} catch {
		return [];
	}
};
var union = (values) => {
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const value of values) {
		if (seen.has(value)) continue;
		seen.add(value);
		out.push(value);
	}
	return out;
};
var collisionAwarePropertyMerge = (into, from, collisionAlias, dropSourceAliases) => {
	const merged = mergeProperties(into.properties, from.properties);
	const drop = new Set(dropSourceAliases);
	const intoAliases = decodeAliases(into);
	const keptFromAliases = decodeAliases(from).filter((alias) => alias !== collisionAlias && !drop.has(alias));
	merged[aliasesProp.name] = aliasesProp.codec.encode(union([...intoAliases, ...keptFromAliases]));
	return merged;
};
var aliasCollisionMerge = defineMutator({
	name: ALIAS_COLLISION_MERGE_MUTATOR,
	argsSchema: aliasCollisionMergeArgsSchema,
	scope: ChangeScope.BlockDefault,
	describe: ({ fromId, intoId }) => `merge alias collision ${fromId} → ${intoId}`,
	apply: async (tx, { intoId, fromId, collisionAlias, dropSourceAliases = [] }) => {
		const into = await tx.get(intoId);
		const from = await tx.get(fromId);
		if (into === null) throw new Error(`alias.mergeCollision: target ${intoId} not found`);
		if (from === null) throw new Error(`alias.mergeCollision: source ${fromId} not found`);
		await mergeBlocksInTx(tx, {
			into,
			from,
			contentStrategy: "keepTarget",
			mergeProperties: (intoProps, fromProps) => collisionAwarePropertyMerge({
				...into,
				properties: intoProps
			}, {
				...from,
				properties: fromProps
			}, collisionAlias, dropSourceAliases),
			aliasRewrites: dropSourceAliases.map((fromAlias) => ({
				fromAlias,
				toAlias: collisionAlias
			}))
		});
	}
});
var aliasCollisionMutators = [aliasCollisionMerge];
//#endregion
export { ALIAS_COLLISION_MERGE_MUTATOR, aliasCollisionMerge, aliasCollisionMutators };

//# sourceMappingURL=collisionMerge.js.map