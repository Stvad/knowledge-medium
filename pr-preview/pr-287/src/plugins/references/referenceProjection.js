import { decodeRefListIds, isRefCodec, isRefListCodec } from "../../data/api/codecs.js";
import "../../data/api/index.js";
//#region src/plugins/references/referenceProjection.ts
var appendPropertyRef = (refs, seen, sourceField, id) => {
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
var projectPropertyReferences = (source, propertySchemas) => {
	const refs = [];
	const seen = /* @__PURE__ */ new Set();
	for (const [name, encodedValue] of Object.entries(source.properties)) {
		const schema = propertySchemas.get(name);
		if (!schema) continue;
		if (isRefCodec(schema.codec)) {
			try {
				appendPropertyRef(refs, seen, name, schema.codec.decode(encodedValue));
			} catch {}
			continue;
		}
		if (isRefListCodec(schema.codec)) for (const id of decodeRefListIds(schema.codec, encodedValue)) appendPropertyRef(refs, seen, name, id);
	}
	return refs;
};
/** A prior property-derived ref a recompute must RETAIN rather than drop — the
*  retain-on-source half of the add-only contract
*  (docs/contracts/derived-data-add-only.md). True iff:
*   - it's property-derived (`sourceField` set), AND
*   - its schema is currently ABSENT from the registry — the owning plugin is
*     toggled off / not yet loaded, so we *can't* re-derive it — AND
*   - the field still holds a value (the relationship is still encoded), AND
*   - this write did NOT change that field's own value.
*  The last clause is the one exception to retention: if THIS write changed the
*  field's value, a retained ref would contradict the new value and we can't
*  re-derive it without the schema, so it's allowed to drop. A *present* schema
*  (ref or non-ref) is handled by `projectPropertyReferences` above — it
*  re-derives, or correctly drops a redefined-to-non-ref field's stale refs.
*  Shared by the references post-commit processor and the Roam importer's
*  reference rebuild so both honour the contract identically. */
var isRetainableAbsentRef = (ref, after, before, propertySchemas) => {
	if (!ref.sourceField) return false;
	if (propertySchemas.has(ref.sourceField)) return false;
	const afterValue = after.properties[ref.sourceField];
	if (afterValue === void 0) return false;
	return JSON.stringify(before?.properties[ref.sourceField]) === JSON.stringify(afterValue);
};
//#endregion
export { isRetainableAbsentRef, projectPropertyReferences };

//# sourceMappingURL=referenceProjection.js.map