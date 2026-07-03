import { defineFacet, isFunction } from "./facet.js";
//#region src/facets/verbFacet.ts
/** Thenable check. A result-determining contribution that returns one under
*  `runSync`'s default (decision) mode has gone async, violating the
*  synchronous contract. Robust to primitives/null (optional chaining
*  short-circuits). */
var isThenable = (value) => typeof value?.then === "function";
/** Sequence `step` after a possibly-promised `value`: synchronous when `value`
*  isn't a promise (so `runSync` pays no microtask), chained when it is (so
*  `run` awaits). A throw in `step` surfaces as a sync throw or a rejection
*  respectively — exactly how the verb's final re-throw should land in each
*  mode. This is the one seam that lets `run` and `runSync` share a core. */
var andThen = (value, step) => isThenable(value) ? value.then(step) : step(value);
function defineVerbFacet({ id, defaultImpl, validateResult, onError = "rethrow", syncResultMayBePromise = false }) {
	const implFacet = defineFacet({
		id: `${id}.impl`,
		combine: (values) => {
			if (values.length > 1) console.warn(`[verb:${id}] ${values.length} impl contributions; last-wins (highest precedence). Use a decorator to compose, not a second impl.`);
			return values.at(-1);
		},
		empty: () => void 0,
		validate: isFunction
	});
	const decoratorsFacet = defineFacet({
		id: `${id}.decorators`,
		validate: isFunction
	});
	const beforeFacet = defineFacet({
		id: `${id}.before`,
		validate: isFunction
	});
	const afterFacet = defineFacet({
		id: `${id}.after`,
		validate: isFunction
	});
	const asyncStrategy = {
		observe: async (observers, invoke, phase) => {
			for (const observer of observers) try {
				await invoke(observer);
			} catch (error) {
				console.error(`[verb:${id}] ${phase}-observer threw`, error);
			}
		},
		settleResult: async (produce, validate, onError) => {
			try {
				return validate(await produce());
			} catch (error) {
				return onError(error);
			}
		}
	};
	const observeSync = (observers, invoke, phase) => {
		for (const observer of observers) try {
			const maybe = invoke(observer);
			if (isThenable(maybe)) maybe.then(void 0, (error) => console.error(`[verb:${id}] ${phase}-observer (async) rejected`, error));
		} catch (error) {
			console.error(`[verb:${id}] ${phase}-observer threw`, error);
		}
	};
	const settleResultSyncStrict = (produce, validate, onError) => {
		try {
			const result = produce();
			if (isThenable(result)) {
				result.then(void 0, (error) => console.error(`[verb:${id}] discarded async contribution (runSync contract violation) rejected`, error));
				throw new Error(`[verb:${id}] runSync requires synchronous contributions, but the impl/decorator returned a promise`);
			}
			return validate(result);
		} catch (error) {
			return onError(error);
		}
	};
	const settleResultSyncPassthrough = (produce, validate, onError) => {
		try {
			return validate(produce());
		} catch (error) {
			return onError(error);
		}
	};
	const syncStrategy = {
		observe: observeSync,
		settleResult: syncResultMayBePromise ? settleResultSyncPassthrough : settleResultSyncStrict
	};
	const runCore = (runtime, input, strategy) => {
		const validate = (result) => {
			if (validateResult && !validateResult(result)) throw new Error(`[verb:${id}] impl/decorator returned an invalid result`);
			return {
				ok: true,
				result
			};
		};
		return andThen(strategy.observe(runtime.read(beforeFacet), (observer) => observer(input), "before"), () => {
			const impl = runtime.read(implFacet) ?? defaultImpl;
			const decorators = runtime.read(decoratorsFacet);
			const ranBareDefault = impl === defaultImpl && decorators.length === 0;
			const onFailure = (error) => {
				if (onError === "rethrow" || ranBareDefault) return {
					ok: false,
					error
				};
				console.error(`[verb:${id}] impl/decorator threw, returned an invalid result, or violated the sync contract; falling back to defaultImpl`, error);
				return strategy.settleResult(() => defaultImpl(input), (result) => {
					if (validateResult && !validateResult(result)) throw new Error(`[verb:${id}] defaultImpl returned an invalid result`, { cause: error });
					return {
						ok: true,
						result
					};
				}, (fallbackError) => ({
					ok: false,
					error: fallbackError
				}));
			};
			return andThen(strategy.settleResult(() => {
				let composed = impl;
				for (const decorate of decorators) composed = decorate(composed);
				return composed(input);
			}, validate, onFailure), (settled) => andThen(strategy.observe(runtime.read(afterFacet), (observer) => observer(input, settled), "after"), () => {
				if (!settled.ok) throw settled.error;
				return settled.result;
			}));
		});
	};
	const run = async (runtime, input) => runCore(runtime, input, asyncStrategy);
	const runSync = (runtime, input) => runCore(runtime, input, syncStrategy);
	return {
		id,
		implFacet,
		decoratorsFacet,
		beforeFacet,
		afterFacet,
		impl: (fn, options) => implFacet.of(fn, options),
		decorator: (fn, options) => decoratorsFacet.of(fn, options),
		before: (fn, options) => beforeFacet.of(fn, options),
		after: (fn, options) => afterFacet.of(fn, options),
		run,
		runSync
	};
}
//#endregion
export { defineVerbFacet };

//# sourceMappingURL=verbFacet.js.map