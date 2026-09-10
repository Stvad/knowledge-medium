# `useActionContextActivations` — overlapping-owner ownership bug

> **Status:** resolved — fixed in `ActiveContexts.tsx` (claim/release), last
> verified against code 2026-08-20. Kept as history: it records the failed
> first attempt and why the second one is shaped the way it is.

## The bug

`ActiveContextsProvider` used to key its state by `ActionContextType`:
`Map<ActionContextType, BaseShortcutDependencies>`. `activate(context, deps)`
was last-write-wins; `deactivate(context)` blindly removed the entry by type.

When two components register the *same* context-type concurrently (e.g. a
parent block and one of its descendant blocks both contributing
`'video-player'` because they're both inside a `videoPlayerBlockId`-scoped
`NestedBlockContextProvider`), the cleanup phase clobbered each other:

1. Parent activates → entry is parent's deps.
2. Child activates → entry is child's deps (parent overwritten).
3. Child unmounts → `deactivate('video-player')` removes the entry —
   parent's claim is gone too even though the parent is still mounted, and
   nothing re-registers it because the parent's effect deps never moved.

The result is worse than misrouting: **nobody** owns the context, so the
keys are dead rather than wrong, silently.

`inFocus`-gated activations mask this for NORMAL_MODE in a single-pane
layout, but plenty of surfaces are not focus-gated:
`PanelMultiSelectActionContext` claims MULTI_SELECT_MODE per panel,
`TopLevelRenderer` claims GLOBAL per layout root, and a host that keeps
several layout sessions mounted (perspective keep-alive) multiplies both.

## The first attempt, and the defect it carried

Commit `a7483fa` (reverted as `c2a47ab`) reshaped the API so `activate`
returned an opaque `Symbol` handle and `deactivate(handle)` removed that
specific claim, with a per-type stack. That is the right *shape*, but the
rollout broke shortcuts in production and the cause was never pinned down.

One defect in it is now confirmed rather than suspected. Its `computeTopMap`
was:

```ts
for (const [context, stack] of stacks) {
  const top = stack[stack.length - 1]
  if (top) result.set(context, top.dependencies)
}
```

`ActivationEntry` was `{handle, dependencies}` — no recency field and no
sort, so the visible map ordered context types by their FIRST claim. Key
order is load-bearing: `computeInstallableContexts` picks the last modal *in
iteration order* and `compareContexts` breaks priority ties by activation
recency (`resolve.ts`). Reconstructing exactly that projection on top of the
current fix makes the keyboard test in `activeContexts.test.tsx` dispatch a
real keypress to the **wrong modal context** (surface A claims modal one, B
claims modal two, C then claims modal one: recency says one, stacks-iteration
order says two).

The honest limit: that shows the reverted attempt *had* a defect which
misroutes keys — not that it is what the production report was, since that
report's details were never written down. Nothing rules out a second cause;
see "Things that were checked" below, where the ref-shape suspicion was
traced and could not be turned into a failure either way.

## The fix that landed

`ActiveContexts.tsx` now stores, per context type, a STACK of claims, each
carrying an `ActivationToken` (identity) and a `seq` (a monotonic activation
counter). Two entry points instead of one:

- `claim(context, deps) → token` / `release(token)` — the declarative path.
  `useActionContextActivations` uses these, so a surface can only ever
  retract its own claim, and when the newest claim is released the
  next-newest resurfaces instead of the type disappearing.
- `activate(context, deps)` / `deactivate(context)` — unchanged signature,
  now a singleton claim per type held under a per-type token. This is the
  imperative "enter a mode" path an action handler takes (date-scrub's hold,
  a leader chord's modal context) and the one exposed to extensions via
  `ActionDispatch`; re-entering refreshes the existing claim rather than
  stacking a second one, so the single `deactivate` on exit still clears it.

The visible one-entry-per-type map is derived by taking the top of each
stack and **sorting by `seq`**, which reproduces the old "re-inserted at the
end on every activation" key order exactly — that is the part the first
attempt got wrong. When a newer claim is released, the resurfaced older
claim takes back its own (older) place in the order rather than jumping to
the end.

## Things that were checked

The four items the previous attempt left under "Things to check on the next
attempt", walked against the implementation that landed. Two of them were
worth their weight; one found a hole in the *tests*; one came back
inconclusive and is recorded as such.

1. **Handle stability / stale entries on the stack.** VERIFIED by test, not
   by argument. The declarative funnel does mint a fresh token per effect
   run, exactly as warned — but each run's cleanup releases precisely the
   tokens that run took, so depth stays at one entry per live claimant.
   Three leak shapes were injected (cleanup releasing nothing; `release`
   no-oping unless the token is top of stack; the funnel releasing only its
   first token) and the fuzz's ownership property caught all three. The
   property was also strengthened for this item: the visible entry must
   carry the owner's CURRENT dependencies, so a superseded claim by the SAME
   surface resurfacing is caught too — the owner-identity check alone cannot
   see that, and a stale-closure mutation confirms only the new clause
   catches it.
2. **The `setActive` ref/state window.** TRACED, and it does not apply: all
   claim state is in `useState` behind functional updaters, and the only
   refs left are the pre-existing `runtimeRef` and an allocation-only
   `imperativeTokens`. Building the ref-mutated-then-eager-snapshot variant
   deliberately did NOT produce a failure the suite could see, so this is
   "the shape is gone", not "the suite would catch it if it came back".
3. **`HotkeyReconciler` / installation order.** The note is explicit that a
   green reconciler unit test proves nothing here, so the pin is a real
   keypress: `activeContexts.test.tsx` mounts `HotkeyReconciler`, builds the
   overlapping-claim scenario where stacks-iteration order and activation
   recency disagree, and asserts which modal's action fires. That test is
   what turned the diagnosis above from a theory into a measurement.
4. **StrictMode.** This is where the checklist earned its keep. StrictMode
   *was* being generated by the fuzz and was doing NOTHING: React 19 gates
   the effect double-invoke on the render root's strict flag, so the
   `<StrictMode>` the harness returned from inside a component rendered its
   subtree normally (measured: nested 1 effect run, root 2). Half the
   generated cases were silently identical to the other half. The harness now
   wraps at the render root and a non-vacuity canary asserts the claim count
   is 2 under strict and 1 without, so the arm cannot quietly go dead again.
   With it genuinely on, the implementation still passes.

## How it is pinned

- `src/shortcuts/test/activeContextsOwnership.fuzz.test.tsx` — the fuzz
  suite that established the bug was reachable in real React commits (it
  went red on the fixed smoke seed within one case) and now pins the
  ownership invariant, current-dependencies, and key order. See its docblock
  for the properties.
- `src/shortcuts/test/activeContexts.test.tsx` — the same cases as
  examples, plus the imperative-path semantics, the same-commit swap, the
  no-churn short-circuit, and the keyboard modal-recency flow.
