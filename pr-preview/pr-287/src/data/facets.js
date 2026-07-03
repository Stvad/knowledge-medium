import { defineFacet, keyedMapFacet } from "../facets/facet.js";
//#region src/data/facets.ts
/**
* Data-layer facets — the bridge between the kernel + plugin
* contributions and the `Repo` lifecycle (spec §6, §8).
*
* Stage 1.4 ships `mutatorsFacet` only. The remaining four facets
* (`queriesFacet`, `propertySchemasFacet`, `propertyEditorOverridesFacet`,
* `postCommitProcessorsFacet`) land in stages 1.5+ as the matching
* machinery comes online.
*/
var isRecord = (value) => typeof value === "object" && value !== null;
var isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
var isLocalSchemaBackfill = (value) => isRecord(value) && typeof value.id === "string" && typeof value.run === "function";
var isLocalSchemaContribution = (value) => isRecord(value) && typeof value.id === "string" && (value.statements === void 0 || isStringArray(value.statements)) && (value.triggerNames === void 0 || isStringArray(value.triggerNames)) && (value.backfills === void 0 || Array.isArray(value.backfills) && value.backfills.every(isLocalSchemaBackfill));
var isWorkspaceBackfill = (value) => isRecord(value) && typeof value.id === "string" && typeof value.run === "function";
var isInvalidationRule = (value) => isRecord(value) && typeof value.id === "string" && (value.collectFromSnapshots === void 0 || typeof value.collectFromSnapshots === "function");
var isDefinitionBlockProjector = (value) => isRecord(value) && typeof value.id === "string" && typeof value.metaType === "string" && typeof value.sourceId === "string" && typeof value.project === "function" && typeof value.keyOf === "function" && isRecord(value.targetFacet) && typeof value.targetFacet.id === "string";
/** Key the registry by `Mutator.name`; duplicates log a warning and
*  last-wins (per §6 convention). Mutators with heterogeneous
*  Args/Result types share the registry slot via `AnyMutator` (variance
*  escape); call-site dispatch (`repo.mutate.X`, `tx.run(m, args)`)
*  recovers precise types via the `MutatorRegistry` augmentation. */
var mutatorsFacet = keyedMapFacet("data.mutators", (m) => m.name);
/** Future facets — declared empty for now so plugin authors can
*  reference them at compile time without runtime breakage when no
*  contributions exist. Wired up in stages 1.5+. */
var queriesFacet = keyedMapFacet("data.queries", (q) => q.name);
var propertySchemasFacet = keyedMapFacet("data.propertySchemas", (s) => s.name);
var typesFacet = keyedMapFacet("data.types", (t) => t.id);
var propertyEditorOverridesFacet = keyedMapFacet("data.property-editor-overrides", (c) => c.name);
/** Open-vocabulary preset registry. Keyed by preset id (matches the
*  codec `type` for codecs built by the preset). Last-wins on
*  collision, per facet convention. Plugins register through
*  `valuePresetsFacet.of(preset, {source: 'plugin'})`. */
var valuePresetsFacet = keyedMapFacet("data.valuePresets", (p) => p.id);
var postCommitProcessorsFacet = keyedMapFacet("data.postCommitProcessors", (p) => p.name);
var sameTxProcessorsFacet = keyedMapFacet("data.sameTxProcessors", (p) => p.name);
var localSchemaFacet = defineFacet({
	id: "data.localSchema",
	validate: isLocalSchemaContribution
});
var workspaceBackfillsFacet = defineFacet({
	id: "data.workspaceBackfills",
	validate: isWorkspaceBackfill
});
var isSystemPage = (value) => isRecord(value) && typeof value.id === "string" && typeof value.ensure === "function";
var systemPagesFacet = defineFacet({
	id: "data.systemPages",
	validate: isSystemPage
});
var refTargetFilterDefaultsFacet = keyedMapFacet("data.refTargetFilterDefaults", (d) => d.targetType);
var invalidationRulesFacet = defineFacet({
	id: "data.invalidationRules",
	validate: isInvalidationRule
});
/** Registry of definition-block projectors — the "data-defined
*  contributions over facets" pattern (issue #90). Each contribution
*  watches blocks of a meta-type and mirrors them into a target
*  facet's `'user-data'` bucket; `ProjectorRuntime` drives the shared
*  lifecycle. List-valued (started in `dependsOn` order), not keyed,
*  since nothing looks a projector up by id through the facet — the
*  driver enumerates them. */
var definitionBlockProjectorFacet = defineFacet({
	id: "data.definitionBlockProjectors",
	validate: isDefinitionBlockProjector
});
//#endregion
export { definitionBlockProjectorFacet, invalidationRulesFacet, localSchemaFacet, mutatorsFacet, postCommitProcessorsFacet, propertyEditorOverridesFacet, propertySchemasFacet, queriesFacet, refTargetFilterDefaultsFacet, sameTxProcessorsFacet, systemPagesFacet, typesFacet, valuePresetsFacet, workspaceBackfillsFacet };

//# sourceMappingURL=facets.js.map