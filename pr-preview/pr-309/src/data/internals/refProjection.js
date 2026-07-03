import { decodeRefListIds, isRefCodec, isRefListCodec } from "../api/codecs.js";
import "../api/index.js";
//#region src/data/internals/refProjection.ts
/** Build the merged property-schema registry: type-lifted schemas first
*  (each `TypeContribution.properties`), then direct `propertySchemasFacet`
*  registrations, last-wins per facet convention with a warning on a
*  genuine conflict (different schema object for the same name). */
var mergeLiftedSchemas = (directSchemas, types) => {
	const merged = /* @__PURE__ */ new Map();
	for (const type of types.values()) for (const schema of type.properties ?? []) {
		const existing = merged.get(schema.name);
		if (existing !== void 0 && existing !== schema) console.warn(`[schema-lift] type "${type.id}" registers schema "${schema.name}" that conflicts with an earlier type-lifted registration; last-wins per facet convention`);
		merged.set(schema.name, schema);
	}
	for (const [name, schema] of directSchemas) {
		const existing = merged.get(name);
		if (existing !== void 0 && existing !== schema) console.warn(`[schema-lift] direct propertySchemasFacet registration "${name}" replaces an earlier type-lifted registration; last-wins per facet convention`);
		merged.set(name, schema);
	}
	return merged;
};
var refCodecKind = (schema) => {
	if (schema === void 0) return void 0;
	if (isRefCodec(schema.codec)) return "ref";
	if (isRefListCodec(schema.codec)) return "refList";
};
/** Names whose ref-ness (ref / refList / not-a-ref) differs between two
*  schema registries — the set a schema swap must reproject. */
var changedRefSchemaNames = (before, after) => {
	const names = new Set([...before.keys(), ...after.keys()]);
	return Array.from(names).filter((name) => refCodecKind(before.get(name)) !== refCodecKind(after.get(name))).sort();
};
var appendRefProjection = (refs, seen, sourceField, id) => {
	const targetId = id.trim();
	if (!targetId) return;
	const key = `${sourceField}\u0000${targetId}`;
	if (seen.has(key)) return;
	seen.add(key);
	refs.push({
		id: targetId,
		alias: targetId,
		sourceField
	});
};
var projectedRefsForField = (block, schema, sourceField) => {
	if (schema === void 0 || !(sourceField in block.properties)) return [];
	const encodedValue = block.properties[sourceField];
	const refs = [];
	const seen = /* @__PURE__ */ new Set();
	if (isRefCodec(schema.codec)) {
		try {
			appendRefProjection(refs, seen, sourceField, schema.codec.decode(encodedValue));
		} catch {
			return [];
		}
		return refs;
	}
	if (isRefListCodec(schema.codec)) for (const id of decodeRefListIds(schema.codec, encodedValue)) appendRefProjection(refs, seen, sourceField, id);
	return refs;
};
/** Reprojection scans can outlive a later schema swap. Pick the schema a
*  parked scan should project a field against:
*   - live registry still knows the name ⇒ project against it, so a genuine
*     ref→non-ref redefine that landed after scheduling strips the stale refs,
*     and a still-ref field re-adds.
*   - live registry no longer knows the name (absent) ⇒ keep the *scheduled*
*     schema, so the scan RETAINS the field's refs instead of stripping them.
*     Absence is "toggled off / not loaded", not a deletion. The caller already
*     drops absent-everywhere names before scanning (see `reprojectRefTyped-
*     Properties`); this guards the narrower race where a name was ref-typed at
*     schedule time but vanished from the live registry by run time (a plugin
*     toggled off, ?safeMode, or an async user/import schema mid-republish).
*     Stripping that field is exactly the silent-deletion vector that wiped
*     ~10k `next-review-date` backlinks on SRS toggle-off.
*
*  The caller passes a *workspace-correct* `currentSchemas`: the live registry
*  only while still on the scan's workspace, else the scheduled snapshot (see
*  `liveSchemas` in `reprojectRefTypedProperties`), so cross-workspace state
*  never decides ref-ness for the captured workspace's blocks. */
var latestRefProjectionSchema = (scheduledSchemas, currentSchemas, name) => {
	const scheduledSchema = scheduledSchemas.get(name);
	const currentSchema = currentSchemas.get(name);
	if (currentSchema === void 0) return scheduledSchema;
	return refCodecKind(scheduledSchema) === refCodecKind(currentSchema) ? scheduledSchema : currentSchema;
};
//#endregion
export { changedRefSchemaNames, latestRefProjectionSchema, mergeLiftedSchemas, projectedRefsForField, refCodecKind };

//# sourceMappingURL=refProjection.js.map