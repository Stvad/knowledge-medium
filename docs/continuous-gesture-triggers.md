# Continuous gestures as action-system triggers

Status: design, pre-implementation. Owns the last unmigrated cluster of the
action-system plan — the continuous touch/pointer gestures
(`docs/action-system-implementation-plan.html`, Phase 3 input unification).

## TL;DR

A continuous gesture (swipe, two-finger date-scrub, future siblings) becomes
**just another trigger** on the existing `resolve` + run-until-handled spine,
exactly the way a keyboard chord or a click already is. The gesture's
*recognizer* emits a **named gesture** (`'swipe-left'`); any action, in any
plugin, binds to that name via a new `gestureBinding` field — the recognizer
never names the action. Recognition lives in core infrastructure (a recognizer
facet); plugins contribute recognizers and actions, not wiring. A raw
surface-props escape hatch stays available for anything the recognizer model
can't express, and it reaches the same trigger via the same `dispatchGesture`
entry point.

## Where we are

### The discrete pointer path already does this right

`dispatchPointerAction(event, suppliedDeps)` (`src/shortcuts/pointerAction.ts`)
carries **no action id**. The surface says "a double-click happened on this
block, here are its deps"; the coordinator
(`src/shortcuts/HotkeyReconciler.tsx`) matches every action whose
`pointerBinding` descriptor fits the event's intrinsic fields
(button/detail/mods/phase), then `resolve(matched, …, {kind:'pointer'})` orders
them and runs until one handles it. Vim's double-click-to-edit is an action
carrying `pointerBinding: {detail:2, phase:'pointerdown'}`; the surface has
never heard of vim. **Trigger and action are already decoupled.** Gestures copy
this; pointers don't change.

### Continuous gestures are the holdouts — bespoke and coupled

`swipeGesture.ts` and `dateScrubGesture.ts` are `BlockContentSurfaceContribution`s
that hang raw `onTouchStart/Move/End/Cancel` off the surface and run a full
hand-rolled state machine (per-finger identifier tracking, direction lock,
midpoint math, thresholds, live preview side-effects). They coordinate via
`blockGestureConflictsFacet` (a per-block mutual-exclusion slot). Only the
**commit** reaches the action system, and swipe-right reaches it *coupled* —
`dispatchSwipeQuickActionRunEvent(..., SWIPE_RIGHT_BLOCK_ACTION_ID, ...)` names
a specific action id.

Two structural gaps block migration:

1. **No streaming trigger.** `resolve`'s `Trigger` union
   (`src/shortcuts/resolve.ts`) is `action | supplied | keyboard | pointer` —
   all point-in-time.
2. **No non-passive listener seam.** Scrub must `preventDefault()` on
   `touchmove`/`pointermove` to kill native scroll; React surface props are
   attached passively, so a core coordinator has no way to register a
   non-passive native move listener.

## The model: two matching strategies, one decoupling

Every input kind lands on the same `resolve` + run-until-handled spine and keeps
the action decoupled from the trigger. They differ only in **how the candidate
set is computed**, which is intrinsic to the input, not a design seam:

| Input | Matching strategy | Why |
| --- | --- | --- |
| keyboard chord | **structural** — match `defaultBinding` against the chord | the chord is self-describing |
| pointer (click / double-click / tap) | **structural** — match `pointerBinding` against the event's fields | a double-click *is* a double-click by its fields |
| continuous gesture | **recognized/named** — match `gestureBinding` against a recognizer-emitted name | continuous motion isn't self-classifying; a drag only *becomes* `'swipe-left'` after thresholds + direction-lock |

The naming layer is not gestures "doing their own thing" — it is the
irreducible fact that a gesture needs recognition to produce a label where a
click carries its label in its fields. The trigger→action decoupling is
identical across all three.

### A deliberately *coupled* path also exists, and stays

`dispatchActionWithDeps(actionId, deps, trigger)` names a specific action on
purpose — the mobile-nav buttons and grouped-backlinks header buttons use it
because the affordance **is** that action's UI (a button labeled "archive" runs
archive). That is the *by-id affordance* path. Keys / pointers / gestures are
the *by-binding discovery* path. Both coexist intentionally; we are not
collapsing them.

## What gets built

### 1. Foundation (shared by recognizer + escape hatch)

- **`{kind:'gesture'}`** added to the `resolve` `Trigger` union.
- **`gestureBinding?: GestureBindingSpec | readonly GestureBindingSpec[]`** on
  `ActionConfig` — the analogue of `pointerBinding` / `defaultBinding`.
  `GestureBindingSpec = { gesture: string; phase?: 'commit' }`.
  - Gesture names are **opaque strings**, like chords — no mandatory
    registration to emit or bind one.
  - `phase` defaults to `'commit'`. The field is reserved so `'start'` /
    `'cancel'` can become bindable later; we do not build them until something
    needs them. Live preview is recognizer-private, not a bindable trigger.
- **`dispatchGesture(gestureName, suppliedDeps, event)`** — module-level entry
  point mirroring `dispatchPointerAction`. Matches actions whose
  `gestureBinding` names `gestureName`, `resolve(…, {kind:'gesture'})`,
  run-until-handled with supplied deps. This is the *only* thing a gesture needs
  to reach the action system — facet or escape hatch.
- **Non-passive listener seam** — a standalone primitive (not buried in the
  recognizer loop) that registers real non-passive `pointermove`/`touchmove`
  listeners on a content surface, usable by both the recognizer loop and raw
  escape-hatch contributions (React surface props can't `preventDefault` a
  passive move). On mouse/pen this is the whole scroll-suppression story; on
  touch it is *not* — see below.
- **`touch-action` strategy (load-bearing for touch).** A non-passive
  `pointermove` + `preventDefault` does **not** reliably stop native
  pan/zoom/scroll under Pointer Events: the browser decides scrolling from CSS
  [`touch-action`](https://developer.mozilla.org/docs/Web/CSS/touch-action)
  *before* move listeners run, and once it starts scrolling it delivers
  `pointercancel` instead of further `pointermove`s. `touch-action` is static —
  it must be set on the element *ahead* of the gesture, not flipped mid-drag.
  So:
  - A recognizer **declares the `touch-action` it needs** (e.g. `'pan-y'` —
    keep native vertical page scroll, hand horizontal motion to JS — which fits
    both horizontal swipe and horizontal two-finger scrub; `'none'` only when a
    gesture genuinely owns both axes). The core loop applies the **union** of
    its recognizers' requirements to the content surface as a static
    `style.touchAction`, computed at contribution time.
  - Every recognizer **must treat `pointercancel` as a real terminal phase**
    (`onPointerCancel`) — the browser can still cancel mid-gesture (a
    `touch-action: pan-y` surface scrolled vertically past the lock, an OS
    interrupt), and the recognizer has to drop in-flight state and release its
    claim, exactly as today's `onTouchCancel` does.
  - Trade-off noted: `touch-action: pan-y` on a content surface disables
    pinch-zoom and native horizontal scroll *on that surface*. Acceptable for
    block content (the gestures we want are horizontal); flagged so a future
    image/code surface can opt out by contributing no horizontal recognizer.
  - **Fallback:** if `touch-action` proves insufficient for a specific gesture,
    the seam still exposes a non-passive native `touchmove` path (TouchEvents
    *do* honour `preventDefault` for scroll suppression) — recognition stays on
    Pointer Events, scroll-suppression can fall back to a `touchmove`
    preventDefault for that recognizer. We prefer `touch-action` and reach for
    this only if forced.

### 2. Recognizer facet (core owns the loop)

`continuousGestureRecognizersFacet`. Core installs the non-passive Pointer Event
listeners once per content surface, maintains a per-block **session**
(`pointerId → {x, y, time}` for all active pointers on that block — Pointer
Events unify mouse/touch/pen, and two-finger scrub aggregates two pointers out
of the session), and on each lifecycle event calls every registered recognizer.
A recognizer is a state machine returning a verdict:

```ts
interface GestureRecognizer<Deps = unknown> {
  id: string                       // arbitration key (absorbs blockGestureConflicts ids)
  touchAction?: TouchActionValue   // CSS touch-action this gesture needs (e.g. 'pan-y'); core unions them onto the surface
  onPointerDown?(s: GestureSession, ctx): GesturePhaseResult
  onPointerMove?(s: GestureSession, ctx): GesturePhaseResult
  onPointerUp?(s: GestureSession, ctx): GesturePhaseResult
  onPointerCancel?(s: GestureSession, ctx): void   // REQUIRED in practice: the browser can cancel mid-gesture
}

type GesturePhaseResult =
  | { status: 'idle' }                                    // not mine / not yet
  | { status: 'active' }                                  // claimed → core cancels others, preventDefaults moves
  | { status: 'commit'; gesture: string; deps: Deps }     // core dispatches via resolve({kind:'gesture'})
  | { status: 'cancel' }                                  // release my claim
```

- The verdict emits a **gesture name, not an action id** — that is the
  decoupling.
- The recognizer body may run arbitrary side-effects during `active` (scrub
  calls `overlay.update(...)`, swipe dispatches its progress-preview event);
  core only *consumes the verdict*.
- **Arbitration** = the generalized `blockGestureConflicts`: one `active`
  recognizer per block; a new claim evicts the rest and fires their cancel.
  `blockGestureConflictsFacet` is absorbed and retired once both consumers ride
  the loop.

### 3–5. Migration

3. **Swipe → core recognizer.** Left/right swipe relocates *into core* (per the
   plan's "recognition lives in core"); it emits `'swipe-left'` / `'swipe-right'`.
   The swipe-quick-actions plugin keeps only its *actions*, now bound via
   `gestureBinding: {gesture: 'swipe-right'}` — no more `SWIPE_RIGHT_BLOCK_ACTION_ID`
   by name.
4. **Scrub → daily-notes recognizer.** Stays contributed by the daily-notes
   plugin, proving the third-party recognizer path. Emits e.g.
   `'date-scrub-commit'`; the keyboard/wheel scrub stays as-is (no touch
   competitor).
5. **Retire `blockGestureConflicts`** once both ride the loop's arbitration.

## Escape hatch (first-class, not a fallback)

`blockContentSurfacePropsFacet` does **not** go away. A gesture the recognizer
model can't express contributes raw `onPointerDown/Move/...` surface props, runs
its own state machine, claims arbitration directly, and emits its outcome via
the same `dispatchGesture(name, deps, event)`. So another plugin can
`gestureBinding: {gesture: 'blah'}` against a gesture defined entirely outside
the facet. The recognizer facet is *sugar for building* the state machine; the
**trigger vocabulary is open to anyone who can call `dispatchGesture`**. The
escape hatch needs the non-passive seam too (hence it is a standalone
primitive, §1).

## Optional altitude fold-in

The touch **tap** is today a recognized-then-structurally-matched hybrid
(thresholds in `defaultEditorInteractions`, then a `TouchChordDescriptor` phase
match) — the one bespoke recognizer hiding in core. Once the recognizer facet
exists, tap can move into it and emit a `'tap'` gesture, folding away the last
special case. Not required; noted as where the seam wants to go.

## Open questions

- **Declared gesture vocabulary.** Ship opaque-string names now; add a way for
  recognizers to *declare* the names they emit when a settings/binding UI needs
  to enumerate them or detect a binding to a typo'd/nonexistent gesture (the
  role action-registration plays for the palette).
- **Recognizer ordering / multi-claim.** If two recognizers want the same block
  at once, arbitration is currently first-active-wins-then-evict. Whether
  recognizers need a precedence beyond registration order is deferred until a
  real conflict appears.
