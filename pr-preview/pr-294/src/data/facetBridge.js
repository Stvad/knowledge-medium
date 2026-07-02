import { changedRefSchemaNames, mergeLiftedSchemas } from "./internals/refProjection.js";
import { invalidationRulesFacet, mutatorsFacet, postCommitProcessorsFacet, propertyEditorOverridesFacet, propertySchemasFacet, queriesFacet, sameTxProcessorsFacet, typesFacet, valuePresetsFacet, workspaceBackfillsFacet } from "./facets.js";
import { CallbackSet } from "../utils/callbackSet.js";
//#region src/data/facetBridge.ts
var FacetBridge = class {
	/** Currently-installed FacetRuntime. Null until the first
	*  `setFacetRuntime` call. */
	runtime = null;
	/** Per-facet listener disposers from `onFacetChange` registrations.
	*  Cleared when `setFacetRuntime` swaps to a fresh runtime — old
	*  listeners would fire against stale rebuild closures otherwise. */
	runtimeFacetUnsubs = [];
	/** Listeners for property-schema map changes (full rebuild OR
	*  runtime-bucket update). Used by `usePropertySchemas` to drive React
	*  reruns. */
	propertySchemasListeners = new CallbackSet("Repo.propertySchemas");
	/** Listeners for `_types` map changes. Symmetric to
	*  propertySchemasListeners. Used by `createTypeBlock`'s commit→
	*  registration handoff to bridge two txs without polling. */
	typesListeners = new CallbackSet("Repo.types");
	/** Listeners for property-editor-override map changes. */
	propertyEditorOverridesListeners = new CallbackSet("Repo.propertyEditorOverrides");
	/** Listeners for value-preset map changes. */
	valuePresetsListeners = new CallbackSet("Repo.valuePresets");
	rebuildSteps;
	constructor(target) {
		this.target = target;
		this.rebuildSteps = this.makeRebuildSteps();
	}
	/** Read-only handle on the currently-installed FacetRuntime. Used by
	*  non-React callers that need to consult facets at action-handler time
	*  (e.g. `pickBlockDateAdapter` from a multi-select handler where
	*  `useAppRuntime()` isn't available). Returns null before the first
	*  `setFacetRuntime` call. */
	get facetRuntime() {
		return this.runtime;
	}
	/** Update the data-layer registries from a FacetRuntime (spec §8).
	*  Decomposes into the named rebuild steps; the same set runs for full
	*  swaps and for the per-facet `setRuntimeContributions` change path. */
	setFacetRuntime(runtime) {
		for (const dispose of this.runtimeFacetUnsubs) dispose();
		this.runtimeFacetUnsubs = [];
		const previous = this.runtime;
		this.runtime = runtime;
		if (previous) runtime.adoptDurableContributionsFrom(previous);
		for (const step of this.rebuildSteps) step.run(runtime);
		const stepsByFacetId = /* @__PURE__ */ new Map();
		for (const step of this.rebuildSteps) for (const input of step.inputs) {
			const list = stepsByFacetId.get(input.id) ?? [];
			list.push(step);
			stepsByFacetId.set(input.id, list);
		}
		for (const [facetId, steps] of stepsByFacetId) {
			const unsub = runtime.onFacetChange(facetId, () => {
				for (const step of steps) step.run(runtime);
			});
			this.runtimeFacetUnsubs.push(unsub);
		}
	}
	/** Replace the durable runtime contribution bucket for `facet` keyed by
	*  `sourceId`. Triggers a re-run of every rebuild step whose declared
	*  inputs include this facet (via the `onFacetChange` listener wired in
	*  `setFacetRuntime`), plus per-facet listener fan-out for React
	*  subscribers. Written as `{durable: true}` so the runtime carries the
	*  bucket forward across the next `setFacetRuntime` swap
	*  (`adoptDurableContributionsFrom`) — no separate bridge mirror.
	*  Throws if no runtime is installed. */
	setRuntimeContributions(facet, sourceId, contributions) {
		if (!this.runtime) throw new Error("[FacetBridge.setRuntimeContributions] called before setFacetRuntime");
		this.runtime.setRuntimeContributions(facet, sourceId, contributions, { durable: true });
	}
	onPropertySchemasChange(listener) {
		return this.propertySchemasListeners.add(listener);
	}
	onTypesChange(listener) {
		return this.typesListeners.add(listener);
	}
	onPropertyEditorOverridesChange(listener) {
		return this.propertyEditorOverridesListeners.add(listener);
	}
	onValuePresetsChange(listener) {
		return this.valuePresetsListeners.add(listener);
	}
	/** Rebuild step list. Order matters: types runs before propertySchemas
	*  (the merge folds in type-lifted schemas); propertySchemas runs before
	*  the query swap if a future step ever needs it. */
	makeRebuildSteps() {
		const target = this.target;
		return [
			{
				id: "mutators",
				inputs: [mutatorsFacet],
				run: (rt) => {
					target.applyMutators(new Map(rt.read(mutatorsFacet)));
				}
			},
			{
				id: "processors",
				inputs: [postCommitProcessorsFacet],
				run: (rt) => {
					target.applyProcessors(new Map(rt.read(postCommitProcessorsFacet)));
				}
			},
			{
				id: "sameTxProcessors",
				inputs: [sameTxProcessorsFacet],
				run: (rt) => {
					target.applySameTxProcessors(new Map(rt.read(sameTxProcessorsFacet)));
				}
			},
			{
				id: "invalidationRules",
				inputs: [invalidationRulesFacet],
				run: (rt) => {
					target.applyInvalidationRules(rt.read(invalidationRulesFacet));
				}
			},
			{
				id: "workspaceBackfills",
				inputs: [workspaceBackfillsFacet],
				run: (rt) => {
					target.applyWorkspaceBackfills(rt.read(workspaceBackfillsFacet));
				}
			},
			{
				id: "propertySchemas",
				inputs: [typesFacet, propertySchemasFacet],
				run: (rt) => {
					const previousPropertySchemas = target.getPropertySchemas();
					const types = rt.read(typesFacet);
					const propertySchemas = mergeLiftedSchemas(rt.read(propertySchemasFacet), types);
					target.applyTypesAndSchemas(types, propertySchemas);
					const refSchemaChanges = changedRefSchemaNames(previousPropertySchemas, propertySchemas);
					if (refSchemaChanges.length > 0) target.scheduleReprojection(refSchemaChanges, propertySchemas);
					this.propertySchemasListeners.notify();
					this.typesListeners.notify();
				}
			},
			{
				id: "propertyEditorOverrides",
				inputs: [propertyEditorOverridesFacet],
				run: (rt) => {
					target.applyPropertyEditorOverrides(rt.read(propertyEditorOverridesFacet));
					this.propertyEditorOverridesListeners.notify();
				}
			},
			{
				id: "valuePresets",
				inputs: [valuePresetsFacet],
				run: (rt) => {
					target.applyValuePresets(rt.read(valuePresetsFacet));
					this.valuePresetsListeners.notify();
				}
			},
			{
				id: "queries",
				inputs: [queriesFacet],
				run: (rt) => {
					target.applyQueries(new Map(rt.read(queriesFacet)));
				}
			}
		];
	}
};
//#endregion
export { FacetBridge };

//# sourceMappingURL=facetBridge.js.map