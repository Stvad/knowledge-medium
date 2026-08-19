import { defineVerbFacet, type VerbDecorator, type VerbRuntime } from '@/facets/verbFacet.js'
import type { FacetContribution, FacetContributionOptions } from '@/facets/facet.js'
import type {
  ActionConfig,
  ActionContextType,
  ActionDispatch,
  ActionHandler,
  ActionHandlerResult,
  ActionTrigger,
  BaseShortcutDependencies,
} from './types.js'
import { matchesAction } from './effectiveActions.ts'

/**
 * The action-DISPATCH seam (gap S1) — middleware around action *invocation*
 * (observe / guard-veto / wrap / globally redirect a command as it runs),
 * distinct from `actionTransformsFacet`, which rewrites action *definitions*.
 * Every place that runs a resolved handler routes through `invokeAction`; plugins
 * contribute to the verb's slots (`before`/`after` to observe, `decorator` —
 * usually via `actionDispatchWrap` — to wrap, `impl` to replace). See
 * `docs/action-dispatch-seam.md`.
 */
export interface ActionInvocation {
  action: ActionConfig
  deps: BaseShortcutDependencies
  trigger: ActionTrigger
  dispatch?: ActionDispatch
}

/**
 * The dispatch verb. `runSync`'s **passthrough** mode (`syncResultMayBePromise`)
 * returns the handler's `ActionHandlerResult` verbatim, so the run-until-handled
 * loop's synchronous `false` decline sentinel survives and an async handler's
 * `Promise` is returned un-awaited for the caller's fire-and-forget `.catch`.
 * `onError: 'rethrow'` because dispatch is effectful — a throwing handler must
 * not re-run a default.
 */
export const actionDispatchVerb = defineVerbFacet<ActionInvocation, ActionHandlerResult>({
  id: 'core.action-dispatch',
  defaultImpl: ({action, deps, trigger, dispatch}) => action.handler(deps, trigger, dispatch),
  onError: 'rethrow',
  syncResultMayBePromise: true,
})

/** The single action-invocation choke — every handler call routes here. */
export const invokeAction = (
  runtime: VerbRuntime,
  invocation: ActionInvocation,
): ActionHandlerResult => actionDispatchVerb.runSync(runtime, invocation)

/** A handler wrap targeted at one action. `next` runs the action's own handler
 *  (or the next inner wrap) with possibly-rewritten deps/trigger/dispatch; call
 *  it to delegate, return its sync `false` to decline, or do the work and return
 *  void/Promise. Throwing is a crash, not a veto — veto by RETURNING. */
export type ActionHandlerWrap = (
  deps: BaseShortcutDependencies,
  trigger: ActionTrigger,
  next: ActionHandler,
  dispatch?: ActionDispatch,
) => ActionHandlerResult

/** Per-action targeting for {@link actionDispatchWrap}. `actionId` may be the
 *  wildcard `'*'` to wrap every action; `context` narrows further. Matched by
 *  the shared {@link matchesAction}, the same predicate `actionTransformsFacet`
 *  uses — targeting is identical on the definition and invocation sides. */
export interface ActionDispatchDecorator {
  actionId: string
  context?: ActionContextType
  wrap: ActionHandlerWrap
}

/** Lift the per-action `{actionId, context?, wrap}` shape into a verb decorator:
 *  a non-matching invocation passes through; a matching one calls `wrap` with a
 *  `next` that re-enters the inner layer with possibly-rewritten deps/trigger. */
const toVerbDecorator = (
  decorator: ActionDispatchDecorator,
): VerbDecorator<ActionInvocation, ActionHandlerResult> =>
  next => invocation => {
    if (!matchesAction(decorator, invocation.action)) return next(invocation)
    // `next` is a `VerbImpl` (`=> MaybePromise<Result>`); for dispatch `Result`
    // is already `ActionHandlerResult` and nothing double-wraps, so narrowing
    // back to `ActionHandler` is sound. Soundness rests on the wrap NOT turning a
    // sync `false` into `Promise<false>` — an `async wrap` that does `return
    // next(...)` over a declining base would, and the run-until-handled loop
    // (`result === false`) would then treat the lost decline as "handled". Every
    // wrap that may see a decline therefore `await next(...)` (discarding the
    // value → `Promise<void>`); a wrap that replaces never calls `next`.
    const inner: ActionHandler = (deps, trigger, dispatch) =>
      next({action: invocation.action, deps, trigger, dispatch}) as ActionHandlerResult
    return decorator.wrap(invocation.deps, invocation.trigger, inner, invocation.dispatch)
  }

/** Contribute a per-action handler wrap — the replacement for an
 *  `actionTransformsFacet` handler rewrite. Match by id (+context, or `'*'`);
 *  decorators fold ascending by precedence (lowest innermost), the same order
 *  `getEffectiveActions` gives transforms. */
export const actionDispatchWrap = (
  decorator: ActionDispatchDecorator,
  options?: FacetContributionOptions,
): FacetContribution<VerbDecorator<ActionInvocation, ActionHandlerResult>> =>
  actionDispatchVerb.decorator(toVerbDecorator(decorator), options)
