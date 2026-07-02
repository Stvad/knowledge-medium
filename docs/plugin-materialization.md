# Materializing system plugins into the DB — plugin replaceability design

> **Status:** proposed design, nothing implemented. Grounded against `src/extensions/` (dynamicExtensions,
> compileExtensionModule, staticAppExtensions, api), `src/facets/` (facet, togglable, resolveAppRuntime),
> `src/data/projectorRuntime.ts`, `index.html` (importmap), `vite.config.ts` (preserveModules), and the
> companion docs `plugin-module-url-sw-hybrid.md`, `extensibility-axes.md`, `extension-seam-gaps.md`,
> `plugin-runtime-toggle/`. Related: issue #253 (SW `/module/` URLs, iceboxed).
> Last verified against code: 2026-07-02.

## 0. TL;DR

The question: **how does somebody replace a system plugin with their own version, such that everything
that relied on the original keeps relying on the replacement?** Two candidate abstraction layers came up
in the original notes: a module system with override/retargeting (probably service-worker-backed), or
materializing plugins into the DB and running the live version.

The answer this doc argues for: **the two are separable, and the repo has already built most of both.**
Materialization should be **on-demand** ("eject"), built on the existing user-extension pipeline
(`type:'extension'` blocks → Babel → blob import), with two structural additions: a first-class
**`replaces`** relation from an extension block to a system toggle id, and a **restaged boot —
kernel → materialize → assemble** — so DB-loaded plugins are lifecycle peers of static ones: substituted
*before* anything runs (the original never executes) and contributing schema/types/processors from the
same position static plugins do. Retargeting splits by reference kind:

- **String-keyed references** (actions, renderer ids, facet buckets, type membership, mutators/queries)
  retarget **for free** — the runtime substrate is already string-addressable. This covers most of what
  "things that relied on the original" actually do at runtime.
- **Static module imports** of a replaced plugin's *behavior* (e.g. ten plugins import
  `getOrCreateDailyNote` from daily-notes) do **not** retarget; the fix is to keep promoting cross-plugin
  behavior entry points to string-keyed seams (mutators/queries/verbs/actions) — incremental, already the
  codebase's direction — **not** to build a module-override system first.
- **Byte-level module replacement** (a service worker rewriting `/src/**` module fetches) stays a
  deferred stage with an explicit trigger, exactly like issue #253, which it extends.

Recommended staging:

| Stage | What | Unlocks | Cost |
|---|---|---|---|
| 1 | **Eject & replace**: materialize a plugin's source into an extension block with `replaces: 'system:<id>'`; boot restaged so materialized plugins load *before* assembly and substitute at the original's manifest position, with full schema-contribution parity | Edit/fork any non-essential plugin — data extension included; original never runs when replaced; replacement follows you across devices; built-in remains the fallback | Moderate — new property, eject action, boot restage + id-keyed manifest, settings rows |
| 2 | **Seam hardening**: move cross-plugin *behavior* imports behind string-keyed seams | Faithful replacement — dependents actually hit your version | Incremental, per-seam |
| 3 (gated) | **Module-URL override** via SW (extends #253) | Fork any *submodule*; retarget importers without seam migration | High — SW coordination, boot-path bytes-at-rest, E2EE surface |
| parallel | **Declaration materialization**: seed `block-type`/`property-schema` blocks from system definitions | Edit types/properties without touching code | Small — the projector already exists |

## 1. The question, precisely

From the notes:

- Replacing a system plugin should be possible in a way where "things that relied on the original system
  plugin can keep relying on your thing."
- The blocker as stated: "other things rely on plugins on a reference level — they import plugin parts or
  reference the facets directly… there is some abstraction layer missing that would allow us to retarget."
- Two hypothesized shapes: a module system with overridable resolution (service worker), or materializing
  plugins into the DB and editing the live version — either everything up front, or on demand with the
  native version disabled.
- Adjacent: materialization "as a thing I can do for types and properties."

This doc treats those as three separable design axes: **(A) what gets materialized and when**, **(B) what
the replacement mechanism is**, **(C) how dependents retarget**. Conflating them is what makes the problem
look like it needs a module system up front.

## 2. Ground truth — what already exists

### 2.1 Two plugin worlds

Built-in plugins are ordinary bundled ES modules, assembled in a hardcoded, order-commented array
(`src/extensions/staticAppExtensions.ts:60-152`; imports at `:13-57`), plus a smaller pre-React list of
data-only extensions (`src/extensions/staticDataExtensions.ts`) installed on the Repo before first render.
A "plugin" is just an `AppExtension` — facet contributions wrapped in a togglable boundary:

```ts
export const characterCounterPlugin: AppExtension = systemToggle({
  id: 'system:character-counter', name: 'Character counter', description: '…',
}).of([
  characterCounterDataExtension,
  blockContentDecoratorsFacet.of(characterCountDecoratorContribution, {source: 'character-counter'}),
])
```
(`src/plugins/character-counter/index.ts:16-23`)

User extensions are **already materialized**: blocks of `type:'extension'` whose `content` is TS/JSX
source, discovered by `repo.query.findExtensionBlocks` and loaded per-block with failure isolation
(`src/extensions/dynamicExtensions.ts:125-233`). The compile pipeline is transpile via lazily-imported
`@babel/standalone` → instantiate via blob-URL `import()` (`src/extensions/compileExtensionModule.ts:146-182`),
with a persistent compiled cache so warm boots skip Babel.

### 2.2 The importmap bridge — same module instances

Extension modules resolve `@/…` through the realm-global importmap (`"@/": "./src/"`,
`index.html:38-65`), so a DB-loaded module that imports `@/extensions/api.js` — or any `@/plugins/…`
path — gets **the same module instance the running app uses** (`src/extensions/api.ts:1-13`). Facet
objects, React contexts, module stores: all shared, no duplication. And the production build makes this
real: `preserveModules: true`, unhashed `[name].js`, no minify (`vite.config.ts:143-155`) — **every
internal module has a stable URL in prod**, with `sourcemap: true` emitting `.js.map` files whose
`sourcesContent` carries the original TSX.

This is the single most design-relevant fact in the repo: a materialized copy of a system plugin does not
live in a walled garden. It can import everything the original imported.

### 2.3 Toggles: synced intent, device-local trust

Every built-in is wrapped in a `systemToggle` boundary keyed `'system:<name>'`; user extensions get
`userToggle` keyed by block id (`src/facets/togglable.ts:111-154`). Enable-state lives in a synced
per-user overrides map (owned by the extensions-settings meta-plugin, mirrored to localStorage for first
paint via `src/extensions/useOverrides.ts`). User-extension *execution* additionally requires a
device-local approval pin: the loader runs the **approved** compiled output, never drifted live content
(`approveExtension` / `loadApprovedExtension`, `compileExtensionModule.ts:331-401`; the two-gate model is
documented at `dynamicExtensions.ts:100-123`). Safe mode (`?safeMode`) forces every non-essential boundary
off while still emitting settings rows (`src/facets/resolveAppRuntime.ts:49-71`).

### 2.4 The projector precedent — declarations from blocks

User-defined types and property schemas are **already materialized as blocks** (`'block-type'`,
`'property-schema'`) and projected into `typesFacet` / `propertySchemasFacet` as durable `'user-data'`
runtime buckets (`src/data/projectorRuntime.ts:1-41`, issue #90; `userTypesService.ts`,
`userSchemasService.ts`). And the shadowing order works out: `FacetRuntime.collectContributions` appends
runtime buckets **after** static contributions (`src/facets/facet.ts:242-249`), `read` sorts by
precedence with a stable sort (`:263-264`), and registry facets are last-wins with a collision warning
(`keyedMapFacet`, `:102-123`). **A definition block with the same id as a static definition shadows it
today, by construction.**

### 2.5 How dependents reference a plugin — the coupling taxonomy

Inventorying the ~60 non-test cross-plugin edges plus app-shell→plugin edges, every reference is one of:

| Kind | Mechanism | Retargets on replacement? |
|---|---|---|
| Action invocation | `runActionById(id)` → string-keyed lookup (`src/shortcuts/runAction.ts:46-55,106`) | **Yes** — replacement registers the same action id |
| Facet contribution/read | Bucketed by `facet.id` *string* (`facet.ts:212,242-270`); the imported facet object only supplies `id`/`validate`/`combine` | **Yes** — a same-id facet interoperates; and a fork imports the *original* facet objects anyway (§2.2) |
| Renderer selection | `rendererProp` string → id-keyed registry; else `canRender`/`priority` tournament (`src/hooks/useRendererRegistry.tsx:14-43`) | **Yes** (id path); tournament path is a known separate gap (`docs/renderer-resolution.md`) |
| Mutators / queries | `keyedMapFacet` registries, invoked by name via `repo.mutate.*` / `repo.query.*` | **Yes** — last-wins by key |
| Type membership | `'types'` property (DB data) checked against type-id strings | **Yes** — data survives; ids are strings |
| Plugin-owned singleton blocks | Deterministic uuidv5 from a namespace constant (`src/extensions/pluginIds.ts:21-25`) | **Yes** — the fork carries the same namespace UUID in its source |
| Type/action-id constants | Imported cross-plugin (`DAILY_NOTE_TYPE`, `OPEN_TODAY_ACTION_ID`, …) | **Harmless** — importers keep reading the original module; the *values* are strings the fork keeps |
| **Behavior helpers / components** | Static import of implementation (`getOrCreateDailyNote`, `ReschedulePicker`, `parseReferences`) | **No** — importers stay bound to the original code |
| **Composed extension arrays** | Plugin A includes plugin B's extension wholesale (`srs-review/index.ts:14`, `geo/index.ts:14`, `vim-normal-mode/index.ts:9`) | **No** — A drags in the original B subtree |
| App shell → plugin | `staticAppExtensions.ts`, `staticDataExtensions.ts`, `appUpdateStatus.ts:14-18` (diagnostics facet) | **No** (registry itself); facet edge retargets per row 2 |

Daily-notes is the worst case and the honest benchmark: `left-sidebar` (`shortcuts.ts:7`,
`LeftSidebar.tsx:14`), `quick-find` (`QuickFind.tsx:34`), `roam-import` (`import.ts:31` + 4 more files),
`srs-rescheduling` (`srsBlockDateAdapter.ts:10`), `srs-review` (`index.ts:14`, `ReviewSession.tsx:37`),
`app-intents` (`appIntents.ts:37`), `mobile-bottom-nav` (`defaultItems.ts:6`) all import its functions,
components, or data extension directly.

## 3. The key reframing

Given §2, "replace a system plugin" decomposes into two different problems:

1. **Make a user-owned version runnable, editable, synced, and safe.** This is *materialization*, and the
   machinery is ~90% built: extension blocks, the compile pipeline, toggles, approval, settings UI,
   failure shells, safe mode. The replacement itself suffers **no** import problem: through the importmap
   it imports the original plugin's own submodules, other plugins' facets, and the whole `@/` surface as
   live shared instances. What's missing is only: (a) a way to get the built-in's *source* into a block,
   (b) a first-class **replaces** relation so disable-original + enable-mine is atomic and
   position-preserving, (c) an upgrade/divergence story.

2. **Make *dependents* of the replaced plugin hit the replacement.** Everything string-keyed already
   does (§2.5). What doesn't: static imports of behavior, which produce **split-brain** — e.g. your
   forked daily-notes changes `getOrCreateDailyNote`'s date policy, but quick-find still calls the
   original, so blocks land on differently-named notes. No materialization scheme fixes this; only (i)
   moving those entry points behind string-keyed seams, or (ii) byte-level module override.

The original notes guessed "maybe a module system is that abstraction layer." The taxonomy says: the
abstraction layer **already exists for most reference kinds** — it's the string-keyed facet/action/registry
substrate. A module-override system is only needed for the residue (behavior imports), and even there,
seam migration is cheaper and composes better (two plugins can *each* wrap a verb; only one can own a
module URL).

## 4. Axis A — materialize what, and when

### 4.1 On-demand ("eject"), not materialize-all

Materialize-all — every system plugin loads from DB blocks — is rejected:

- **Boot cost.** ~48 plugins through Babel-standalone + blob instantiation on cold start (the persistent
  compile cache helps warm boots, but cold/new-device boots pay full freight), versus the current
  synchronous first paint from the static tree (`AppRuntimeProvider.tsx:79-119`).
- **Trust.** The #67 model would need a "blessed, auto-approved" tier for unedited system code — a second
  trust path whose failure mode is silently running synced code. Today's invariant ("nothing from the DB
  runs without a device-local pin") is worth keeping absolute.
- **Fleet upgrades.** Every app deploy would become a data migration across every user's materialized
  copies, with conflict handling for the edited ones. With on-demand, unedited plugins upgrade the normal
  way — by shipping code.
- **It forfeits the default.** An unmaterialized plugin is a *feature*: upstream-maintained, torn down and
  replaced wholesale on update. Users should opt into ownership per plugin, not inherit ownership of 48.

On-demand inverts all four: the static tree stays the fast, trusted, upstream-owned base; a materialized
copy exists only where the user chose to own one, and the built-in remains on disk as the fallback.

### 4.2 Three shapes of materialization

- **Manifest** (identity, enable-state, metadata): already data — toggle ids + synced overrides (§2.3).
- **Declarations** (types, properties; later: shortcuts, settings schemas, saved queries): already data
  for user-defined ones via the projector (§2.4). §8 extends this to system definitions.
- **Code** (contributions, renderers, effects, actions): extension blocks. §5.

Materialize each thing in its *native* shape. A type you want to tweak should become a `block-type` block
(editable in the properties UI, no approval gate — it's data), not a forked plugin. Forking code should be
the escalation, not the entry point.

## 5. Stage 1 — eject & replace

### 5.1 The boot model — kernel → materialize → assemble

Today's boot makes any DB-loaded plugin structurally second-class:
`staticDataExtensions` installs the built-ins' data facets (and applies their localSchema DDL) at Repo
construction, pre-React (`src/data/repoProvider.ts:410-413`; `src/extensions/core.ts:33`), and
`AppRuntimeProvider` paints the static runtime synchronously, merging the dynamic subtree in an async
swap afterwards (`AppRuntimeProvider.tsx:79-172`). Under that ordering a replacement can only ever
*displace* an original that has already run — its effects started, its landing resolvers consulted, its
types already in the registries bootstrap seeded against. That is not proper ejection; it caps forks at
UI-level changes.

The design therefore restages boot so that materialized plugins load **before** plugin assembly, and
everything downstream consumes one unified plugin set:

- **Stage 0 — kernel.** Open the DB, apply kernel client schema + the static localSchema DDL, construct
  the Repo with `kernelDataExtension`, read the overrides cache (localStorage,
  `src/extensions/overridesCache.ts`) and the approval store (IndexedDB). This is the non-ejectable
  floor — everything required to *decide* what to load: it must stay static for the same reason
  `essential` toggles exist.
- **Stage 1 — materialize.** After the active workspace resolves (already an async pre-mount step in
  `App.tsx`), query the workspace's extension blocks; for each enabled-by-intent block with a
  device-local approval, instantiate the **pinned compiled output**. Partition into *substitutions*
  (blocks with `extension:replaces`) and *additions*. The enabler that keeps this off the slow path:
  **approval pre-compiles** — `approveExtension` persists the transpiled output
  (`compileExtensionModule.ts:331-364`) and `loadApprovedExtension` touches Babel only on a
  compiler-version bump (`:380-401`) — so this stage is one SQL query + N IndexedDB reads + N blob-URL
  imports whose `@/` dependencies are (for forks) modules the static bundle is loading anyway.
- **Stage 2 — assemble.** Build the single plugin list: the static manifest with substitutions applied
  in place, plus additions. Install **all** data extensions — forks' included — on the Repo at the same
  point `staticDataExtensions` installs today (re-invoking the idempotent localSchema application for
  fork contributions); run workspace bootstrap (backfills, seeding, landing) against the complete
  registries; mount React and resolve the runtime **synchronously** — every module is already live, so
  `resolveAppRuntimeSync` still works and the base/merged double-commit in `AppRuntimeProvider`
  collapses to one commit. The warm-reload swap machinery (toggle/edit → `refreshAppRuntime`) is
  unchanged; it just stops being the delivery mechanism for replacements at boot.

**Schema parity is the point:** a stage-2 plugin — static or materialized — contributes types, property
schemas, invalidation rules, processors, and localSchema from the same lifecycle position. The two v1
compromises this doc previously accepted disappear: there is no flash-of-original (the replaced plugin
never executes), and forks may change their data extension (bounded by §5.6's localSchema note).

**Latency accounting.** Nothing ejected and nothing approved (including every fresh device before first
sync/approval): stage 1 is one query returning nothing boot-relevant — effectively today's boot; on a
fresh device the built-ins run regardless, which the #67 trust model requires anyway. With N materialized
plugins: N approval reads + N blob imports of already-cached compiled strings, plausibly tens of
milliseconds; the one expensive path is the first boot after a compiler-version bump (re-transpile from
`approvedSource`), which an update hook can pre-warm in the background instead of paying at next paint.
Additive (non-replacing) extensions move into stage 2 by default too — that is what lets a user extension
define a type the bootstrap can see — with a per-block lazy opt-out as the escape hatch if a heavy
extension shouldn't block paint (§12).

### 5.2 Getting the source

Zero-build-change path: fetch the plugin's emitted modules' `.js.map` files
(`${base}src/plugins/<id>/*.js.map`, stable URLs per §2.2) and extract `sourcesContent` — the original
authored TSX, pre react-compiler. In dev, Vite serves the same via its transform pipeline (or `?raw`).
If sourcemap-scraping proves brittle, the fallback is a tiny Vite plugin emitting `plugin-src/<id>/…`
as build assets; both produce the same thing: **the authored source of any built-in, addressable at
runtime.**

### 5.3 Eject depths

An ejected block's imports must be absolute (`@/…`): blob modules have no usable base URL, so the eject
step mechanically rewrites the entry's relative imports `./x` → `@/plugins/<id>/x.js`.

- **Wrapper (shallow).** The block doesn't copy implementation at all — it imports the original's parts
  and re-composes: omit a contribution, wrap one in a decorator, add one, reorder. This is the
  renderer-replacement pattern from `docs/extensibility-axes.md` (substrate axis: "import the parts,
  re-assemble") applied to a whole plugin. Tiny source, tracks upstream automatically. This should be the
  default eject output: the generated block is the plugin's *composition root* (its `index.ts` shape) with
  every submodule still imported from the original.
- **Entry fork.** Same block, but the user starts inlining: copy the body of the one function they want
  to change into the block (source for any submodule is fetchable per §5.2), keep importing the rest.
  Progressive, no tooling needed, single block.
- **Deep fork** (edit many submodules as separate blocks) needs cross-block imports — exactly the
  capability issue #253 icebox-gated. Ejection becomes the *second* trigger on that issue. Until then,
  deep forks flatten into the one block by hand.

The wrapper default matters for upgrades (§9): a wrapper survives upstream refactors of function *bodies*
untouched; only signature/shape changes break it — the same ABI-commitment logic the extensibility-axes
doc applies to substrate seams.

### 5.4 The `replaces` relation

New property on extension blocks: `extension:replaces = 'system:<plugin-id>'` (a toggle id, §2.3),
set by the eject action alongside `extension:name`/`description` and provenance (§9).

Substitution happens at **assembly time** (stage 2 of §5.1), not in the resolver walk: stage 1 builds
`Map<togglableId, replacement>` from extension blocks that (a) declare `replaces`, (b) are enabled by
intent, **and (c) actually instantiated from a device-local approval**. Assembly looks up each manifest
entry by its toggle id and swaps in the replacement — the fork occupies the original's slot in the plugin
list (and in the data-extension installation) before anything resolves or runs. This requires the two
hand-maintained arrays (`staticAppExtensions.ts`, `staticDataExtensions.ts`) to become one **id-keyed
manifest** — plugin id → {app extension, data extension, order} — which is a prerequisite cleanup, not
scope creep (§10).

Why a first-class relation instead of "user disables built-in + enables replacement" as two toggles:

- **Cross-device safety.** Intent syncs; approval doesn't. On a device that hasn't approved the fork yet,
  condition (c) fails → **the built-in keeps running** and settings shows the standard "Enable here"
  prompt. With two independent toggles, that device would run *neither* — a synced self-DoS. Same logic
  covers instantiation failures (error shell + built-in stays). Safe mode skips stage 1 outright (no
  block is instantiated — the loader's existing safe-mode behavior), so assembly is pure-static and the
  resolver additionally forces every non-essential boundary off (`resolveAppRuntime.ts:66-69`) —
  recovery never depends on replacement machinery.
- **Position preservation.** `staticAppExtensions.ts` ordering is load-bearing (landing-resolver
  last-wins, app-intents last, etc. — see its comments). A replacement appended after the static list
  would register after everything; substitution at the manifest slot keeps the original's position, so
  order-sensitive facets behave identically.
- **Attribution.** Settings can render one honest row — "Daily notes — replaced by *My daily notes*
  (block link)" — with un-eject as a single affordance (disable/delete the replacement → built-in
  resumes; nothing to migrate back because the built-in never left the bundle).

A malicious or accidental synced block claiming `replaces: 'system:whatever'` gets nothing: without this
device's approval it doesn't satisfy (c), so it can neither run nor suppress the built-in. `essential`
boundaries (`kernelDataExtension`, extensions-settings itself) are excluded from replacement in v1 for
the same reason they're excluded from toggling.

### 5.5 Factory plugins and context

Plugins built as factories (`dailyNotesPlugin({repo})`) eject as function-valued extensions — the resolver
passes `FacetResolveContext = {repo, workspaceId, safeMode, generation}`
(`AppRuntimeProvider.tsx:70-75`), and `dynamicExtensions.ts` already supports function-valued default
exports (`:263-271`). No new plumbing.

### 5.6 Costs and constraints

- **localSchema depth.** A fork's localSchema contributions apply by re-invoking the existing
  application step after stage 1 (`applyLocalSchemaContributions`, called with the static set at
  `repoProvider.ts:410-413`); contributions must stay idempotent, which is already the house style the
  kernel's own statements model (`CREATE … IF NOT EXISTS`, probe-gated backfills,
  `repoProvider.ts:387-409`). What a fork *cannot* do is retroactively reshape kernel-created tables —
  the same limit static plugins live with across app versions (they use backfills).
- **Dragged-along composition.** Some plugins compose another plugin's data extension by direct import
  (`srs-review/index.ts:14` pulls `dailyNotesDataExtension`). With daily-notes replaced, the *original's*
  data contributions still enter assembly through srs-review's subtree while the fork's enter at
  daily-notes' slot — keyed registries collide, and since the dragging plugin sits later in the manifest,
  last-wins would favor the **dragged original** over the fork. v1 must prune dragged contributions whose
  owning plugin is replaced (which requires data extensions to carry owning-plugin provenance), and the
  §6 seam work should retire cross-plugin data-extension composition in favor of manifest
  `requires` edges — composition-by-import is precisely the coupling this design exists to remove.
- **Per-workspace scope.** Extension blocks and overrides are per-workspace, so a fork's data extension
  installs per-workspace where static ones are global today. Semantically right — blocks are workspace
  data — but a stated behavior difference: switching to a workspace without the fork reverts to the
  built-in, data facets included.
- **No sandboxing.** A fork runs in-realm with full app authority, like any user extension. The approval
  gate is the security model (`docs/plugin-module-url-sw-hybrid.md` §5; `compileExtensionModule.ts`
  #67 commentary). Ejecting doesn't widen the surface — it's the same pipeline — but "edit a system
  plugin" will invite more users through it; the approval dialog copy should carry the weight.
- **React-compiler delta.** Runtime-compiled forks skip the build-time react-compiler pass — a fork is
  marginally less render-optimized than the built-in it replaces. Cosmetic at plugin scale.

### 5.7 Trust flow

Eject is an explicit local gesture, and the content written is the authored source of code this device
already runs (as its built form) from the trusted bundle — so the eject action calls `approveExtension`
immediately (pin = upstream source at eject time). Every subsequent edit follows the existing drift rules: synced edits from another device show
`update-available` and keep running the pin until re-approved (`dynamicExtensions.ts:146-172`). Nothing
new to design; this is the system working as built.

## 6. Stage 2 — retargeting dependents (seam hardening)

The residue from §2.5: cross-plugin **behavior** imports. The fix is the codebase's existing playbook —
string-keyed seams — applied to the specific edges that matter:

- **Helper functions → named mutators/queries or verbs.** `getOrCreateDailyNote` becomes a mutator (e.g.
  `dailyNotes.getOrCreate`) registered by the plugin; importers call `repo.mutate.*`. A fork re-registers
  the same key and wins deterministically (runtime bucket after static + last-wins, §2.4). The
  `keyedMapFacet` collision warning becomes documentation of the override rather than noise — worth a
  `replaces`-aware suppression so intentional shadowing doesn't warn.
- **UI components → variants or registries.** `ReschedulePicker` consumed by srs-review is the
  `backlinksViewFacet`-style variant case, or a typed imperative registry
  (`video-player/registry.ts` pattern).
- **Composed extension arrays** (`srs-review` bundling `dailyNotesDataExtension`): mostly benign under
  the v1 rule that forks keep data extensions identical — the composed copy *is* the original, deduped by
  contribution reference. Revisit only if data-extension forking is ever allowed.
- **Constants:** leave them. Importing `DAILY_NOTE_TYPE` from the original module is correct even when
  daily-notes is replaced — the fork keeps the same string values because the *data* (existing blocks
  typed `daily-note`) does.

Do this opportunistically, ranked by importer count (daily-notes first — it is both the most-imported and
the most plausibly forked), not as a big-bang migration. Each promoted seam is also a normal extensibility
win independent of ejection — this stage is `docs/extension-seam-gaps.md` work with a sharper
prioritization function.

Honest limit: until a given edge is promoted, a fork that changes that behavior gets split-brain for
callers of that edge. The eject flow can even say which: the edges are statically knowable per plugin.

## 7. Stage 3 (gated) — module-URL override

The full substrate seam: because prod is `preserveModules` + stable URLs + browser-time resolution, a
service worker intercepting `/src/**` fetches could serve replacement bytes for any module, retargeting
**every** importer — including other bundled plugins' static imports — with no seam migration. This is
the "module system as the abstraction layer" hypothesis made concrete, and it extends the #253 design
(SW `/module/` route, on-demand page-producer protocol, generation-gated claim).

Beyond everything #253 already catalogs, system-module override adds one hard new problem: **boot-path
modules.** The static import graph is fetched while the page is loading — before any page JS exists to
"produce" bytes on demand. Overriding a module in that graph requires bytes at rest (a SW-readable Cache
written at approve time), which trades away the "no compiled plaintext beyond IDB" property and adds
cache-coherence with app generations; or restricting overrides to post-boot dynamic imports, which
system plugins are not.

An importmap variant (inject `"/src/plugins/x.js": blobUrl` mappings via an inline script minting blob
URLs synchronously from a localStorage byte cache, before the module graph loads) avoids the SW but
inherits the same bytes-at-rest tradeoff, requires URL-keyed remapping + multiple-importmap behavior
that is only recently cross-browser, and is reload-to-apply. Documented as explored, not recommended.

**Trigger discipline** (same shape as #253's): build this only when a real fork needs (a) submodule-level
replacement that progressive inlining can't absorb, or (b) importer retargeting on an edge that seam
migration can't reach. Until then it's additive machinery. Stages 1+2 don't depend on it, and nothing in
them forecloses it.

## 8. Parallel track — materializing types & properties

The projector (§2.4) means "materialize declarations" is a seeding feature, not an architecture feature:

- **"Edit this type" affordance** on any system type: writes a `'block-type'` block seeded from the static
  `TypeContribution` (and `'property-schema'` blocks for its properties), same provenance properties as
  §9. The projector publishes it into the durable `'user-data'` bucket, which shadows the static
  definition by the verified last-wins order. Un-materialize = delete the block.
- Same cross-device story as data (it *is* data): no approval gate, syncs like any block, editable in the
  existing user-types/properties UI the projector services already serve.
- Same divergence problem as code (§9), so the same base-hash provenance applies: on app update, "the
  built-in definition of `todo` changed since you materialized it" is a settings-surface diff, not a
  silent fork.
- v1 constraint: shadowing should *extend* (add properties, change labels/defaults), not repurpose ids —
  kernel invariants (e.g. `'extension'`, `'page'`) stay essential/non-materializable.

This track also sets the pattern for the next declaration kinds the projector header already anticipates
(commands / saved queries): each new projectable meta-type makes more of a "plugin" expressible as data,
shrinking what ejection has to fork as code.

## 9. Upgrades & divergence

Every materialized artifact (code block or declaration block) carries provenance properties:

- `extension:replaces` — the toggle id (code) / definition id (declarations) it shadows,
- `extension:base-version` — app version at eject,
- `extension:base-hash` — SHA-256 of the upstream source/definition it was seeded from,
- the base source itself, stored at eject time (a child block or property) — small, and it's what makes a
  future three-way merge possible client-side.

On app update, a cheap maintenance check (the db-maintenance / extensions-settings effect family)
compares each materialized artifact's `base-hash` against the current upstream hash (recomputed from
§5.2 sources): mismatch → settings status **"upstream changed since your fork"** with a diff view
(base vs current upstream; the user's edits are visible as block content vs base). v1 offers *awareness +
manual re-eject/merge*; automated three-way merge is explicitly out of scope until the manual flow shows
demand. Wrappers (§5.3) mostly never trip this — they have no copied bodies to go stale, only the
import-surface contract.

Un-eject is total and safe in both tracks: the upstream artifact never left the bundle.

## 10. Rejected & deferred alternatives

- **Materialize-all by default** — §4.1.
- **Blessed auto-approval tier for system-sourced blocks** — weakens the single-trust-path invariant for
  a convenience the eject-time `approveExtension` already provides on the ejecting device.
- **Module system first** (SW or importmap override as the prerequisite abstraction layer) — §3/§7: the
  string-keyed substrate already retargets most references; the residue is better served by seam
  migration; byte-level override stays available as the gated escalation.
- **A full `provides`/capability layer** — the *id-keyed manifest itself* is no longer deferred: assembly
  substitution (§5.4) needs a lookup target, so folding `staticAppExtensions.ts` +
  `staticDataExtensions.ts` into one manifest (plugin id → {app extension, data extension, order}) is a
  Stage-1 prerequisite, and `requires` edges are the designated successor to composition-by-import
  (§5.6). What stays deferred is the general capability marketplace — arbitrary providers satisfying
  shared capability ids — until multiple plugins actually want to satisfy the same contract.

## 11. Implementation sketch (Stage 1)

1. **Manifest unification** (independently landable, pure refactor): fold `staticAppExtensions.ts` +
   `staticDataExtensions.ts` into one id-keyed manifest — plugin id → {app extension, data extension,
   order} — preserving today's ordering and its comments. The two current arrays become derived views.
2. **Boot restage** (§5.1): hoist extension-block loading out of `AppRuntimeProvider`'s async effect
   into the pre-mount sequence (after workspace resolution in `App.tsx`); assemble the unified plugin
   set; install all data extensions + re-apply localSchema for forks; `AppRuntimeProvider` consumes the
   assembled set and drops the cold-start base/merged double-commit (warm-reload swap machinery stays).
   Safe mode short-circuits stage 1.
3. **Source provider** (`src/extensions/pluginSources.ts`): resolve a plugin id → entry + submodule
   sources (prod: fetch `.js.map` `sourcesContent`; dev: Vite `?raw`), plus the relative→`@/` import
   rewrite. Pure, unit-testable.
4. **Properties** (`src/data/properties.ts`): `extension:replaces`, `extension:base-version`,
   `extension:base-hash` (+ base-source storage decision).
5. **Eject action** (new small plugin or extensions-settings): create block (content = wrapper-style
   composition root by default), set properties, `approveExtension`, enable intent, `refreshAppRuntime()`.
   Agent-bridge command `eject-plugin <id>` alongside.
6. **Assembly substitution + dragged-contribution pruning** (§5.4, §5.6): loader tags each instantiated
   block with its `replaces` target; assembly swaps manifest entries and prunes data contributions whose
   owning plugin is replaced (requires owning-plugin provenance on data extensions).
7. **Settings UI**: "Replaced by …" row state, un-eject, upstream-changed badge (§9 check).
8. **Tests**: substitution preserves manifest position (order-sensitive facet before/after); unapproved
   device keeps built-in; instantiation failure keeps built-in + shell; safe mode boots pure-static; a
   fork's data extension contributes a type visible to bootstrap/seeding (the schema-parity property);
   dragged-composition pruning (fork mutator wins over a composed original); eject rewrite idempotence;
   provenance round-trip.

## 12. Open questions

- **Toggle-id stability as public API.** `replaces` makes `'system:<id>'` strings a compatibility
  surface. Commit to them (rename = migration) — cheap now, worth stating in `togglable.ts` docs.
- **How much of `@/` to freeze.** Forks deepen the de-facto API-ness of `src/extensions/api.ts` and of
  plugin submodule paths. Options: accept drift (forks break on refactor, upstream-changed badge catches
  it) vs. carving a semver'd surface. Leaning: accept drift in v1; wrappers make breakage shallow.
- **Base-source storage shape** — property vs child block vs re-derivable-only (store hash, fetch old
  source from a versioned asset). Child block is simplest and E2EE-consistent.
- **Per-workspace vs per-user semantics.** Extension blocks and overrides are per-workspace today;
  ejection inherits that. Is "replace daily-notes everywhere" a want? (Defer; consistent with existing
  extension semantics.)
- **Boot-blocking policy for additive extensions.** Stage-2-by-default gives every extension schema
  parity, but lets one heavy user extension delay first paint. Per-block opt-out
  (`extension:boot-phase: lazy` keeps today's post-paint behavior), a time budget, or measure first and
  do nothing? Leaning: default stage 2, opt-out property, add a budget only if real extensions hurt.
- **When does #253 fire?** Deep forks (multi-block plugins with cross-block imports) are the cleanest
  trigger this repo has produced for the SW `/module/` work; ejection telemetry (how often users inline
  past the wrapper stage) is the signal to watch.
