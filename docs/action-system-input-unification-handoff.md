# Handoff: Action system — Phase 1 PR2 (Option D) + Phase 3 (input unification)

**Audience:** an agent/engineer picking up the remaining action-system work after PRs #103 (Phase 1 PR1) and #104 (Phase 2) merge.
**Lands on:** the spatial-selection branch `claude/shift-click-spatial-selection-SvXGG` (its only consumer). Rebase that branch onto `master` *after* #103 + #104 merge, then do PR2, then Phase 3 on top.
**Primary spec:** `docs/action-system-implementation-plan.html` (Phase 1 "what's coupled vs split" + Phase 3 sections). This doc is the actionable distillation; read the plan for the "why."

---

## 0. Where the spine already is (built by #102/#103/#104)

- `src/shortcuts/resolve.ts` — the resolution core, pure & DOM-free:
  - `resolve(actions, ctx, trigger) → ordered candidates` — **orders only; does not match chords.**
  - `compareContexts(a, b, ctx)` — the single precedence comparator: active `modal` ▸ `global` ▸ priority tier (`high/default/low`) ▸ activation recency.
  - `resolveDeps(action, active, configs, supplied?)` — builds the handler's deps; the one validated widened→narrow cast point. **`supplied?` is already plumbed and currently unused — it exists for Phase 3 (see §2).** Returns `null` ⇒ skip the candidate.
  - `computeInstallableContexts(active, configs)` — the keyboard gather/shadow filter (modal collapses contributors to `{global, latest-modal}`).
  - `Trigger = { kind: 'action'; actionId } | { kind: 'keyboard' }` — the `kind` selects the install-filter policy. Phase 3 extends this (see §2).
- `src/shortcuts/HotkeyReconciler.tsx` — the **single-winner coordinator**: one keydown + one keyup `window` listener. Each installable binding keeps its own tinykeys matcher (so `g g` sequence state is preserved); a completed match *records* the candidate, then the coordinator orders via `resolve(...,{kind:'keyboard'})` and dispatches the **first** candidate that passes the gates. Separate observer for `phase:'hold'` bindings.
- `src/shortcuts/effectiveActions.ts` — the transform pipeline (Phase 2): one `actionTransformsFacet` pass; `getActiveActionById` routes through `resolve`.
- `src/shortcuts/canonicalizeChord.ts` (Phase 0) — `ChordDescriptor { kind: 'key'; ... }` with the `kind` field **left open for `'mouse' | 'touch'`**, and `parseChord`.

The coordinator's dispatch loop today (the seam both parts touch):

```ts
const ordered = resolve([...bindings.keys()], {active, contextConfigsByType}, {kind:'keyboard'})
for (const action of ordered) {
  const deps = resolveDeps(action, active, contextConfigsByType)
  if (!deps) continue                                   // skip #1
  if (action.canDispatch && !action.canDispatch(deps)) continue  // skip #2
  applyEventOptions(event, action, bindings.get(action)!, contextConfigsByType)
  action.handler(deps, event, dispatch)
  return   // single winner — PR2 makes this conditional (skip #3)
}
```

---

## Part A — Phase 1 PR2: Option D (declinable handler-return fall-through)

### Goal
A handler can say "not mine — try the next candidate." This is the **third** fall-through condition, alongside `resolveDeps → null` and `canDispatch → false`. All three must be treated **identically** (skip this candidate, never abort the loop).

### The change
1. **`src/shortcuts/types.ts` — widen the handler return.** `ActionHandler` may return a synchronous **`false`** sentinel meaning "not handled." `void`/`undefined`/any `Promise` = **handled** (back-compat).
   - **Async rule (load-bearing):** the not-handled signal must be a **synchronous boolean**. The run-until-handled loop chooses the next candidate within the same event and cannot `await`. A handler that returns a `Promise` counts as handled the moment it returns — fall-through stops there. Only a synchronous `false` falls through. Document this at the type.
   - Blast radius: ~176 `handler:` definitions across ~49 files structurally depend on this signature. The widen is back-compat (nothing returns `false` today), so **nothing breaks** — but budget it as a wide **type review** PR.
2. **`HotkeyReconciler.tsx` — make the loop's terminal `return` conditional.** After `const result = action.handler(...)`, fall through (`continue`) iff `result === false` (strict, synchronous); otherwise `return`. Apply in the keydown/keyup loop. Decide the hold path: a hold has no "next candidate," so a `false` from a hold handler is just a no-op (don't run side effects) — keep it simple.
3. **`runActionById` stays single-invocation** — it has no candidate list to fall through, matching how it already ignores `canDispatch`. The sentinel is keyboard-loop semantics only. (Confirm/justify in the PR.)

### Tests (`src/shortcuts/test/HotkeyReconciler.test.tsx`)
- A winner returning `false` falls through to the next candidate; the next one runs.
- A handler returning `void` (or a `Promise`) is terminal — the next candidate does **not** run.
- `Promise<false>` does **not** fall through (only synchronous `false` does) — pins the async rule.
- Keep all existing single-winner tests green.

### Why gated on the spatial branch
The only consumer of declinable dispatch is the click/selection gesture ("this click is a selection, not an action — fall through"). Landing PR2 standalone adds an unused sentinel. So it lands **with / just ahead of** Phase 3 on the spatial branch. PR2 is *pure addition* to PR1's loop — no listener wiring is rewritten.

---

## Part B — Phase 3: input unification (mouse/touch through `resolve`)

### Goal
Route clicks/double-clicks/swipes/gestures through the **same** `resolve` + coordinator + run-until-handled path as keyboard — retiring the parallel input facets and the swipe `runBlockAction` fork (critique weakness 1 + the swipe fork's reason to exist).

### The change
1. **Descriptor kinds — `src/shortcuts/canonicalizeChord.ts`.** Add `{kind:'mouse', button, detail, role, phase}` and `{kind:'touch', ...}` to `ChordDescriptor` (the `kind` field was left open in Phase 0). `parseChord` / the matcher branches on `kind`. `phase`/`role` are first-class: e.g. a double-click binds at **mousedown** on the content node to beat native text selection — it can't be keyboard-only.
2. **`Trigger` (resolve.ts).** Add the pointer/touch install-filter policy arm (e.g. `{kind:'pointer'}`). Note `resolve`'s internal `Trigger` is **distinct** from what the handler receives — handlers keep their existing second arg (`KeyboardEvent | CustomEvent`); the descriptor is internal to resolution/ordering and never handed to handlers. resolve still only **orders**; matching stays in the coordinator.
3. **Coordinator — `HotkeyReconciler.tsx`.** Register pointer/touch listeners alongside keydown/keyup, feeding the **same** candidate-ordering + run-until-handled loop. Preserve keyboard sequence state (don't reduce an event to one descriptor for matching).
4. **Migrate the ~5 input facets** onto `resolve`: `blockClickHandlersFacet`, `blockContentSurfacePropsFacet`, `blockGestureConflictsFacet`, `blockContentDecoratorsFacet`, `blockSelectionClickDecoratorsFacet`.
5. **Collapse the swipe fork.** `runBlockAction` (swipe) currently forks because it holds deps the active map doesn't (`{block, uiStateBlock}`). Route it through `resolve()` + `resolveDeps(action, active, configs, {block, uiStateBlock})` — the `supplied` seam built in Phase 1 exactly for this.
6. **Decline = "not mine."** A click handler declares "this is a selection gesture, not my action" by returning the not-handled sentinel (Option D) → the coordinator falls through. **This is why PR2 is a prerequisite.**

### Already in place so this is additive (verify, don't rebuild)
- `ChordDescriptor.kind` extensible (Phase 0).
- `phase`/`role` first-class on bindings (Phase 1).
- The coordinator already owns dispatch (Phase 1).
- `canDispatch` + caller-supplied deps seam `resolveDeps(...,supplied)` (Phase 1).
- Option D declinable (PR2 above).

### Gotchas
- **`stopPropagation` changes meaning under one coordinator.** Losing candidates are loop entries, not separate listeners — there's nothing among them to stop. It still matters vs the separate hold observer, app-level listeners, and plugins. Write the regression test **against the mechanism** (a binding declaring `stopPropagation:true`) — there is no in-tree consumer today.
- **Native text-selection / double-click timing** — bind at mousedown; manage `preventDefault` carefully.
- **Touch vs pointer events, passive listeners** — `preventDefault` on touch needs non-passive listeners.
- **Modal shadowing for pointer** — decide whether `computeInstallableContexts` (keyboard-install-only today) also gates pointer, or pointer always contributes. Make it an explicit decision, not an accident.

---

## Sequencing & verification

1. Merge #103 + #104. Rebase `claude/shift-click-spatial-selection-SvXGG` onto `master`.
2. **PR2 (Option D)** — its own reviewable change (or folded into the spatial PR if tightly coupled). Wide type review; behavior back-compat.
3. **Phase 3** — its own PR on top. Separate from PR2.
4. Verify each: `yarn run check` (tsc + lint + tests + config). Manual smoke: click / double-click / swipe-right / shift-click spatial selection; confirm **no double-fire across input + keyboard**, and that a declining click falls through to selection.

## Invariants to preserve (don't regress)
- **One winner per event** — for pointer *and* keyboard.
- `resolve` **orders only**; matching + sequence-state live in the coordinator.
- The **three** fall-through conditions (`resolveDeps→null`, `canDispatch→false`, handler→`false`) are treated identically.
- The not-handled sentinel is **synchronous** (the loop can't await).

## Related / out of scope
- **Issue #106** — conflict-detection for a single-key binding that prefixes a co-active sequence. Orthogonal to this work; don't conflate.
- **Focus-tree activation (#101)** and the full provider/capability DI deps model — separate tracks, *not* prerequisites. Phase 3 only needs the `supplied` deps seam, which exists.
- `docs/action-system-critique.html` — the weaknesses being retired, for context.
