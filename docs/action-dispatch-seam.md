# Action-dispatch seam (gap S1) — proposal + as-built

Companion to `extension-seam-gaps.md` §S1 ("Action-dispatch wrap/intercept").
This is the third home of the verb-shaped middleware pattern, after
`navigationVerb`/`navigationIntentVerb` (`src/utils/navigation.ts`) and
`pasteDecisionVerb` (`src/paste/decision.ts`).

## Problem

`actionTransformsFacet` rewrites action **definitions** at compile time
(`apply: (action) => action | null`, applied by `getEffectiveActions`). There
was no seam around the **invocation** — the path `resolved action → handler` was
a direct `action.handler(deps, trigger, dispatch)` call at ~6 sites, so a plugin
could not observe (telemetry), guard/veto, wrap (undo capture), or globally
redirect a command *as it runs* without hand-rolling a handler-replacing
transform per action.

## The crux: converge the invocation choke first

Middleware only covers a dispatch path if that path routes through it. The
handler was invoked at six sites:

| Site | Path |
|------|------|
| `runAction.ts` `dispatchActiveActionById` | imperative `runActionById` / `useRunAction` |
| `HotkeyReconciler` `runOrderedCandidates` | keyboard + pointer + gesture-commit + supplied-deps (one shared loop) |
| `HotkeyReconciler` `installHoldBinding.fire` | hold-timer fire |
| `HotkeyReconciler` gesture-progress `runProgress` | continuous-gesture preview ticks |
| `utils.ts` `applyToAllBlocksInSelection` | multi-select fan-out (per selected block) |
| `agent-runtime/commands.ts` run-action | M-x-style imperative dispatch from the agent bridge |

All six now route through a single choke:

```ts
invokeAction(runtime, {action, deps, trigger, dispatch?}): ActionHandlerResult
```

The agent-runtime site is not optional: once the behaviour decorators move off
`actionTransformsFacet`, the effective action carries only its base handler, so
an imperative caller that invokes `action.handler` directly would *lose* the
decorated behaviour. Routing it through `invokeAction` re-applies the decorators.

## Verb shape (`src/shortcuts/actionDispatch.ts`)

The seam **is** a `defineVerbFacet` — `actionDispatchVerb`, an
`ActionInvocation → ActionHandlerResult` verb with the usual four slots
(`impl`/`decorators`/`before`/`after`):

- `actionDispatchVerb.before/after` — **Sum** observers. `after` receives a
  `VerbOutcome<ActionHandlerResult>`: `{ok:true, result:false}` is a decline,
  `{ok:true, result:void|Promise}` is handled, `{ok:false, error}` is a
  synchronous throw.
- `actionDispatchVerb.decorator` — **Wrap** middleware. The per-action ergonomic
  shape `{actionId, context?, wrap}` is contributed via the
  `actionDispatchWrap(...)` sugar, which lifts it into a verb decorator that
  matches on id+context (or `'*'`) and otherwise passes through. `wrap(deps,
  trigger, next, dispatch?)` calls `next(...)` to delegate, returns its sync
  `false` to decline, or does the work and returns void/Promise.
- `actionDispatchVerb.impl` — **Replace** (last-wins): replace the base
  handler-invocation strategy for *every* dispatch (the "replaceable dispatcher"
  substrate slot). Default: `action.handler(deps, trigger, dispatch)`.

`invokeAction = actionDispatchVerb.runSync`. Decorators fold ascending by
precedence (lowest innermost, highest outermost) — the same ordering
`getEffectiveActions` gives transforms, so migrated decorators keep their
relative order.

## The hard constraint: the synchronous `false` sentinel

`ActionHandlerResult = void | false | Promise<void>`. The keyboard
run-until-handled loop relies on a **synchronous** `false` meaning "not handled,
try the next candidate". `defineVerbFacet.run` is async-only — a naive wrap would
erase the sentinel.

Resolution: `invokeAction` is `actionDispatchVerb.runSync` in its **passthrough**
mode (`syncResultMayBePromise: true`), which returns the handler's
`ActionHandlerResult` **verbatim** — a sync `false` (from the handler, or from a
guard decorator that declines) propagates straight back to the loop's existing
`if (result === false) continue`, and an async handler's `Promise` is returned
un-awaited for the loop's existing `void Promise.resolve(result).catch(...)`.
(The default `runSync` "decision" mode treats a promised result as a contract
violation — correct for the *pure* verbs paste/nav-intent, wrong for dispatch
whose `Result` legitimately includes a promise; the passthrough flag is exactly
that distinction.) The coordinator's candidate *selection* (resolve +
`resolveDeps` + `canDispatch`) stays synchronous and unchanged; only the chosen
handler's call is wrapped.

Because the loop sees the real return value, `before`/`after` observers fire per
invocation — including a candidate that declines (`after` sees `{ok:true,
result:false}`) and each gesture-progress preview tick. Observers that only care
about committed dispatches should discriminate on the outcome / trigger. `after`
fires at return-time, not async-completion (matching the existing fire-and-forget
semantics); a late rejection is the caller's to handle, not the verb's.

`before`/`after` observer throws are isolated (logged + swallowed) so an observer
can never break dispatch. A handler that throws synchronously still propagates
(fires `after` with `{ok:false}`, then rethrows) so the loop's `try/catch` treats
it as handled exactly as before. (`onError: 'rethrow'` — dispatch is effectful, so
a throwing handler must not re-run the default.)

## Migration: behaviour interceptions off transforms

Rule applied: **definition/metadata/binding changes stay on
`actionTransformsFacet`; handler/behaviour wrap-or-replace moves to the dispatch
seam (`actionDispatchWrap`).**

Enumeration of every `actionTransformsFacet` consumer:

| Consumer | What it changes | Verdict |
|----------|-----------------|---------|
| `keybindingOverridesFacet` / `applyKeybindingOverrides` | keybindings (cross-action) | **stays** — binding shaping |
| `srs-rescheduling` `srsRescheduleDecorator` | `isVisible` only | **stays** — presentational metadata |
| `srs-rescheduling` `srsSwipeRightDecorator` + `srsTodoCycleDecorators` | `handler` (archive-then-delegate) | **migrated** → dispatch decorators |
| `vim-normal-mode` `vimClickToFocusTransform` | `handler` (replace: focus, not edit) | **migrated** → dispatch decorator |
| `spatial-navigation` `verticalDecorator` | `description` **and** `handler` | **split** — description stays a transform; handler → dispatch decorator |
| `spatial-navigation` `selectionVerticalDecorator` (×4) | `handler` | **migrated** → dispatch decorators |
| `spatial-navigation` `spatialSelectionClickTransform` | `handler` | **migrated** → dispatch decorator |
| `agent-extensions/readwise` `readwiseSwipeRightDecorator` + todo-cycle | `handler` (archive-then-delegate) | **deferred** — same class, but it lives outside the type-checked tree (dynamically-loaded agent extension) and handler-wrapping transforms still work, so it keeps functioning. Its archive check is mutually exclusive by block type with SRS's, so leaving it inner (transform) while SRS moves outer (decorator) is behaviour-neutral in practice. |

`getEffectiveActions` still applies *every* transform and `invokeAction` dispatches
the effective handler, so a handler-wrapping transform that did **not** migrate
(readwise, or any third-party) keeps working — the seam is additive, not a
replacement.

## canDispatch divergence (related, optional)

`runActionById` ignores `canDispatch`; `dispatchActionWithDeps` (and the keyboard /
hold / gesture-progress paths) gate on it. The single choke is the natural place
to unify this, but doing so changes imperative-dispatch semantics app-wide
(`runActionById` would start respecting `canDispatch`), which is out of scope for a
behaviour-preserving seam. Left as-is, with the note moved onto `invokeAction` as
the unification point for the broader dispatch-lifecycle work.
