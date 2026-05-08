# Extensibility — algebras and axes

Design notes from a 2026-05-08 discussion about navigation extensibility. Two themes: (1) facets default to silent last-wins where they often shouldn't, and decorator/observer shapes are missing; (2) the renderer-replacement seam is qualitatively more powerful than facets and that pattern could extend to non-UI layers.

Companion to `navigation-redesign.md` (which mentions `navigationFacet` as future work) and `decorator-facet-design.md` (which solves the same shape for one specific facet).

## Audit of current facets

26 facets across `src/extensions/*`, `src/data/facets.ts`, `src/markdown/extensions.ts`, and plugin folders. Grouped by combiner algebra:

| Algebra | Meaning | Examples |
|---|---|---|
| **Sum** | All contributions, in order | `actionsFacet`, `headerItemsFacet`, `appMountsFacet`, `appEffectsFacet`, `actionContextsFacet`, `localSchemaFacet`, `invalidationRulesFacet`, `blockHeaderFacet`, `blockChildrenFooterFacet`, `shortcutSurfaceActivationsFacet`, `codeMirrorExtensionsFacet` |
| **Wrap** | Each contribution wraps the next (decorator stack) | `blockContentDecoratorsFacet` |
| **Map** | Keyed registry, collisions = silent last-wins | `mutatorsFacet`, `queriesFacet`, `propertySchemasFacet`, `typesFacet`, `propertyEditorOverridesFacet`, `valuePresetsFacet`, `postCommitProcessorsFacet`, `blockRenderersFacet` |
| **Pick** | All candidates exposed, consumer chooses | variant facets (`blockLayoutFacet`, `blockContentRendererFacet`, `backlinksViewFacet`) |
| **Replace** | Last contribution silently wins | `blockClickHandlersFacet` |
| **Custom** | Hand-rolled merge | `blockContentSurfacePropsFacet`, `markdownExtensionsFacet` |
| **Chain** | Try each, first to handle wins | *none today* |

Findings:

- **Truly silent function-level Replace shows up exactly once** — `blockClickHandlersFacet` (`src/extensions/blockInteraction.ts:293`). If two plugins contribute click handlers, the higher-precedence one silently wins; the other is never called. This is the only case where the user's "last-wins where it doesn't make sense" intuition lands cleanly.

- **Map-keyed registries are a different problem.** Last-wins on id collision is a *registration* conflict, not a composition concern. Right answer is warn-on-collision; current behavior is silent overwrite.

- **`markdownExtensionsFacet.components`** does `Object.assign` per-tag — last-wins for the JSX component override of each HTML tag. Plausibly should be a wrapping pattern (plugin A wraps default; plugin B wraps A) but no observed collisions force the change yet.

- **The codebase already has the right patterns** — `blockContentDecoratorsFacet` is a clean wrap stack; `mergeBlockContentSurfaceProps` is a smart custom merge; variants expose all candidates. The discipline isn't missing, it just isn't applied uniformly.

## The algebra concept

Every facet picks an algebra — how N contributions reduce to one output. The default helper `combineLastContributionResult` is the most aggressive operation (silent overwrite) presented as the path of least resistance. That's the bug.

**Proposed naming change:** rename `combineLastContributionResult` → `combineReplaceLast` (or similar). Makes the algebra explicit at every call site and discourages casual use.

**Proposed registration-time check:** Map-keyed facets should warn on collision. No behavior change, catches real bugs.

## Verb facets — the decorator/observer helper

For action-shaped facets (single output function with `(input) → output` shape), there's a recurring shape that today must be hand-rolled: a default implementation, the option to wrap it (decorator), the option to observe before/after, and rare wholesale replacement. Today plugins that want to *react to* navigation must wrap-replace the entire facet, which doesn't compose across plugins.

Proposed helper:

```ts
const navigation = defineVerbFacet<NavigateInput, void>({
  id: 'navigation',
  defaultImpl: defaultNavigate,
})

// Emits four facets, each with its own algebra:
navigation.implFacet         // Replace — pick THE implementation
navigation.decoratorsFacet   // Wrap   — middleware, lower precedence is innermost
navigation.beforeFacet       // Sum    — observers run before
navigation.afterFacet        // Sum    — observers run after

// Runner:
navigation.run(runtime, input)  // before → decorators(impl)(input) → after
```

The intent is encoded by *which facet you contribute to*. No new tagged-union contribution machinery — each slot is an ordinary facet with the algebra appropriate to it, just bundled at definition time.

This is a helper, **not** a replacement for `defineFacet`. Most facets aren't verb-shaped (lists, registries) and shouldn't pay for the four-slot structure. The kernel applies specifically when there's a single output function with a typed signature.

Natural first homes: `navigationFacet` (introduce with the kernel), then `blockClickHandlersFacet` (migrate, validates the pattern).

## Two extensibility axes

The renderer-replacement seam already in the codebase feels qualitatively more powerful than facets. That feeling is real, and it points to a second axis the system should embrace deliberately.

| Axis | Shape | Cost per seam | Used by |
|---|---|---|---|
| **Infill (facet)** | Fixed architecture, contribute slot fillers | Cheap, many seams | Most plugins |
| **Substrate (module)** | Replaceable architecture, importable parts | Expensive, few seams | Power users / forks |

The renderer seam works because: (a) one well-defined seam at the top, (b) the underlying parts are decoupled enough to be re-imported and re-composed in a custom assembly, (c) most users never touch it — the default is what they want.

User-controlled runtime assembly (configuring which facet contributions get loaded) **feels small** because it's still on the infill axis. You're shuffling contributions inside a fixed architecture. Renderer replacement is different in kind: the user **redefines the contract**, not just configures within it.

The two axes are complementary, not competing. A plugin author can:

- Use default everything + add a few facet contributions (most plugins).
- Replace the renderer + use default everything else (theme/layout plugins).
- Replace the action dispatcher + keep facets for action sources (interesting power-user case).
- Replace multiple substrates (rare, possible if seams exist).

## Where substrate seams could apply outside UI

Candidates ranked by likely real value. The pattern works wherever there's a single orchestration point and decoupled parts that can be re-imported.

1. **Action dispatcher** — `runAction(actionId, context)`. Replacing it lets a user implement command queuing, undo/redo, command logging, transactional batching, M-x style introspection. Registered actions stay importable as data. Strongest non-UI candidate; this is essentially the Emacs `command-execute` seam.

2. **Repo / data backend** — `Repo`. Lets a user swap the storage substrate (in-memory, IndexedDB, custom sync, encrypted) while reusing schema definitions, mutators, queries. Powerful in theory; in practice large contract, marginal real demand.

3. **Bootstrap / app kernel** — `bootApp({...})`. Reorder lifecycle, lazy data load, deferred UI mount. Usually overkill — anyone needing this can just write their own entry file.

4. **Runtime construction itself** — `resolveFacetRuntime`. Hot-reload, time-travel, scoped overlays. Worth doing only if a real use case shows up.

Note the dropoff. (1) is genuinely valuable because commands are how power users work. Beyond (1), be skeptical until a concrete demand appears.

## Discipline required for substrate seams

Each module seam is a **long-term commitment to a contract**. Refactoring it breaks every replacement, like ABI commitment for a kernel module. The renderer is worth it because UI is what plugins most want to redo. Each new substrate seam should clear a high bar.

The reason renderer-replacement works is mostly that the parts are clean — components take props, hooks read context, no implicit global setup beyond contexts the renderer is expected to provide. To extend this axis to non-UI layers:

- The replacement layer must be able to import the parts and use them without dragging in the rest.
- Cross-cutting state (runtime, repo) must be accessible *from* the replacement, not assumed to be wired *by* the default.
- The contract of each replaceable layer becomes a stable surface.

## Recommendations

In rough priority order:

1. **Rename `combineLastContributionResult` → `combineReplaceLast`** (or similar). Mechanical, high signal, makes the algebra explicit.

2. **Add collision warnings to map-keyed registries.** When two contributions register the same `mutator 'x'`, log once at runtime resolution. No behavior change, catches real bugs.

3. **Build `defineVerbFacet`** as the decorator/observer helper. Introduce it with `navigationFacet` (post step-4 of the navigation redesign). Migrate `blockClickHandlersFacet` to it as the validating second case. Don't retrofit non-verb facets.

4. **Treat substrate seams as deliberate design moves, not generalizations of facets.** The next substrate seam to consider is the **action dispatcher**. Hold off on repo / bootstrap / runtime replacement until something concrete demands them.

5. **Adopt the vocabulary internally** — *infill seam* (facet) vs. *substrate seam* (module replacement). Sharpens design conversations: when someone proposes an extension point, ask which axis it belongs on.

## What this is *not*

- Not a proposal to make every facet have decorator + observer slots. Most facets aren't verb-shaped; the kernel applies specifically to action-shaped verbs.
- Not a proposal for arbitrary function-level monkey-patching (the Emacs `advice-add` shape). JS module imports don't structurally support this without build-time AOP, and the cost-benefit is poor — verb facets cover the same use cases with better composition and refactor freedom.
- Not a critique of the current facet system. The algebras present in the codebase are mostly right; the gaps are: one silent-replace facet, missing registration warnings, missing verb-shape helper, missing substrate seams beyond the renderer.
