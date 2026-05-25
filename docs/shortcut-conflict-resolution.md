# Shortcut conflict resolution — proposal

Design doc for fixing cross-context shortcut collisions in `src/shortcuts/`. Written 2026-05-25 against the state of master at `9ed4f4ae` (revert of the date-scrub action migration).

## Diagnosis of the reported "P activates paste" bug

User-visible symptom: typing capital **P** into a property-input (e.g. the rename input on a property row, or the name input in `PropertyPicker`) triggers vim-normal-mode's `paste_before` action and the focused block gets a paste pasted in front of it.

The path through the code:

1. The property input is a real `<input>` rendered by `src/components/ui/input.tsx`, reached via [PropertyRow.tsx:99](src/components/propertyPanel/PropertyRow.tsx:99), [PropertyPicker.tsx:214](src/components/propertyPanel/PropertyPicker.tsx:214), and the default value editors in [defaults.tsx:43](src/components/propertyEditors/defaults.tsx:43). Focus is in the input; the surrounding block is still `inFocus` (focus state lives on the block, not the DOM-active element).
2. `vimNormalModeActivation` ([interactions.ts:76](src/plugins/vim-normal-mode/interactions.ts:76)) gates on `inFocus && !inEditMode && !isSelected`. None of those flip when DOM focus moves into a property input nested in the block, so `NORMAL_MODE` stays active with the vim plugin's `paste_before` binding (`shift+p`) installed via hotkeys-js.
3. `PROPERTY_EDITING` is declared in [defaultContexts.ts:55](src/shortcuts/defaultContexts.ts:55) but never activated. The only hook that would activate it — `usePropertyEditingShortcuts` ([useActionContext.ts:94](src/shortcuts/useActionContext.ts:94)) — has zero call sites (`grep -rn usePropertyEditingShortcuts src/` returns only the declaration). So the only line of defence is `defaultEventFilter`.
4. `defaultEventFilter` in [HotkeyReconciler.tsx:33](src/shortcuts/HotkeyReconciler.tsx:33) is `!(isSingleKeyPress(event) && hasEditableTarget(event))`. For typing capital P, the keyboard event has `key='P'`, `shiftKey=true`. `isSingleKeyPress` ([utils.ts:35](src/shortcuts/utils.ts:35)) returns `true` only when the active-modifier count is zero, or when it's one and the key *is* that modifier. With Shift held and key `P`, neither branch matches → returns `false`. The filter then evaluates `!(false && true) = true` and hotkeys-js processes the event. `paste_before` fires.

So the bug is two compounding gaps:

- **Gap A (the immediate cause):** `defaultEventFilter` only blocks bare keystrokes in editable targets. Any shifted letter (`shift+p`, `shift+o`, `shift+m`, …) — which is what *typing* a capital letter produces — sails through. Bare `p` IS blocked correctly; the user almost certainly hit capital P. Several vim and multi-select bindings use `shift+<letter>`, so the same shape exists for at least `paste_before` (vim), `create_block_above_and_edit` (vim, `shift+o`), and `extend_selection_*` (multi-select, `shift+j`/`shift+k`).
- **Gap B (the systemic cause):** `PROPERTY_EDITING` is dead. Even if Gap A were fixed (e.g. by making the filter "single non-modifier character" instead of "single key"), there's no positive declaration that "while you're typing a property name, *all* block shortcuts should pause" — including modifier-bearing ones like `cmd+d` (delete block) if the input swallows that combination.

**A one-line filter tightening (Gap A) closes the reported bug** — change `isSingleKeyPress` to "any printable single character with at most Shift", and `shift+p`-into-an-input gets blocked the same as bare `p`. But it does not address Gap B or the broader modal-shadowing question, and it doesn't help the date-scrub gesture or future hold-to-X modal contexts.

Recommendation in this doc: fix Gap A as a small one-liner now and address Gap B + the modal-shadowing case with the broader model below.

## Current model in one paragraph

`hotkeys-js` is the runtime. `HotkeyReconciler` installs every action whose `context` is currently active and tears it down when that context deactivates. Multiple contexts can be active simultaneously. The only cross-context filter is `hotkeys.filter`, which iterates active contexts and returns `true` (process the event) if any context's `eventFilter` returns `true`, otherwise falls back to `defaultEventFilter`. Each action keeps its own keybinding registered; collisions between contexts result in both handlers firing. `getActiveActionById` ([effectiveActions.ts:77](src/shortcuts/effectiveActions.ts:77)) — used only by `runActionById` (external dispatch, e.g. command palette) — picks last-activated context wins, but the keyboard-event path doesn't go through it.

## Survey of conflict situations

I went through every site that registers an action context or activates one (`grep -rn actionContextsFacet src/`, `grep -rn shortcutSurfaceActivationsFacet.of src/`, `grep -rn useActionContext src/`). Active contexts in the codebase today:

| Context | Defined in | Activated by | Modal/additive |
|---|---|---|---|
| `global` | `defaultContexts.ts` | Always (via `TopLevelRenderer`) | additive |
| `normal-mode` | `defaultContexts.ts` | `vimNormalModeActivation` per focused-non-editing-non-selected block | additive |
| `edit-mode-cm` | `defaultContexts.ts` | `codeMirrorEditModeActivation` per mounted CM surface (gated by its own `eventFilter` to `.cm-editor` targets) | additive (but DOM-scoped) |
| `property-editing` | `defaultContexts.ts` | **never** (dead hook) | intended modal |
| `multi-select-mode` | `defaultContexts.ts` | `PanelMultiSelectActionContext` when selection is non-empty | modal |
| `command-palette` | `command-palette/context.ts` | `<CommandPalette>` open | modal |
| `video-player` | `video-player/actions.ts` | `videoPlayerShortcutActivation` on focused video block (or CM editor inside video notes) | additive |
| `backlink-entry` | `backlinks/backlinkBreadcrumbShortcuts.ts` | `backlinkEntryShortcutActivation` on focused backlink block | additive |
| `daily-notes.date-scrub` | (reverted; was in `dateScrubActions.ts`) | (reverted) | intended modal |

### Concrete collisions today

These are the pairs I could find where the same chord is bound in two contexts that can co-activate. The fact that some are nominally allowed by the conflict-detection code ([keybindingConflicts.ts:34](src/shortcuts/keybindingConflicts.ts:34) considers `normal-mode` and `multi-select-mode` non-overlapping for the purposes of warnings) doesn't mean they don't co-fire at runtime.

1. **property-editing × normal-mode** — the reported bug, plus the same shape for every `shift+letter` and every `cmd+letter` / `ctrl+letter` chord whose underlying browser default doesn't beat hotkeys-js. The fix isn't filter tweaks all the way down; it's "while a property input is focused, suppress the block's normal-mode bindings entirely". Property-editing is a modal context.
2. **command-palette × normal-mode** — same shape. The palette uses cmdk, which is its own focus trap, but a normal-mode action bound to a chord cmdk doesn't intercept (any shifted letter, or arrows in some configurations) leaks through. The command-palette plugin registers two actions (`command_palette` in `global`, `command_palette_for_block` in `normal-mode`) but **none in the `command-palette` context itself** — so the modal context owns no chord today, and there's nothing to collide *with* directly. The risk is asymmetric: underlying-context bindings still fire while the palette is open. Modal context.
3. **multi-select-mode × normal-mode** — both bind `p`, `shift+p`, `d` ([defaultShortcuts.ts:798](src/shortcuts/defaultShortcuts.ts:798), [vim-normal-mode/actions.ts:251](src/plugins/vim-normal-mode/actions.ts:251)). In the common case `vimNormalModeActivation` opts out (the focused block is also the selection anchor, so `isSelected` is true and normal-mode doesn't activate), but if focus ever sits on a non-selected block while a selection exists, both bindings fire on `p`. Modal-shadowing would make this safe by construction instead of by accidental gating.
4. **edit-mode-cm × normal-mode** — desirable coexistence in principle (a focused-but-not-editing block contributes normal-mode actions; the CM editor in a *different* block contributes edit-mode-cm), but in practice they don't overlap for the same DOM target because `edit-mode-cm`'s `eventFilter` requires `.cm-editor` ancestry and `vimNormalModeActivation` requires `!inEditMode`. Articulated as the answer to "shouldn't we always shadow when something else is active?" — no, we shouldn't, because this case is exactly the additive one.
5. **future date-scrub × normal-mode** — the abandoned migration ([commit 20b822a2](https://github.com/anthropics/apps/commit/20b822a2)) introduced this. Scrub-mode wants `h`/`j`/`k`/`l`/arrows for date stepping. While scrub is active, those keys must not fire vim navigation. Modal.
6. **future hold-to-X gestures** — same shape as scrub. Each one wants to shadow the underlying context's bindings for a small set of keys while held.

There's also a non-obvious sixth bucket: contexts that **don't** collide at the chord level but DO mean "the user is doing something focused, please don't fire random bindings". `command-palette` is the cleanest example — zero bindings, but you don't want `p` in the search box to focus a block and paste.

### Where the existing event-filter design helps and where it doesn't

`edit-mode-cm` already uses `eventFilter` correctly: it returns `true` only for events targeting a `.cm-editor` descendant. That makes it a positive opt-in for CM keys, while non-CM events fall through to `defaultEventFilter`. This works because CM has a DOM marker (the `.cm-editor` class).

`PROPERTY_EDITING` could in principle do the same — `event.target.closest('[data-property-row]')` or similar. But that only addresses the "suppress block actions" side. It doesn't say *which* property-editing actions should fire (today there are none registered against it, but the design assumes there will be). And it doesn't compose with future modal contexts that don't have a single DOM container (a multi-step gesture, a held-modifier mode).

## Three models — analysis

### Model A: `exclusive: true` on `ActionContextConfig`

The reverted commit `20b822a2` shipped this shape. A boolean flag on the context config. When set on an active context, `HotkeyReconciler` filters the to-install action set down to *only* that context's actions:

```ts
// from the reverted patch, src/shortcuts/HotkeyReconciler.tsx
const exclusive = contexts.toReversed().find(type => contextConfigsByType.get(type)?.exclusive === true)
return new Set(exclusive ? [exclusive] : contexts)
```

Concretely: while date-scrub is active, the only bindings installed are date-scrub's. Pressing `cmd+k` does nothing because the command-palette action (registered in `global`) isn't installed. Pressing `escape` does nothing because the global escape binding isn't installed either. **That is what got reverted, and rightly so** — "modal wins on everything" is too broad. You want scrub mode to claim `h`/`j`/`k`/`l`/arrows, not the entire keyboard.

A first attempt to fix this — call it **A′** — keeps the flag but applies it *only on chord collision*: the modal claims chord K only if it binds K; chords it doesn't bind pass through. **This was the original recommendation in this doc, and it's wrong.** The "modal context" bug is precisely that modifier-bearing chords from underlying contexts (`cmd+d` while typing in a property input, `cmd+x` while command palette is open) fire when they shouldn't. A modal that owns no chords (today's PROPERTY_EDITING, COMMAND_PALETTE) wouldn't shadow them. A′ closes the typing case if the filter is also tightened, but leaves modifier-chord leakage from NORMAL_MODE / EDIT_MODE_CM into modal contexts wide open.

The salvageable variant — call it **A″** — is the reverted code's broad-shadowing semantics with **one carve-out**: modal shadows every active context EXCEPT `global`. `global` is the always-on backstop for things like Cmd+K opening the palette. The reverted commit's bug was that it shadowed `global` too, so Cmd+K stopped working during scrub mode. Keep `global` installed alongside the most-recent modal and the rest works.

**Pros of A″:**
- Actually solves "modal context": NORMAL_MODE's `cmd+d` doesn't fire while PROPERTY_EDITING is active, because NORMAL_MODE's bindings aren't installed at all while a modal is up.
- One-line declaration on the modal context. No per-binding enumeration; the modal author doesn't need to list every chord they want to shadow.
- Symmetric with `global` as backstop: app-wide chords are explicitly in `global`, and that's the boundary. Want a shortcut to survive every modal? Put it in `global`. Want it shadowed? Put it in NORMAL_MODE / a plugin context.

**Cons of A″:**
- "Most-recently-activated modal wins" is the stacking semantics, leaning on `ActiveContextsMap`'s insertion order ([ActiveContexts.tsx:54-77](src/shortcuts/ActiveContexts.tsx:54)). `getActiveActionById` already relies on the same ordering, so we're not introducing a new contract — but worth pinning down with a test.
- Forces an explicit `global` vs scoped distinction. Some NORMAL_MODE-bound actions might deserve to survive modal contexts (e.g. block-level keyboard nav). Migrating those means moving them to `global` or accepting they get shadowed.
- Doesn't capture "additive *with shadowing of one specific underlying context*". E.g. "shadow normal-mode but coexist with backlink-entry" — A″ shadows both. Flagged as a known limit; no current case needs it.

### Model B: Declared suppression

`suppresses: ['normal-mode']` on the context config. A modal lists the specific contexts whose bindings it shadows.

**Pros:**
- Most explicit. Reviewer of a context can immediately see "this shadows X and Y".
- Allows the "shadow normal-mode but coexist with global" expression A′ can't.

**Cons:**
- Tight coupling from one context to another's identifier. The video-player plugin gets activated alongside normal-mode (additive); if video-player ever wanted to suppress normal-mode it would need to learn that the activation name happens to be `'normal-mode'`. That's a foreign string crossing a plugin boundary.
- Encourages over-listing. Authors will tend to suppress everything just to be safe, drifting back toward A's blanket exclusivity but with more typing.
- Awkward to evolve. Adding a new modal context that *should* be shadowed by all existing modals means walking every existing modal's `suppresses` list to add it — and forgetting is silent.

### Model C: Binding-level priority

`priority: number` on each binding. Conflicts resolve by comparison.

**Pros:**
- Most flexible. Fine-grained: scrub mode's `h` is priority 200, vim's `h` is priority 100, scrub wins.

**Cons:**
- The behavior of a context becomes non-local: to know what shortcuts work while context X is active, you have to read every binding in every other context to see which ones X happens to outrank. Reviewers can't reason from one file.
- Magic-number cliffs. Every existing binding's priority becomes meaningful; bumping a future binding to "above scrub" requires knowing scrub's number.
- Doesn't naturally express "I should shadow underlying bindings but only when I'm active" — priorities are global, and the activation gating becomes orthogonal, so you essentially need both. C is strictly more machinery than A′ for the same outcome.

### Recommendation: **A″ (`modal: true`, broad-shadowing-minus-`global`) + tighten filter + activate `PROPERTY_EDITING`**

A″ is the smallest expressive addition that actually solves the modal-context problem: while a modal is active, no other non-`global` context's bindings install, so cross-context leakage of modifier chords is structurally impossible. B's extra explicitness is real but bought at the cost of plugin-boundary coupling, and the cases where B could express something A″ can't (suppress-one-but-not-all) aren't on the current roadmap. C is overkill and obfuscatory.

The naming pick is `modal: true`, not `exclusive: true` — the conversation, the code paths, and the user-facing concept all already talk about "modal contexts". `modal` reads as "this is a mode; while it's on, the layer below pauses." `exclusive` describes the mechanism (one context exclusively claims bindings); accurate but a layer removed from intent, and it carries the wrong association with the reverted commit's too-broad semantics.

The full recommendation is three layered changes, each shippable independently:

1. **Tighten `defaultEventFilter`** so any keypress with no chord-modifier (Ctrl/Alt/Meta) targeting an editable element is blocked. Treat Shift-as-capitalization the same as no modifier. App-wide; not modal-specific. Closes the typing class of bug (bare `p`, capital `P`, `!`, Enter, Tab, ...) for *every* input in the app — including inputs in surfaces that don't register a modal context. Modifier-bearing chords (`cmd+p`, `ctrl+k`) still flow through; those are user intent to address the app.
2. **Add `modal?: boolean`** to `ActionContextConfig`. Reconciler change: when any active context has `modal: true`, the install set becomes `['global', <most-recently-activated modal>]`. All other contexts' bindings skip install while a modal is up. Mark `property-editing`, `multi-select-mode`, `command-palette`, and future scrub/hold contexts as `modal: true`. Plugin-defined `video-player`, `backlink-entry` stay additive — they're scoped layers on a focused block, not modes.
3. **Activate `PROPERTY_EDITING`** at the property-input mount sites. Hook is already there ([useActionContext.ts:94](src/shortcuts/useActionContext.ts:94)); wire it up in `PropertyRow`, `PropertyPicker`, and the default value editors with focus-gated activation.

Layering rationale: (1) is the smallest possible fix for the reported bug and ships independently. (2) is the architectural primitive for modal contexts; once it's in, MULTI_SELECT and COMMAND_PALETTE start shadowing NORMAL_MODE correctly without any other change. (3) closes the property-editing × normal-mode case specifically by giving PROPERTY_EDITING a place to be active.

### Why not just "fix the filter and call it a day"

The filter fix closes typing-shaped leakage (bare/shifted keys in inputs) but not chord-shaped leakage (`cmd+d` while in a modal). It also doesn't make modal contexts a first-class concept:
- Date-scrub migration needs *something* — without A″ it has to re-implement chord-by-chord shadowing each time, or fall back to "exclusive everything" which we already established is too broad.
- Multi-select × normal-mode latent collision (`p`, `shift+p`, `d`) stays defended only by `isSelected` gating in vim's activation. Any change that breaks that gating (a future "extend selection without moving focus" feature, say) silently revives the double-fire.
- Property-editing's own actions (Tab to next property, Enter to commit, Escape to cancel) can't be added without also bringing the activation hook online, and once that hook is online the question of "do block actions still fire" needs a structural answer.

## Migration plan

### Step 1 — Filter tighten (closes typing-shaped leakage app-wide)

`src/shortcuts/utils.ts` — replace `isSingleKeyPress` with `isTypingKeyEvent`: returns true when no chord-modifier (Ctrl/Alt/Meta) is held. Shift is permitted because it's part of producing capital letters and shifted symbols. `defaultEventFilter` in `HotkeyReconciler.tsx` calls the new helper.

Cases the new filter MUST block (when target is editable): `a`, `A` (shift+a), `1`, `!` (shift+1), `Space`, `Tab`, `Enter`, `Backspace`.
Cases the new filter MUST NOT block: `cmd+a`, `cmd+shift+a`, `ctrl+p`, `meta+k`. Modifier-bearing chords are the user's intent to address the app, not the input.

Edge case: function keys (`F5`) and arrows in editable targets. Today these are already blocked by `defaultEventFilter` (single-key + editable → filter returns false). The proposed tightening doesn't change that — these stay blocked, same as before. Not a regression. Worth a one-line comment in the filter so a future reader doesn't try to "fix" arrows-in-inputs without realising it would also allow `p`-in-inputs.

Scope: ~20 lines of code, one new test file (`src/shortcuts/test/isTypingKeyEvent.test.ts`).

### Step 2 — `modal: true` flag, broad-shadowing-minus-`global`

`src/shortcuts/types.ts` — add `modal?: boolean` to `ActionContextConfig`.

`src/shortcuts/HotkeyReconciler.tsx` — at install time, compute the install set: walk active contexts in reverse-activation order; if any context has `modal: true`, the install set is `{'global', <that most-recent modal>}`. Otherwise, install set is all active contexts. Actions whose context isn't in the install set skip registration.

This differs from the reverted commit in one detail: the reverted patch's install set was `{<modal>}` (no `global`). The carve-out for `global` is what makes Cmd+K, Escape, and other app-wide chords continue to work during scrub mode / command palette / etc.

Migration of the existing contexts:

- `multi-select-mode` → `modal: true`. Today's gating-via-vim-opts-out becomes a positive declaration. Cmd+K still opens the palette during multi-select because the palette action is in `global`.
- `command-palette` → `modal: true`. Doesn't bind anything in its own context today — but prevents NORMAL_MODE's `cmd+d` etc. from firing into the palette search box.
- `property-editing` → `modal: true`. Same — once Step 3 wires it up, NORMAL_MODE bindings stop firing while typing in a property input.
- `daily-notes.date-scrub` → `modal: true` (when re-introduced).
- Plugin-defined `video-player`, `backlink-entry` → leave as additive. They're scoped layers on a focused block, not modes.

Scope: ~25 lines in the reconciler + the type change + 3 tests (one non-modal-active baseline, one modal-shadows-non-global, one stacked-modal precedence).

### Step 3 — Activate PROPERTY_EDITING

Three call-site clusters:

- `PropertyRow.tsx` — the rename `<Input>`.
- `PropertyPicker.tsx` — the name `<Input>`.
- Default property value editors in `propertyEditors/defaults.tsx` — the per-shape `<Input>` fields. ~7 sites; refactor to a small `usePropertyEditingActivation` helper.

The hook already exists at [useActionContext.ts:94](src/shortcuts/useActionContext.ts:94). Each input's activation is focus-gated — activate on `onFocus`, deactivate on `onBlur` — so mounting a property panel doesn't suppress block shortcuts; only typing into a field does.

Dependencies validator at [defaultContexts.ts:22](src/shortcuts/defaultContexts.ts:22) requires `input instanceof HTMLInputElement` — fine for these sites, but flag for the future the day someone introduces a non-`<input>` property editor (a contenteditable rich-text shape, say). Validator should accept `HTMLElement` and let consumers narrow.

Scope: ~40 lines + tests. Independent of step 2 in isolation, but only delivers the property-input fix when step 2 is also in place.

## Edge cases the recommended model handles awkwardly

1. **Two modal contexts active simultaneously.** Resolved by "most-recently-activated wins" per the `ActiveContextsMap` insertion order. Realistic case: open command palette, then activate multi-select — palette wins. Less realistic but possible: scrub mode + palette. Document the precedence rule in `types.ts` so future readers don't have to reverse-engineer it from the reconciler.

2. **Modal context binds a chord that `global` also binds.** With A″, the modal wins (since both are in the install set and hotkeys-js calls handlers in registration order, but the modal context's binding semantically overrides). Worth pinning down with a test. Realistic case: scrub mode's `Escape` to cancel vs. global's `Escape` to clear focus — scrub wins, which is correct.

3. **A NORMAL_MODE action genuinely should keep firing during modals.** With A″ the migration answer is "move it to `global`". That's a deliberate, visible decision — not silent. We should audit existing NORMAL_MODE actions during Step 2 implementation and consider which (if any) should be promoted. Off the top: `command_palette_for_block` (NORMAL_MODE) probably wants to stay shadowed (you wouldn't want it firing while typing in palette search); most other NORMAL_MODE actions are block-mutations.

4. **User remaps a binding via the keybindings settings UI such that an underlying context ends up needing a chord a modal context already claims.** A″ silently shadows it while the modal is active. Surfaceable via the conflict-detection UI ([keybindingConflicts.ts](src/shortcuts/keybindingConflicts.ts)) — extend it to flag "this chord will be shadowed when context X activates". Not urgent; conflict UI today already under-reports cross-context cases per its own comments.

5. **The reverted commit's symptom revisited.** If we drop the broad-shadowing in WITHOUT the `global` carve-out (i.e. ship the reverted code as-is), date-scrub mode breaks Cmd+K, every global shortcut. The carve-out is load-bearing; tests should explicitly verify that `global` bindings remain installed while a modal is up.

6. **`canRun` interaction.** `canRun` is presentational ([types.ts:127](src/shortcuts/types.ts:127)) — it doesn't gate install. So a modal context with `canRun: false` actions still shadows underlying contexts. Correct (the modal still "owns" the chord while active and the action is just a no-op for it), but worth a comment in the reconciler so a future reader doesn't try to thread `canRun` into shadow computation.

7. **Multi-key sequences (`g g`, `d d`).** hotkeys-js doesn't natively support these; the codebase doesn't use them today. If added later, A″'s "context-level shadowing" works fine — sequences register on whichever context owns them; the install set still decides whether the context's handlers are wired. Out of scope; flag.

## Out-of-scope reminders (for the implementer)

- Gesture-conflict facet (`blockGestureConflicts.ts` in the current `git status`) is a separate layer — it deals with which gesture wins *activation*, not which binding fires under an activation. Don't conflate.
- The date-scrub action migration depends on this proposal landing but isn't part of it. Re-do that work in its own commit after A″ ships.
- Plugin API surface stays unchanged. Plugins continue to register actions and (optionally) action-context configs the same way; `modal` is a new optional field.
- The keybinding-overrides path and `getActiveActionById` (for `runActionById`) are untouched. Those go through context identity; the modal-shadowing question only affects the hotkeys-js install side.

## Notes on the doc's own evolution

The first draft of this doc recommended **A′** (`exclusive: true` with conflict-only semantics — modal claims only chords it explicitly binds). That recommendation was wrong, and was corrected in conversation before any implementation landed. A′ doesn't solve the modal-context problem: a modal that binds no chords (today's PROPERTY_EDITING, COMMAND_PALETTE) doesn't shadow anything, so NORMAL_MODE's `cmd+d` still fires while typing in a property input. A″ (broad shadowing with `global` carve-out) is the actual answer.

Kept the A′ analysis in place above so the reasoning chain is traceable. The "Why not A′" framing is the corrective.
