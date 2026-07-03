import { ROAM_PAGE_ALIAS_PROP, collectAliasesFromRoamSemanticRefListValue, inferRefListTargetTypes, isDailyNoteAlias, isRoamSemanticRefListProperty, parsePageTokenList } from "./properties.js";
//#region src/plugins/roam-import/schemaReconciliation.ts
var SCHEMA_NEAR_MISS_THRESHOLD = .85;
var SCHEMA_NEAR_MISS_MIN_VALUES = 10;
var formatSampleValue = (value) => {
	let formatted;
	try {
		const json = JSON.stringify(value);
		formatted = json === void 0 ? String(value) : json;
	} catch {
		formatted = String(value);
	}
	const normalized = formatted.replace(/\s+/g, " ").trim();
	return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
};
var rememberNonRefListSample = (stats, blockId, value) => {
	stats.nonRefListSamples.push({
		blockRef: `((${blockId}))`,
		value: formatSampleValue(value)
	});
};
var isPureTokenString = (value) => {
	return parsePageTokenList(value) !== null;
};
var tallyTokens = (stats, value) => {
	const tokens = parsePageTokenList(value);
	if (!tokens) return;
	for (const { alias } of tokens) {
		stats.refListTokensTotal += 1;
		if (isDailyNoteAlias(alias)) stats.refListTokensDailyNote += 1;
	}
};
var recordSample = (stats, blockId, value) => {
	stats.totalValues += 1;
	if (typeof value === "number" && Number.isFinite(value)) {
		stats.numbers += 1;
		rememberNonRefListSample(stats, blockId, value);
		return;
	}
	if (typeof value === "boolean") {
		stats.booleans += 1;
		rememberNonRefListSample(stats, blockId, value);
		return;
	}
	if (typeof value === "string" && isPureTokenString(value)) {
		stats.pageTokenStrings += 1;
		tallyTokens(stats, value);
		return;
	}
	if (typeof value === "string") {
		stats.plainStrings += 1;
		rememberNonRefListSample(stats, blockId, value);
		return;
	}
	if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")) {
		if (value.every((item) => isPureTokenString(item))) {
			stats.pageTokenArrays += 1;
			for (const item of value) tallyTokens(stats, item);
		} else {
			stats.plainStringArrays += 1;
			rememberNonRefListSample(stats, blockId, value);
		}
		return;
	}
	rememberNonRefListSample(stats, blockId, value);
};
var classify = (stats) => {
	if (stats.totalValues === 0) return "string";
	if (stats.numbers === stats.totalValues) return "number";
	if (stats.booleans === stats.totalValues) return "boolean";
	if (stats.pageTokenStrings + stats.pageTokenArrays === stats.totalValues) return "refList";
	const plainTextValues = stats.plainStrings + stats.plainStringArrays;
	if (stats.plainStringArrays > 0 && plainTextValues === stats.totalValues) return "list";
	return "string";
};
var schemaNearMissDiagnostic = (name, stats, effectivePreset, schemaSource) => {
	if (stats.totalValues < SCHEMA_NEAR_MISS_MIN_VALUES) return null;
	if (effectivePreset !== "string" && effectivePreset !== "list") return null;
	const refListLike = stats.pageTokenStrings + stats.pageTokenArrays;
	if (refListLike === 0 || refListLike === stats.totalValues) return null;
	const ratio = refListLike / stats.totalValues;
	if (ratio < SCHEMA_NEAR_MISS_THRESHOLD) return null;
	const sourceLabel = schemaSource === "existing" ? `uses existing ${effectivePreset} schema` : `inferred ${effectivePreset}`;
	const percent = Math.round(ratio * 100);
	const nonRefListValues = stats.totalValues - refListLike;
	const samples = stats.nonRefListSamples.length > 0 ? ` Misses: ${stats.nonRefListSamples.map((sample) => `${sample.blockRef}=${sample.value}`).join("; ")}.` : "";
	return `Schema inference near-miss: property "${name}" ${sourceLabel}, but ${refListLike}/${stats.totalValues} values (${percent}%) looked like refList; ${nonRefListValues} non-refList value(s) kept it from refList.${samples}`;
};
var collectSchemaReconciliationPlan = (blocks, repo) => {
	const sampler = /* @__PURE__ */ new Map();
	for (const block of blocks) {
		if (!block.properties) continue;
		for (const [name, value] of Object.entries(block.properties)) {
			const stats = sampler.get(name) ?? {
				totalValues: 0,
				numbers: 0,
				booleans: 0,
				pageTokenStrings: 0,
				pageTokenArrays: 0,
				plainStringArrays: 0,
				plainStrings: 0,
				refListTokensTotal: 0,
				refListTokensDailyNote: 0,
				nonRefListSamples: []
			};
			recordSample(stats, block.id, value);
			sampler.set(name, stats);
		}
	}
	const toRegister = [];
	const skippedReserved = [];
	const diagnostics = [];
	const schemas = repo.propertySchemas;
	const overrides = repo.propertyEditorOverrides;
	for (const [name, stats] of sampler) {
		const inferredPreset = isRoamSemanticRefListProperty(name) ? "refList" : classify(stats);
		const existingSchema = schemas.get(name);
		if (existingSchema) {
			const diagnostic = schemaNearMissDiagnostic(name, stats, existingSchema.codec.type, "existing");
			if (diagnostic) diagnostics.push(diagnostic);
			continue;
		}
		if (overrides.get(name)?.hidden === true) {
			skippedReserved.push(name);
			continue;
		}
		const diagnostic = schemaNearMissDiagnostic(name, stats, inferredPreset, "inferred");
		if (diagnostic) diagnostics.push(diagnostic);
		const targetTypes = inferredPreset === "refList" ? inferRefListTargetTypes({
			total: stats.refListTokensTotal,
			dailyNote: stats.refListTokensDailyNote
		}) : void 0;
		toRegister.push(targetTypes ? {
			name,
			presetId: inferredPreset,
			targetTypes
		} : {
			name,
			presetId: inferredPreset
		});
	}
	return {
		toRegister,
		skippedReserved,
		diagnostics
	};
};
/** Apply phase: register every classified schema synchronously through
*  `userSchemas.addSchema`. Each call persists a property-schema block
*  under the workspace's Properties page AND adds the runtime
*  contribution before content blocks are written. Failures are
*  logged into `diagnostics` and the schema is skipped — content blocks
*  whose property values use the missing schema fall through to the
*  unknown-schema read fallback (per §9). */
var applySchemaReconciliation = async (toRegister, repo, diagnostics) => {
	for (const entry of toRegister) {
		const { name, presetId } = entry;
		const config = entry.targetTypes ? { targetTypes: entry.targetTypes } : void 0;
		try {
			await repo.userSchemas.addSchema({
				name,
				presetId,
				config
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			diagnostics.push(`Failed to register schema "${name}" (preset ${presetId}): ${message}`);
		}
	}
};
var jsonStringify = (value) => {
	try {
		const json = JSON.stringify(value);
		return json === void 0 ? String(value) : json;
	} catch {
		return String(value);
	}
};
/** String-schema normalization for mixed Roam attributes. Some Roam
*  fields are scalar on most pages but multi-value arrays on a few
*  pages (`email::` with child bullets, `Twitter::` with multiple
*  accounts, etc.). When reconciliation chooses the string preset for
*  that mixed field, preserve the non-string JSON shape as a JSON text
*  value so the registered string codec can decode it. */
var normalizeStringPropertyValues = (blocks, stringPropertyNames) => {
	if (stringPropertyNames.size === 0) return;
	for (const block of blocks) {
		if (!block.properties) continue;
		for (const name of stringPropertyNames) {
			if (!(name in block.properties)) continue;
			const raw = block.properties[name];
			if (typeof raw === "string") continue;
			block.properties[name] = jsonStringify(raw);
		}
	}
};
/** List-schema normalization for Roam attributes. Promotion emits a
*  scalar for single `key:: value` occurrences and an array for
*  repeated/child-list occurrences. When schema reconciliation picks
*  the list preset, wrap the scalar cases so every stored value matches
*  the list codec shape instead of being rejected on decode. */
var normalizeListPropertyValues = (blocks, listPropertyNames) => {
	if (listPropertyNames.size === 0) return;
	for (const block of blocks) {
		if (!block.properties) continue;
		for (const name of listPropertyNames) {
			if (!(name in block.properties)) continue;
			const raw = block.properties[name];
			if (Array.isArray(raw)) continue;
			block.properties[name] = [raw];
		}
	}
};
/** Token-→-id normalization for ref/refList-typed properties. Walks
*  every planned block and, for each property whose name is in
*  `refPropertyKinds`, converts `[[X]]` token strings/arrays into the
*  shape the codec expects:
*    - `'ref'`     → first resolved id (single string), or empty
*                    string when nothing resolves.
*    - `'refList'` → array of resolved ids (any order, drops
*                    unresolved ones).
*
*  Without this pass the codec's `decode` would reject the raw token
*  shape on first read. Tokens we can't resolve are reported through
*  `diagnostics` so the user can fix dangling references later. */
var normalizeRefPropertyValues = (blocks, refPropertyKinds, aliasIdMap, diagnostics) => {
	if (refPropertyKinds.size === 0) return;
	for (const block of blocks) {
		if (!block.properties) continue;
		for (const [name, kind] of refPropertyKinds) {
			if (!(name in block.properties)) continue;
			const raw = block.properties[name];
			const plainAliasMode = name === ROAM_PAGE_ALIAS_PROP ? "conservative" : "broad";
			const tokens = isRoamSemanticRefListProperty(name) ? collectAliasesFromRoamSemanticRefListValue(raw, plainAliasMode) : collectTokens(raw);
			if (tokens === null) continue;
			const ids = [];
			const dangling = [];
			for (const alias of tokens) {
				const id = aliasIdMap.get(alias);
				if (id) ids.push(id);
				else dangling.push(alias);
			}
			if (dangling.length > 0) diagnostics.push(`Block ${block.id}: ${kind} property "${name}" has unresolved aliases: ${dangling.join(", ")}`);
			if (kind === "ref") {
				if (ids.length > 1) diagnostics.push(`Block ${block.id}: ref property "${name}" had ${ids.length} aliases; keeping the first`);
				block.properties[name] = ids[0] ?? "";
			} else block.properties[name] = ids;
		}
	}
};
var collectTokens = (raw) => {
	if (typeof raw === "string") return parsePageTokenList(raw)?.map((token) => token.alias) ?? null;
	if (Array.isArray(raw)) {
		if (raw.length === 0) return [];
		if (!raw.every((item) => typeof item === "string")) return null;
		const out = [];
		for (const item of raw) {
			const tokens = parsePageTokenList(item);
			if (tokens) out.push(...tokens.map((token) => token.alias));
		}
		return out;
	}
	return null;
};
//#endregion
export { applySchemaReconciliation, collectSchemaReconciliationPlan, normalizeListPropertyValues, normalizeRefPropertyValues, normalizeStringPropertyValues };

//# sourceMappingURL=schemaReconciliation.js.map