# `useActionContextActivations` — overlapping-owner ownership bug

## The bug

`ActiveContextsProvider` keys its state by `ActionContextType`:
`Map<ActionContextType, BaseShortcutDependencies>`. `activate(context, deps)`
last-write-wins; `deactivate(context)` blindly removes the entry by type.

When two components register the *same* context-type concurrently (e.g. a
parent block and one of its descendant blocks both contributing
`'video-player'` because they're both inside a `videoPlayerBlockId`-scoped
`NestedBlockContextProvider`), the cleanup phase clobbers each other:

1. Parent activates → entry is parent's deps.
2. Child activates → entry is child's deps (parent overwritten).
3. Child unmounts → `deactivate('video-player')` removes the entry —
   parent's claim is gone too even though the parent is still mounted.

The same shape happens whenever a `useActionContextActivations`
contribution turns on/off for a block whose ancestor is *also* contributing
the same context. `inFocus`-gated activations mostly mask this because only
one block is in focus at a time, but the cross-contributions get nuked
during transient prop-change re-runs of the activation effect.

## What I tried (commit `a7483fa`, reverted as `c2a47ab`)

Reshape the API so `activate` returns an opaque `ActivationHandle` (a
`Symbol`); `deactivate(handle)` removes that specific claim. Internally,
each context-type holds a stack of `{handle, deps}` entries — top-of-stack
is the visible deps, last-mount-wins. Removing a non-top handle just
splices it out of the stack; removing the top exposes the next claim.

This is the right shape, but the rollout broke shortcuts in production —
something about how `useActionContextActivations` builds + deps the
activations array interacts badly with the per-mount `Symbol` allocation,
or with how the new `refreshState` callback is ordered relative to the
Reconciler's `setActive`. Need a closer look before re-trying.

## Things to check on the next attempt

- The `activeActivations` array in `useActionContextActivations` is
  recomputed via `useMemo` on every render where `activations` changes
  identity. With the old API the cleanup ran via context-type, so a
  re-keyed activation just replaced the entry. With handles, every render
  cycle that re-runs the effect allocates fresh symbols → strict-mode
  double-invoke or rapid prop changes can leave stale entries on the stack.
  Investigate whether the effect dep should also encode handle stability.
- `setActive` calls a fresh `Map` reference every time. Combined with
  refs-then-state mutation (stacksRef mutated, then setActive triggers
  React render), there's a window where the dispatch context is stale.
  Probably fine in practice but worth tracing.
- `HotkeyReconciler` reads `useActiveContextsState`. If state updates are
  batched differently with the new API, action installation order can
  change. The reconciler test passes with the new code but the bug only
  shows up in real shortcut flows — write a focused test for
  "activate/deactivate during the same render cycle".
- React strict mode double-invokes effect bodies — the test harness may
  not exercise that. Run with `<StrictMode>` enabled on the next attempt.

## Workaround until the proper fix lands

For plugins with a `videoPlayerBlockId`-style context propagation that can
trigger overlapping claims: gate the activation more tightly so only one
descendant claims at a time (e.g. require `inFocus && !ancestorClaiming`).
This is symptomatic but avoids the bug surface.
