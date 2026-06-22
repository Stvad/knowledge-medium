# Extension seam gaps — audit 2026-06-21

Companion to `extensibility-axes.md` (the algebra/axis vocabulary and the catalog of the ~40 facets that exist today). This doc is the inverse: an audit of **where behavior is hardcoded with no override seam**, across six subsystems, with a ranked plan.

Method: six parallel read-only audits (editor, navigation, rendering, data layer, search/action, import/lifecycle), each grounded in `extensibility-axes.md` and asked to slot every gap into a facet algebra. All line numbers were verified against the working tree at the time of writing; treat them as a starting point, not gospel.

## Structural finding

The facet system is good at **adding** contributions — Sum (lists) and Map (keyed registries) are everywhere. It is systematically missing the four "verb-shaped" algebras `extensibility-axes.md` predicted:

- **veto** — reject/abort a verb (commit validation, navigation guard)
- **policy-override** — swap the decision function (merge policy, renderer resolution, paste split)
- **ordering** — control precedence among contributions (processors)
- **wrap / observe** — middleware + before/after observers (dispatch logging, navigation tracking)

Two concrete absences underlie almost every high-value gap below, both **verified to not exist in code** (doc-only):

1. **`defineVerbFacet`** — the helper that bundles `impl` (Replace) + `decorators` (Wrap) + `before`/`after` (Sum) for a single typed verb. Zero hits in `src/`.
2. **`navigationFacet`** — named in the doc as the helper's first home. Four references, all in `docs/`.

The recommendation (bottom of this doc) is therefore to build the helper once, validate it on **paste** (small, self-contained), then reuse it for **navigation** and **action dispatch** rather than hand-rolling four slots per seam.

`Chain` ("try each, first to handle wins") is listed as "none today" in the existing catalog and is the natural algebra for several gaps below (paste, modifier→intent, import formats).

---

## Ranked summary

| # | Gap | Subsystem | Algebra | Value |
|---|-----|-----------|---------|-------|
| 0 | `defineVerbFacet` not built — the primitive the rest need | facets | (new) | **Foundational** |
| 1 | Navigation seam (`navigate()` reads zero facets) | navigation | verb | High |
| 2 | Paste split-vs-as-is decision | editor | Chain / verb | High |
| 3 | Action-dispatch wrap/intercept | search/action | Wrap / substrate | High |
| 4 | Renderer-resolution *policy* (slot model) | rendering | slot Map + Chain | High |
| 5 | Pre-commit validation / commit-veto | data | Sum-with-veto | High |
| 6 | Field-level merge policy (silent LWW data loss) | data | keyed policy Map | High |
| 7 | Reference-extraction syntax | data | Sum extractors | High |
| 8 | Inline-reference wrap/decorator (hover preview) | rendering | Wrap | High |
| 9 | Backspace merge strategy (keyboard path) | editor | Map/Pick + Chain | High |
| 10 | Import format-handler | import | Chain | High |
| 11 | Enter/split placement policy | editor | verb (Replace) | Med-High |
| 12 | Plugin settings-schema seam | settings | declarative Map | Med |
| 13 | Workspace lifecycle hooks | lifecycle | Sum | Med |
| 14 | Search re-rank + quick-find source | search | verb / Sum | Med |
| 15 | Post-commit processor ordering | data | precedence/dependsOn | Med |
| 16 | Todo state machine / date locale / empty states | rendering | Map registries | Med |
| 17 | Export format / consistency checks / app-intents | misc | Map / Chain | Med-Low |

Correctly **substrate** (leave closed unless concrete demand): repo/data-backend swap, auth-provider, sync transport / what-syncs, `bootApp` replacement. Consistent with the doc's high-bar discipline.

---

## 1. Editor / text-input / block-manipulation

### E1 — Paste split-vs-as-is decision *(HIGH — user-flagged)*
- **Where:** `src/components/renderer/CodeMirrorContentRenderer.tsx:48` (`handlePaste`: `intent === 'single-block'` → verbatim; else `text.includes('\n')` → split); `src/components/renderer/DefaultBlockRenderer.tsx:464` (block-shell paste → always `pasteMultilineText`); shaping logic in `src/utils/paste.ts` (`pasteChordIntent` :69, `planEditModeMultilinePaste` :187, `resolveRootDestination` :150, always `parseMarkdownToBlocks`).
- **Hardcoded:** the split trigger (newline present + fixed Cmd/Shift+V chord), the parser (markdown only), placement (sibling vs first-child). No paste facet anywhere.
- **Use case:** CSV/TSV → table/rows; URL → titled link block; source-dialect-aware parse (Roam/Org/Notion); "always paste as single block"; transform clipboard HTML.
- **Existing/planned:** none. Today a plugin must replace the entire content renderer (substrate) just to alter paste.
- **Algebra:** Chain (`(ctx) => PastePlan | null`, first non-null wins) or verb facet — single verb, typed `(input) → plan`, clear default. **Best small first home for `defineVerbFacet`.**

### E2 — Backspace-at-start merge strategy + eligibility *(HIGH)*
- **Where:** `src/shortcuts/defaultShortcuts.ts:848` (`delete_empty_block_cm`): merge content strategy fixed to `'concat'` at ~:919; eligibility rules (refuse when both have independent children; refuse at scope root) at ~:896.
- **Hardcoded:** the join strategy and the merge-vs-delete branch. **Inconsistency / latent bug:** the *interactive* merge picker already delegates strategy via `merge-blocks/strategy.ts:pickMergeContentStrategy`, but the keyboard Backspace path hardcodes `concat`.
- **Use case:** Org-mode "Backspace-at-start outdents"; separator on join; allow merge with children (auto-append).
- **Existing/planned:** partial — whole action replaceable via `actionsFacet`/`actionTransformsFacet`, but tweaking just the strategy means reimplementing the 80-line handler.
- **Algebra:** Map/Pick `mergeContentStrategyFacet` (unify keyboard + picker) + Chain `backspaceAtStartFacet` (`(ctx) => 'merge'|'outdent'|'delete'|null`).

### E3 — Enter / split placement policy *(MED-HIGH)*
- **Where:** `src/shortcuts/defaultShortcuts.ts:629` (`split_block_cm`) consuming `src/data/structuralEditPolicy.ts:79` (`resolveStructuralEditPolicy`).
- **Hardcoded:** the whole decision tree (mid-text split sibling/first-child; end-of-text-with-children → first child; empty → outdent). `resolveStructuralEditPolicy` is a clean pure function with no contribution seam.
- **Use case:** Workflowy-style "Enter always makes a sibling"; per-type behavior (Enter inside code block = newline); "Enter on empty list item exits".
- **Existing/planned:** partial (whole-action replace). Textbook substrate-seam candidate (single orchestration point, decoupled, default is what most want).
- **Algebra:** verb facet over the policy resolver (default = current pure fn) + decorators to tweak one field.

### E4 — Copy / clipboard serialization format *(MED)*
- **Where:** `src/utils/copy.ts:6` (`createIndentedContent`, fixed 2-space markdown), `:47` (`createClipboardItem` writes only `text/plain`; JSON tree payload commented out as TODO); `src/shortcuts/blockActions.ts:317` (`((id))`/`!((id))` literals).
- **Hardcoded:** markdown-only serialization, single MIME, fixed ref syntax. A round-trip copy/paste re-parses markdown and loses ids/properties.
- **Use case:** copy as OPML/JSON/org/HTML; lossless internal round-trip via `application/json`; custom ref syntax.
- **Algebra:** Sum of format contributors `(ClipboardData) => {mime, payload}[]` + Replace for the primary serializer. Pairs with E1 (paste reading the JSON payload back).

### E5 — Interactive-content selector *(LOW-MED)*
- **Where:** `src/extensions/blockInteraction.ts:421` (`interactiveContentSelector` array + `isInteractiveContentEvent`).
- **Hardcoded:** fixed selector list deciding when a click/paste is "interactive" (left native) vs a block gesture.
- **Existing/planned:** partially covered — `data-block-interaction="ignore"` is a string opt-out.
- **Algebra:** Sum facet of extra selectors/predicates. Low ceremony; a workaround exists.

**Already covered (not gaps):** autocomplete triggers/sources (fully extensible via `codeMirrorExtensionsFacet` + CM `languageData`); CM extensions (additive seam exists); block DnD (feature doesn't exist yet — design the drop rule as a Chain when it's built); whole structural actions (replaceable via `actionsFacet`/`actionTransformsFacet` — gaps above are the *finer* decision points inside those handlers).

---

## 2. Navigation / routing / panels

**Headline:** `navigationFacet` is doc-only; `navigate()` (`src/utils/navigation.ts:148`) reads zero facets — only a comment at :8 marks where an interceptor "would plug in." Step 4 of `navigation-redesign.md` (panels DB→URL) landed; the extensibility retrofit (`navigationFacet` → `urlSerializerFacet` → `panelHistoryFacet`) never started.

**Sharp edge:** inline link/ref activation (Wikilink, BlockRef, bullet-zoom) bypasses `blockClickHandlersFacet` entirely and calls `useOpenBlock`→`navigate()` directly. So the one nav-adjacent facet doesn't cover ref clicks.

### N1 — `navigate()` has no interception/override seam *(HIGH — user-flagged)*
- **Where:** `src/utils/navigation.ts:148` (`navigate`), :181 (`useNavigate`).
- **Hardcoded:** the target-dispatch `if`-ladder (`new-panel`/`sidebar-stack`/`main`/`active`/`panel`). No contribution can short-circuit, wrap, or observe navigation.
- **Use case:** "this block type opens in a modal"; navigation history/analytics; "confirm before leaving unsaved block".
- **Algebra:** verb facet (the doc's canonical first home): `before → decorators(impl) → after`.

### N2 — Modifier-key → navigation-intent policy *(HIGH)*
- **Where:** `src/utils/navigation.ts:238` (`blockLinkClickIntent`) and :254. The doc itself (`navigation-redesign.md:228`) calls the alt-vs-cmd choice provisional.
- **Hardcoded:** shift→sidebar, shift+alt→new-panel, alt→main, plain→follow, cmd/middle→native.
- **Use case:** "cmd-click opens sidebar" (Roam muscle memory); "middle-click opens a panel not a browser tab".
- **Algebra:** Chain (try each contributed mapper, first non-null intent wins) or Replace over the `(modifiers) → intent` fn.

### N3 — Quick-find result selection target *(HIGH)*
- **Where:** `src/plugins/quick-find/QuickFind.tsx:508` (`openResolvedBlock`), modifier map `src/plugins/quick-find/selection.ts:40`.
- **Hardcoded:** plain Enter → main (desktop)/active (mobile); shift+alt → new-panel; shift/cmd → sidebar. **This is the user's literal example** ("which panel things land in from quick find").
- **Algebra:** falls out of N1+N5 if quick-find tags its navigation with an intent a contribution can remap.

### N4 — Per-callsite `plainClick` mode *(MED)*
- **Where:** `BlockOpenerPlainClick` is `'follow-link' | 'navigator'`, chosen literally at ~13 sites (backlinks/recents/daily-picker/left-sidebar/srs use `'navigator'`; refs/breadcrumbs/bullet-zoom use `'follow-link'`).
- **Hardcoded:** whether a surface follows-in-place vs jumps-to-main is baked per component.
- **Algebra:** subsumed by N1/N2 — surfaces should tag navigation with a *role* and let a facet resolve role→target.

### N5 — `navigateFromGlobalCommand` mobile/desktop rule *(MED)*
- **Where:** `src/utils/navigation.ts:186` (`target: isMobileViewport() ? 'active' : 'main'`); `isMobileViewport` = `matchMedia('(max-width: 767px)')` at :73.
- **Hardcoded:** every global command (prefs, daily-note nav, SRS deck, recents, quick-find) routes through this one rule.
- **Algebra:** same `navigationFacet` with a "global" intent tag.

### N6 — URL serialization format *(MED)*
- **Where:** `src/utils/routing.ts` (`parseLayout`/`buildLayout`, the `#ws/a/(s:x,b)/c` grammar).
- **Existing/planned:** `urlSerializerFacet` — doc-only (`navigation-redesign.md:349`).
- **Algebra:** Replace (one serializer wins). Power-user/fork axis — defer.

### N7 — Panel history model *(MED)*
- **Where:** `src/utils/panelHistory.ts` (linear per-panel stacks); keyboard back/forward → `window.history` directly (`defaultShortcuts.ts:577`).
- **Existing/planned:** `panelHistoryFacet` — doc-only (`navigation-redesign.md:350`).
- **Algebra:** Replace. Defer.

**Down-ranked (real hardcodes, not the nav seam):** 767px breakpoint (a constant, not a target decision); spatial-navigation traversal hierarchy (separate subsystem — focus movement, not link routing); panel chrome cosmetics; per-action `target:` literals (become overridable for free once N1 lands).

---

## 3. Rendering / display / formatting

**Note:** `docs/renderer-resolution.md` (slot model) is Proposed, not built — verified no `rendererSlotsFacet`/`resolveRenderer` in `src/`.

### R1 — Renderer-resolution *policy* is hardcoded *(HIGH)*
- **Where:** `src/hooks/useRendererRegistry.tsx:14` — `rendererProp` lookup → `canRender` filter → descending `priority` sort → `registry.default` magic-string fallback (:42); silent no-op on a misspelled `rendererProp` (:26).
- **Hardcoded:** the resolution algorithm and the fallback. Plugins add renderers to `blockRenderersFacet` but cannot change *how a winner is chosen* (multi-view, frame/body split, explainability) nor reach the default cleanly.
- **Use case:** theme/layout plugin owning a frame globally without numeric `priority` guessing; Embark-style multi-view; a "not found" sentinel instead of silent fall-through.
- **Algebra:** named-slot Map (per `frame:*`/`body:*`, last-wins) + ordered Chain for `body:byType`/`body:byContent`, exactly as `renderer-resolution.md` specifies. Canonical substrate-seam case.

### R2 — Inline-element / reference *component* seam *(HIGH)*
- **Where:** `src/plugins/references/markdown/wikilinks/Wikilink.tsx:44` (always `<a class="wikilink" onClick={useOpenBlock}>`); `BlockRef.tsx`/`BlockEmbed.tsx`; `src/markdown/extensions.ts:44` (`components` does per-tag `Object.assign` last-wins).
- **Hardcoded:** the anchor element, class, and click handler. The only inline seam (`markdownExtensionsFacet.components`) is whole-component replace — no *wrap*; two plugins targeting `wikilink` → one silently loses.
- **Use case:** hover preview popover; ref decoration (backlink-count badge, broken-link styling); custom ref click behavior — all without re-implementing the anchor.
- **Existing/planned:** `wikilinkDisplayDecoratorFacet` exists but covers display **text** only (content/before/after), not the element/handler/hover.
- **Algebra:** Wrap (`inlineReferenceDecoratorsFacet`, mirroring `blockContentDecoratorsFacet`). Optionally migrate `markdownExtensionsFacet.components` to a wrap algebra (the doc's own suggestion).

### R3 — Navigation / link-open *(HIGH)* — same as N1; touches refs, bullets, breadcrumbs, backlinks at once. The doc's #1 verb-facet home.

### R4 — TODO state set & cycle *(MED)*
- **Where:** `src/plugins/todo/schema.ts:11` (`'open' | 'done'`, codec-enforced at :42); `src/plugins/todo/actions.ts:41` (`cycleTodoState`, fixed 3-step machine); hardcoded checkbox + `line-through` in `index.tsx`.
- **Use case:** `DOING`/`WAITING`/`CANCELLED`; custom cycle order; per-type cycles; non-checkbox rendering.
- **Existing/planned:** rendering partly reachable via `blockContentDecoratorsFacet`, but the decorator must still read/write the 2-value prop and can't change the cycle.
- **Algebra:** Map registry of state definitions (`todoStatesFacet`) + Pick/verb for the cycle fn. State set should drive both codec validation and rendering.

### R5 — Date formatting / parsing / locale *(MED)*
- **Where:** `src/utils/dailyPage.ts:23` (`formatRoamDate`/`formatIsoDate`); `src/plugins/daily-notes/calendar.ts:24` (weekday array, `'en-US'`); parsing in `relativeDate.ts:37` (chrono-node). `calendar.ts:10` explicitly notes the codebase hardcodes `'en-US'`.
- **Existing/planned:** `blockDateAdapterFacet` covers reading/writing a block's ISO date — **not** formatting/parsing/locale.
- **Algebra:** Pick/verb `dateFormatFacet` (kind + locale) + a `localeFacet`. Keep the *stored* canonical alias locale-pinned (correctness invariant); only the *display* layer needs the seam.

### R6 — Empty-state / placeholder / loading copy *(MED)*
- **Where:** `src/plugins/backlinks-view/BacklinksEmptyState.tsx:3`; `LinkedReferences.tsx:122`; `src/components/renderer/MissingDataRenderer.tsx:4` ("Loading block…", also uses `text-gray-500` not `text-muted-foreground` — a standalone theme bug worth fixing); `App.tsx:327`; `CommandPalette.tsx:70`.
- **Hardcoded:** all copy/components; empty workspace shows a blank outline with no onboarding hook.
- **Algebra:** Map registry keyed by slot id (`emptyStateFacet`: `backlinks`/`search`/`workspace`/`missing-data`) with a kernel default per slot.

### R7 — Backlinks sort order / grouping *(MED)*
- **Where:** `src/plugins/backlinks/query.ts:138` (`order: 'created-desc'`); grouping rank `src/plugins/grouped-backlinks/grouping.ts:100`.
- **Existing/planned:** `backlinksViewFacet` (Pick) lets you replace the *whole* view; group membership + tag priority are config props; but sort/ranking aren't a fine-grained seam.
- **Algebra:** small Pick/verb comparator facet (`backlinkSortFacet`).

### R8 — Block layout sub-affordances *(LOW)*
- **Where:** `src/components/renderer/DefaultBlockRenderer.tsx`: `BulletDot` (:106, fixed circle), `BlockBullet` context-menu items (:114), `ExpandButton` glyphs (:185).
- **Existing/planned:** whole layout swappable via `blockLayoutFacet`; shell via `blockShellDecoratorsFacet`. Missing: bullet renderer, bullet-menu items, collapse glyph short of replacing the layout.
- **Algebra:** Pick `bulletFacet` + Sum bullet-menu-items facet.

### R9 — Breadcrumb separator / preview *(LOW)*; **R10 — Theme reaches colors only** *(LOW)* — `themesFacet` tokens are color HSL only (`theme.ts:31`); indent width, bullet size, fonts, density are hardcoded Tailwind/JS literals. Widen the token contract (`--indent`, `--bullet-size`, `--density`) rather than a new facet.

**Already covered:** block content renderer/layout/shell/header/footer/decorators; block date read/write; wikilink display text; backlinks-view selection + grouping config; additive remark plugins.

---

## 4. Data layer (projections / processors / merge / schema)

Every gap here is one of the four missing algebras (veto, policy-override, ordering, wrap).

### D1 — Pre-commit validation / commit-veto *(HIGH)*
- **Where:** `src/data/api/sameTxProcessor.ts:84` — the only veto path is a `sameTxProcessor` whose `watches` is a field/event and that `throw`s `ProcessorRejection`. Reactive, per-watch; no general "see all writes, veto/transform before commit" gate, no per-mutator arg-validation hook.
- **Use case:** "reject any tx leaving block X without a required `status`"; "enforce ref targets are live blocks". Today a plugin must contrive a field-watch over everything it cares about.
- **Algebra:** `commitValidatorsFacet` (ordered Sum, given the full snapshot set; throw aborts) or a `{kind:'preCommit'}` watch variant.

### D2 — Field-level merge policy *(HIGH — silent data loss today)*
- **Where:** `src/data/blockCache.ts:173` (`applyIfNewer`: whole-row `updatedAt` gate). `docs/field-level-sync-merge.md` designs per-key merge but is on hold and even as designed is a fixed shallow merge, not pluggable.
- **Hardcoded:** row-LWW. Concurrent edits to a `tags` refList or a counter silently clobber one side.
- **Algebra:** `fieldMergePoliciesFacet` (Map keyed by property name / codec type) `{decide(existing, incoming) → {value, accepted}}`, consulted before the default LWW gate. Default LWW preserved.

### D3 — Reference-extraction syntax *(HIGH)*
- **Where:** `src/plugins/references/referenceParser.ts:40` (block-ref/embed regex), :59 (`[[wikilink]]` parser); `referencesProcessor.ts:buildSourcePlan` calls them directly.
- **Hardcoded:** what counts as a reference (`[[…]]`, `#tag`, `((uuid))`, `!((uuid))`). The references subsystem is a plugin, but its extractors aren't a seam — a second plugin can't add `@mention`/`{topic}`/custom block-id schemes and get a backlink.
- **Context:** this is the subsystem that had the SRS-strip incident.
- **Algebra:** `contentReferenceExtractorsFacet` (Sum) of `{name, extract(content) → BlockReference[]}`, unioned + deduped in `buildSourcePlan`.

### D4 — Indexing / queryable-field set *(HIGH)*
- **Where:** `src/data/internals/clientSchema.ts` (fixed `block_aliases`/`block_types`/`block_references`/`blocks_fts`); `src/data/api/codecs.ts` (`where` only on string/number/boolean/date/url codecs).
- **Hardcoded:** indexed fields + FTS-on-content-only. A property is typed-queryable only if its codec ships a `WhereCapability`; list/ref/refList don't. `localSchemaFacet` allows a raw custom table but doesn't enroll a new field into `TypedBlockQuery`/the filter UI.
- **Algebra:** `searchableCodecFacet` (Map by codec type) `{indexTerms, querySql}`, or `PropertySchema.index?` auto-enrolling SQL.

### D5 — Post-commit processor ordering *(MED)*
- **Where:** `src/data/internals/processorRunner.ts:156` (iterates Map insertion order). No `precedence`/`dependsOn`/`phase`. (The references `definitionBlockProjectorFacet` *does* start in `dependsOn` order — vocabulary exists, just not for processors.)
- **Algebra:** `precedence?: number` or `dependsOn?: string[]` on the processor types, honored in the runner.

### D6 — Per-property semantic validation *(MED)*
- **Where:** `src/data/api/codecs.ts` (codecs check shape only); `propertySchema.ts` has no `validate`.
- **Existing/planned:** partial — `valuePresetsFacet` (full custom codec) covers it but at one-preset-per-rule granularity.
- **Algebra:** `validate?: (value) => true | string` on `PropertySchema`, run on the setProperty path.

### D7 — Reference retention policy *(MED)*
- **Where:** `src/data/api/derivedData.ts:41` (`reconcileDerived`, `retain` predicate per call-site, governed by `docs/contracts/derived-data-add-only.md` rather than a registry). The Roam importer's ref rebuild is explicitly not yet routed through this chokepoint.
- **Context:** exactly the class that caused the SRS incident; codifying it as a seam beats relying on each caller reading the contract doc.
- **Algebra:** `refRetentionPolicyFacet` keyed by property name; default add-only.

### D8 — Typed-query operator set *(MED)*; **D9 — Conflict-resolution/shadow-reconcile policy** (LWW, `src/sync/observer/reconcile.ts`); **D10 — ID-generation strategy** (global `newId`, v5 namespaces hardcoded). All policy-override gaps; pair D9 with D2 for collab/CRDT.

**Low:** processor wrapping/observability (no middleware), post-commit error policy (swallow + log, fixed), properties-map merge fn not reachable via `core.merge`, invalidation suppress, context-dependent defaults.

---

## 5. Search / command palette / action dispatch / shortcuts

**Headline:** the action-dispatch *resolution core* is built (`src/shortcuts/resolve.ts`, single-winner coordinator, `actionTransformsFacet`). The doc's **#1 non-UI substrate candidate — wrapping dispatch itself — is NOT built.** Dispatch is a direct `action.handler(...)` call at `src/shortcuts/HotkeyReconciler.tsx:711`, entry point a module-level mutable singleton (`runAction.ts:71`).

### S1 — Action-dispatch wrap/intercept *(HIGH)*
- **Where:** `HotkeyReconciler.tsx:711`; entries `runAction.ts:39/102/140`.
- **Hardcoded:** the path resolved-action → handler is a direct call; no contribution point between resolution and invocation. `actionTransformsFacet` rewrites action *definitions* (`apply: (action) => action | null`), not the *call*.
- **Use case:** command logging/telemetry; global undo/redo (Emacs `command-execute`); transactional batching; confirm/guard middleware; M-x introspection. All are *wrap around invocation*.
- **Algebra:** Wrap `dispatchMiddlewareFacet` (`(next) => (action, deps, trigger) => result`) — cheap first move; or the heavier substrate seam (replaceable runtime-scoped dispatcher, retiring the singleton).

### S2 — Search ranking has no re-rank hook *(HIGH)*
- **Where:** `src/utils/fuzzyRank.ts:21` (module-private scoring constants), `:177` (`scoreCandidate`), `:208` (`rankCandidates`); a *second* hardcoded table `src/utils/linkTargetAutocomplete.ts:249` (`SCORE_BLOCK_*`).
- **Hardcoded:** the entire scoring model (token/prefix/exact weights, typo threshold, MRU/recency boosts, tie-break) — two divergent tables, no seam.
- **Use case:** weight recency higher/lower; pin/boost by tag; deprioritize archived; tune typo tolerance.
- **Algebra:** verb facet for `rankSearchResults` (Replace impl + decorators) or a Sum `searchScoreBoostFacet` `(candidate, query) => number`.

### S3 — Quick-find result sources & groups *(HIGH)*
- **Where:** `src/plugins/quick-find/QuickFind.tsx:600` (fixed `groups`: Recent→Date→Pages→Blocks→Create); routing in `selection.ts` switches on a fixed value-prefix scheme.
- **Hardcoded:** which sources contribute, order, group headings, and the selection protocol. No way to add a "Commands"/"saved searches"/external source.
- **Algebra:** Chain/Sum `quickFindSourcesFacet` (each `(query, ctx) => group`) + a registry mapping result-kind → open-behavior (replacing the prefix switch). Pattern is idiomatic here (`quickActionItemsFacet`, grouped-backlinks header actions prove it).

### S4 — Command-palette population/grouping/ranking *(MED)*
- **Where:** `src/plugins/command-palette/useCommandPaletteActions.ts:20` (hardcoded hide-set), grouping `CommandPalette.tsx:43` (`groupBy('context')`), ranking delegated wholesale to cmdk.
- **Hardcoded:** lists only `actionsFacet` actions; group=context; order=context-activation-recency.
- **Algebra:** Sum `commandPaletteSourceFacet` (non-action commands) + a grouping/ranking verb facet (mirrors S2).

### S5 — Conflict-resolution / context-precedence policy *(MED for the overlap sliver, LOW for the comparator)*
- **Where:** `src/shortcuts/resolve.ts:81` (`PRIORITY_RANK`, `TIER_*`, `compareContexts`); `applyKeybindingOverrides.ts:45` (`contextsOverlap`).
- **Note:** the single comparator is a deliberate load-bearing invariant — making it pluggable is arguably an anti-goal. The genuinely under-served, low-risk piece is a `contextOverlapFacet` so plugins can declare overlaps for better conflict *detection*.

### S6 — app-intents routing *(MED)*
- **Where:** `src/plugins/app-intents/appIntents.ts:119` (`consumeAppIntent`, fixed `if/else` over `share`/`new-daily-block`/`open-picker`/`quick-find`, importing daily-notes + quick-find directly).
- **Hardcoded:** the recognized `?intent=` set and handlers — a new intent means editing the switch + cross-plugin import.
- **Algebra:** `keyedMapFacet` `appIntentHandlersFacet` (`{intent, handler}` or `{intent, actionId}`). The PWA manifest could read the same facet. Cheap, idiomatic fix.

### S7 — find-replace matching/scope *(LOW)* — `src/plugins/find-replace/search.ts:3` (no regex, ASCII word boundaries); scope fixed to whole workspace. Query/mutator are replaceable wholesale, but the match algorithm + option set are closed.

**Built (not gaps):** resolution core; `keybindingOverridesFacet` (a real runtime remap seam, fed by prefs + colemak). `defineVerbFacet` itself: NOT built.

---

## 6. Import / export / sync / lifecycle / settings

**Repo-wide structural note:** there is **no app/workspace lifecycle-hook facet** — `workspaceLandingFacet` is the only boot-phase seam and covers one decision (which block to land on).

### I1 — Import format-handler / property-mapper *(HIGH)*
- **Where:** `src/plugins/roam-import/action.ts:13` (hardcoded `.json` picker → `RoamExport` cast), `import.ts` (orchestrator reads zero facets), `content.ts` (Roam content rewrites), `properties.ts:366` (`propertiesFromRoam`). Readwise arrives *through* Roam, not its own path.
- **Hardcoded:** the entire import path is welded to the Roam JSON shape; no second importer shares a spine.
- **Use case:** Obsidian/Logseq/OPML/Notion import; customize the Roam mapping (custom `:attr` → typed property).
- **Algebra:** `importFormatHandlersFacet` (Chain: `{canHandle(file), run(text, repo)}`, first to claim wins; Roam = first handler) + optional Map `importPropertyMappersFacet` keyed by source namespace.

### I2 — Plugin settings-schema seam *(HIGH — biggest duplication)*
- **Where:** `src/plugins/extensions-settings/`, `keybindings-settings/`; shared mechanism `src/data/pluginStateExtensions.ts:47` + `propertyEditorOverridesFacet`. The de-facto pattern (per `agent-runtime/authoringCatalog.ts:201`) is 5 hand-written steps per plugin: prefs block type + strict codec + property + `pluginPrefsExtension` + a custom React editor.
- **Hardcoded:** no declarative `settingsSchema` facet; every configurable plugin re-rolls codec + editor + storage; no single discoverable settings surface.
- **Algebra:** `pluginSettingsSchemaFacet` (Map keyed by pluginId; typed field descriptors `{key, type, label, default, options}`). Core renderer turns a schema into rows + storage codec. Custom editors stay possible via the existing override facet.

### I3 — App/workspace lifecycle hooks *(HIGH for the workspace half)*
- **Where:** `src/bootstrap/workspaceBootstrap.ts:113` (fixed inline step sequence: backfills → reconcile → audit → tutorial → ensure pages → landing); `App.tsx:115`; workspace switch `WorkspaceSwitcher.tsx:60` (component-local, no hook); create notifies only via an `onCreated` prop that never reaches the extension system.
- **Hardcoded:** no `beforeSwitch`/`afterSwitch`/`afterCreate` and no boot-phase hook. **Correctness angle:** plugins that auto-create blocks need a reliable "active workspace just changed" signal (the `repo.activeWorkspaceId` scoping rule) rather than racing the async bootstrap.
- **Algebra:** `workspaceLifecycleFacet` (Sum `{afterCreate?, beforeSwitch?, afterSwitch?}`) + optional `bootstrapStepsFacet` (Sum phased steps). The doc correctly flags `bootApp` substrate replacement as overkill — this is the lighter infill version.

### I4 — Export format seam *(MED)*
- **Where:** clipboard `src/utils/copy.ts:9`; JSON export `defaultShortcuts.ts:404`; SQLite export `exportSqliteDb.ts`; block-ref copy `blockActions.ts:317`. Every serialization target is a one-off.
- **Algebra:** `exportFormatsFacet` (Map by format id, `serialize(root, repo, opts) → {blob, filename, mime}`) + a lighter `referenceSyntaxFacet`. Inverse of I1 — together a symmetric import/export seam.

### I5 — Consistency / data-integrity checks *(MED)*
- **Where:** `src/data/internals/consistencyAudit.ts` (fixed checks), scheduled at `workspaceBootstrap.ts:147`. The new diagnostics seam (commit `1bcbfd5e`, `src/plugins/diagnostics/`) gates *what surfaces to the sync chip* — it does **not** let a plugin author a new *check*.
- **Algebra:** `consistencyChecksFacet` (Sum/Map of `{id, run(db, workspaceId) → CheckResult}`); core registers its checks at base precedence. Natural companion to the just-landed diagnostics seam.

### I6 — Upload-error classification & handling *(MED)* — `src/services/powersync.ts` (`classifyUploadError`, `recordRejectionToTable`); the existing `rejectionToastFacet` covers only *rendering*. Chain classifier + Map handlers. Realistic only for custom-backend deployments.

**Low:** db-maintenance ops (one op, addable via `actionsFacet`); first-run seeding (`src/tutorial/`, foldable into `bootstrapStepsFacet`); account/workspace menu inner items (Sum like `headerItemsFacet`); auth-provider (substrate).

---

## Recommendation & sequencing

1. **Build `defineVerbFacet`** (gap 0) — the missing scaffolding for #1, #2, #3, #11, #14. Emits `impl` (Replace) + `decorators` (Wrap) + `before`/`after` (Sum); runner is `before → decorators(impl)(input) → after`.
2. **Validate it on paste** (#2) — small, typed `(input) → plan`, real demand, self-contained. Default impl reproduces today's branching exactly.
3. **Then the navigation seam** (#1) — bigger retrofit, unlocks quick-find/modifier/per-surface targeting at once; migrate `blockClickHandlersFacet` onto it as the second validating case and extend it to cover ref clicks.
4. **Action-dispatch wrap** (#3) as a `Wrap` facet — cheap path to undo/logging/guard without committing to full dispatcher substrate replacement.

Two findings worth flagging beyond "missing seam," independent of any extensibility goal:
- **E2** — the Backspace/picker merge-strategy inconsistency is a latent bug.
- **D2** — field-level merge is *silent data loss today* on concurrent list/counter edits.
