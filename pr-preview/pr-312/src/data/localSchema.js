import { resolveFacetRuntimeSync } from "../facets/facet.js";
import { localSchemaFacet } from "./facets.js";
//#region src/data/localSchema.ts
var resolveLocalSchemaContributions = (extensions) => resolveFacetRuntimeSync(extensions).read(localSchemaFacet);
var applyLocalSchemaContributions = async (db, contributions) => {
	for (const contribution of contributions) for (const statement of contribution.statements ?? []) await db.execute(statement);
	for (const contribution of contributions) for (const backfill of contribution.backfills ?? []) await backfill.run(db);
};
//#endregion
export { applyLocalSchemaContributions, resolveLocalSchemaContributions };

//# sourceMappingURL=localSchema.js.map