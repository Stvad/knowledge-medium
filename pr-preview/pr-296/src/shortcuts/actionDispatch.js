import { defineVerbFacet } from "../facets/verbFacet.js";
import { matchesAction } from "./effectiveActions.js";
//#region src/shortcuts/actionDispatch.ts
/**
* The dispatch verb. `runSync`'s **passthrough** mode (`syncResultMayBePromise`)
* returns the handler's `ActionHandlerResult` verbatim, so the run-until-handled
* loop's synchronous `false` decline sentinel survives and an async handler's
* `Promise` is returned un-awaited for the caller's fire-and-forget `.catch`.
* `onError: 'rethrow'` because dispatch is effectful — a throwing handler must
* not re-run a default.
*/
var actionDispatchVerb = defineVerbFacet({
	id: "core.action-dispatch",
	defaultImpl: ({ action, deps, trigger, dispatch }) => action.handler(deps, trigger, dispatch),
	onError: "rethrow",
	syncResultMayBePromise: true
});
/** The single action-invocation choke — every handler call routes here. */
var invokeAction = (runtime, invocation) => actionDispatchVerb.runSync(runtime, invocation);
/** Lift the per-action `{actionId, context?, wrap}` shape into a verb decorator:
*  a non-matching invocation passes through; a matching one calls `wrap` with a
*  `next` that re-enters the inner layer with possibly-rewritten deps/trigger. */
var toVerbDecorator = (decorator) => (next) => (invocation) => {
	if (!matchesAction(decorator, invocation.action)) return next(invocation);
	const inner = (deps, trigger, dispatch) => next({
		action: invocation.action,
		deps,
		trigger,
		dispatch
	});
	return decorator.wrap(invocation.deps, invocation.trigger, inner, invocation.dispatch);
};
/** Contribute a per-action handler wrap — the replacement for an
*  `actionTransformsFacet` handler rewrite. Match by id (+context, or `'*'`);
*  decorators fold ascending by precedence (lowest innermost), the same order
*  `getEffectiveActions` gives transforms. */
var actionDispatchWrap = (decorator, options) => actionDispatchVerb.decorator(toVerbDecorator(decorator), options);
//#endregion
export { actionDispatchVerb, actionDispatchWrap, invokeAction };

//# sourceMappingURL=actionDispatch.js.map