# Installed extensions in the headless host

> **Status:** Proposed. Nothing is implemented. Three decisions are settled by the owner; all are in [§9](#9-decisions). Last verified against code: 2026-11-27.
> Claims are tagged as in [headless-client.md](headless-client.md). **[read]** means seen in the code. **[measured]** means run or queried, and the entry says where. **[reasoned]** means inferred; the slice that would verify it is named.

## 1. Goal

User-installed extensions are the extension blocks stored in the graph. This design lets the headless host (`scripts/headless/`, [headless-client.md](headless-client.md)) run them, so the host is a complete client and not just the data layer.

The motivating case is the Matrix chat client extension. Its `/sync` ingest is an app effect, `appEffectsFacet`. It writes each message under a block id derived from the Matrix event id (`pluginBlockId`), so several clients ingesting the same room converge on the same blocks. Today the ingest runs only while a tab is open. An always-on host should run it instead. The owner chose to make installed extensions work headless in general, rather than move Matrix into a static plugin or write a standalone poller. A headless browser is ruled out on the target host because memory is small and the OOM killer kills browser pages first.

## 2. Population

Queried read-only on the owner's tab replica (all its workspaces), 2026-11-27 **[measured]**:

| | |
|---|---|
| Installed extension blocks | 35 |
| Contributing `appEffectsFacet` | 2, both "pull an external API into the graph" integrations |
| Contributing UI facets (mounts, renderers, gutter items, decorators) | 21 |
| Contributing actions / seeds | 14 / 12 |
| With an `https:` import | 1, the Matrix extension (`https://esm.sh/matrix-js-sdk@38.0.0?bundle`). Four others contain `https://` only in strings and doc comments; none builds a URL import at runtime |

So the whole case is two background effects. This design builds for them and for the general loading path they need. It does not build for a population that does not exist.

## 3. What already exists

- **The loader has the seam this needs.** `dynamicExtensionsExtension` (`src/extensions/dynamicExtensions.ts`) applies two gates. Gate 1 is the synced enable intent (an overrides map keyed by block id), checked before compiling. Gate 2 is a device-local approval that pins the approved source hash and its compiled output. The loader then validates the export, prefixes provenance (`block:<id>`), and binds seeds. The approval store is injectable through its `persistent` option, and it reports a pin that differs from the live source as `update-available`. Its `verifyLiveSource` option already skips gate 2 and compiles the live `block.content` through `compileForVerification` (used only by the install path) **[read]**.
- **The compile pipeline is replaceable.** `compileExtensionModule.ts` splits it into transpile (Babel) and instantiate (blob-URL `import()`). Each is a module-private function with a `__set…ForTest` setter, beside a full source→module override for tests **[read]**.
- **Effects are React-free.** `EffectReconciler` and `LiveRuntimeHandle` (`src/extensions/liveRuntime.ts`) start and stop `appEffectsFacet` contributions by id. A `LiveRuntimeHandle` lets a holder survive a runtime swap **[read]**.
- **Extension sources evaluate in Node today, in tests.** `src/test/exampleModuleResolver.ts` transpiles with the loader's presets to CommonJS and runs the result over a `require` map of real module imports. Its `runnableSpecifier` already checks a specifier against `index.html`'s real importmap (`src/test/pageImportMap.ts`), and `importedSpecifiers` lists a module's imports from its parsed AST. Its `require` builder, though, still finds specifiers with a regex and imports each before any check **[read]**.
- **Both effect extensions load in the host's process shape.** Under vite-node with `scripts/headless/vite.config.ts` on Node 26, the Matrix and Readwise extensions evaluate to their default export through that Babel→CJS path **[measured]** (by the design author, with the `https:` import stubbed). The `appEffectsFacet` they contribute is the same object the host imports, so facet identity holds. Every `@/` module Matrix imports loads without a DOM, including `@/components/ui/*`, sonner-backed toasts, `react` and `react/jsx-runtime` **[measured]**.

What is missing, all **[read]** except the one marked:
- The host resolves only `staticDataExtensions`, through `resolveFacetRuntimeSync`, and runs no effects (`scripts/headless/host.ts`). The sync resolver throws on a function-valued extension, which the loader is. The host also builds its agent context on that runtime before the gate opens.
- The verb table refuses `eval`, the extension verbs and `run-action` (`scripts/headless/commands.ts`).
- There is no enable intent on the host: `extensions-settings` is not in `staticDataExtensions`, and intent is per user, kept in the user's own extensions prefs block.
- `import('https://…')` fails in Node with `ERR_UNSUPPORTED_ESM_URL_SCHEME` **[measured]**.
- Neither platform pins a URL import. A tab resolves one over the network each time the extension loads, so the approval covers the import's URL but not the bytes it serves **[read]**. The host cannot load one at all.

## 4. Trust

This section decides everything else.

**On the host, an extension is a program run as the daemon's OS user.** In a tab, an approved extension already holds the session, every decrypted row and the use of the workspace key, inside the browser's origin sandbox. On the host it also gets:
- the extractable key: the key file, the key command, or the key string in memory;
- the filesystem and processes of that OS user;
- unrestricted network access;
- persistence on the machine.

That extra exposure is why `eval` is refused ([headless-client.md](headless-client.md) §8), and it applies to extension code the same way.

**No in-process mechanism isolates code that needs the Repo** **[reasoned]**:
- `node:vm` and ShadowRealm are not security boundaries, and a separate realm would break facet identity, which needs the host's own module instances.
- A worker thread runs in the same process with the same permissions.
- Node's `--permission` is process-wide. The host itself needs the state directory, the key source and, for `keyCommand`, child processes, so extension code inherits all of that.
- A separate process for extension code would need an RPC Repo with handles and subscriptions, which is a new extension API. It would still read and write the whole graph by design, saving only the key, the session and the OS account's other files.

The one real lever is the daemon's OS user: a dedicated user with nothing else in its home.

**The boundary:**
1. **A host runs an extension block only if its own config names that block id with the path of a reviewed copy of its source.** The config file and the files it names are the trust anchor. The config already stands in for a person's confirmation of a plaintext workspace, though there it sits alongside the server row and here it stands alone. Whoever can write the config or a named file as the daemon's OS user can grant code execution, as they already can by editing the checkout the host runs. That includes any agent session running as that user, and those sessions read graph content. No bridge verb grants, changes or revokes the grant (the extension verbs stay refused), and no synced value takes part: not intent, not approval state, not the source.
2. **The host runs the reviewed copy, never the live block content** ([§9](#9-decisions) D1, decided). This is the tab's #67 rule with the reviewed file as the pin. The live block still has to exist, since the loader walks live extension blocks, so deleting it in the graph stops the block at the next restart. When the live source differs from the reviewed copy, the host keeps running the reviewed copy. It logs that a review is needed and reports `update-available` in `health`.
3. **Imports resolve only to what `index.html`'s importmap maps, or to an `https:` URL carrying an integrity hash** ([§5](#pinned-url-imports)). The importmap rule reuses `runnableSpecifier`, so tab and host accept the same specifiers. Specifiers are checked from the AST before anything is imported. Anything else is a load error that names the specifier: an unpinned `https:` import, bare packages, `node:*`, computed `import()`. During the transition ([§9](#9-decisions) D3), a tab is the one exception: it still loads an unpinned `https:` import live, as today, with a warning. The host never does. The host also refuses direct imports of the extension compile and evaluator modules, since they evaluate graph content with no hash check. This is a portability rule, not a sandbox. A pinned source can still use `new Function`, `process.getBuiltinModule`, or code it fetched. The review in rule 4 has to catch "fetches or evaluates code", and also "re-exports a static plugin", since provenance prefixing would start that plugin's effects as the block's own.
4. **Allowlisting a block trusts it with the workspace key, the host's session and the daemon's OS account.** The operator procedure says this in those words, and lists the review items from rule 3.
5. **The reviewed copy comes from a reviewed commit, never from the graph.** Copying the live block into the file would let whoever edited the block choose what the host runs. So `health` and the log say only that the live source differs, and never carry its content or hash. To compare them, the host normalises the file the way `install-extension` does before storing, which trims trailing whitespace, so a raw hash of the file never matches **[measured]**. That normalisation becomes one function, shared by install and host.
6. **A device-stored secret is stored under the destination it may be sent to.** Synced config must not be able to redirect it. For Matrix, the access token is kept per homeserver, so a synced homeserver change finds no token and reports missing-token.

| Attacker | What they get on the host |
|---|---|
| A compromised editor account edits an allowlisted block's source | Nothing. The host keeps running the reviewed copy and reports `update-available` |
| A compromised editor installs a new extension block | Nothing. Its id is not in the config |
| A compromised editor edits the synced config an allowlisted extension reads | Only what the reviewed code does with that config. The secret does not follow a changed destination (rule 6). A changed room makes the host ingest that room, which an editor could write into the graph directly anyway |
| A holder of a bridge token, including a read-write one | Nothing. No verb reaches the allowlist |
| A compromised CDN | Nothing after pin time. A device fetches a pinned import only when it approves, and refuses bytes that do not hash to the pin. Bytes served at pin time are trusted as pinned, and code a pinned bundle loads at runtime is outside the pin (rule 4) |
| The allowlisted source itself is malicious or buggy | Everything the daemon's OS user can reach |

The AGENTS.md review rule that rates "synced data that runs code in another device's client" as P1 holds: synced data can only stop code on the host, never start it. The last row is the cost of the feature, and the operator signs for it per block by naming a reviewed file. If the daemon shares an OS user with agent sessions, those agents can already read the key file ([headless-client.md](headless-client.md) §8), so a separate user is hardening, not a precondition. If the daemon runs as the operator's own account, the last row reaches everything that account holds, and the procedure must say so.

## 5. Loading

**Runtime.** After the gate first opens, the host resolves `[staticDataExtensions, dynamicExtensionsExtension({…})]` with the async `resolveFacetRuntime` and installs it with `repo.setFacetRuntime`. It waits for the gate because the extension-block query needs a complete view. The agent context the host builds at boot gets a `LiveRuntimeHandle` over the static runtime, and the handle's `setCurrent` swaps in the full one, so the served verbs see the extensions' seeds.

**The gate uses the loader's existing seams, with no loader change.**
- *Gate 1* gets `overrides` built from the allowlist, so unlisted blocks are skipped before compiling, as they are today.
- *Gate 2* gets the host's approval store through the loader's existing `persistent` option. It is a read-only `CompiledModuleCache` built from the config: `read(blockId)` returns a record whose `approvedSource` is the normalised reviewed file, with its hash and its compiled output under the current compiler version. For an unlisted id it returns nothing. `write` and `delete` are no-ops; the one load-path write is a best-effort re-pin after a compiler bump, which cannot occur here **[read]**.
- *The rest is existing code.* The loader runs the pinned output and reports `update-available` through `approvalStatusReporter` when the live hash differs **[read]**. The host logs that report and shows it in `health`.

**Compiling under Node.** The transpile and instantiate setters stop being test-only. They become `setExtensionCompilePlatform({transpile, instantiate})`, and the full-compile override stays test-only. The Node platform is Babel to CommonJS with the same `EXTENSION_BABEL_PRESETS`, evaluated over a `require` map. The evaluator moves from `src/test/exampleModuleResolver.ts` into a core module that takes the importmap as a parameter, so it imports no `node:` module and stays browser-safe in the build. That module checks every specifier from the AST (rule 3), then imports each `@/x.js` as `@/x` through vite-node, so the extension gets the instances the host runs. The tests and the host both import it, and each reads `index.html` itself. Compiling the reviewed file on each boot costs about 70 ms per extension **[measured]**, so the host persists no compiled output.

**UI imports are loaded, not avoided.** The Matrix extension imports its dialog, buttons and toast modules, which load in Node with no DOM **[measured]**. Loading them is not a separate trust question, since one review covers the whole file. A headless entry module or a per-extension "headless" declaration would split every extension for a population of two, so it is rejected unless memory forces it ([§8](#8-slices)).

<a id="pinned-url-imports"></a>**Pinned URL imports, the same in tab and host** ([§9](#9-decisions) D2, decided). Users keep writing CDN imports. The pin goes into the source, on the import itself:

```ts
import * as sdk from 'https://esm.sh/matrix-js-sdk@38.0.0?bundle&target=es2024'
  with {integrity: 'sha256-…'}
```

Because the hash is source text, the tab's existing source pin (#67) and the host's reviewed file both cover it. That needs no lock file, no new property and no synced bytes. Each device fetches each pinned URL once, when it approves the extension, and nothing is fetched at load. Tab and host therefore run byte-identical modules, or the approval is refused.

*What esm.sh serves* (fetched and inspected as text, never executed; 2026-11-27) **[measured]**:
- *Without `target=`:* the response depends on the user agent. A browser gets a stub plus 136 modules (2.79 MB), 52 of them on semver-range paths and 56 not immutable, with `Vary: User-Agent`. A Node agent gets a different build that imports `node:` builtins.
- *With `&target=es2024`:* esm.sh serves a 107-byte stub that re-exports one 1,164,790-byte module. That module has no static or dynamic imports, is served `immutable`, and is identical across user agents and repeated fetches. It is 296 KB gzipped.
- *Not separate modes:* `?standalone`, `?bundle=all` and `?bundle-deps` return the same bytes as `?bundle`.
- *Treated as observed, not as a contract:* `target=es2024` giving one file held for this SDK and for `date-fns`. A package with a peer dependency still pulls it from a range path; `react-markdown` pulls a second React that way.

*The freezer* is one function, shared by the CLI, the tab and the host:
1. Fetch the URL. If the body is only `export * from "<one URL>"`, optionally plus `export {default} from` the same URL, follow that URL once, resolved against the final URL after redirects. A stub that renames or selects exports is refused, since substituting its target would change the namespace. The integrity value therefore hashes the stub's target, not the named URL, which is not what the web's subresource-integrity attribute means.
2. Refuse unless the resulting module has no import or export-from statements and no `import()` (checked from the AST). The error names the count and, when the response varied by user agent, suggests pinning `target=`. A browser cannot set its user agent, so an agent-dependent URL could never freeze identically in a tab and in Node.
3. The integrity value is the SHA-256 of that module's bytes.

Multi-module closures are refused, not bundled. A tab has no bundler, and a raw closure would need its specifiers rewritten at load, where blob URLs cannot express cycles **[reasoned]**.

*Adding the pin.* A new `pin-imports <file>` CLI verb runs the freezer and writes the attributes into the file. `install-extension` warns about a URL import with no integrity value during the transition, and refuses one after it. In a tab, the approve flow offers "Pin imports" for an unpinned source. That step rewrites the block's source in one undoable transaction, then approves it. The rewrite splices the attribute in at each import's AST offsets and never regenerates the code, since the source is user data. The new source syncs, so every other device sees `update-available` and keeps its old pin until it approves the new source with "Update", which fetches there. Two devices pinning the same source at once conflict as ordinary concurrent edits to one block, with the same result either way. The host never writes a source; its reviewed file must already be pinned.

*Install verification* (`compileForVerification`, the loader's verify mode) instantiates live source with no record, so it runs the freezer in memory for each pinned import.

*Compiling.* A Babel plugin in the transpile step replaces each pinned specifier with `km-vendored:<integrity>` and drops the attribute, so the pinned compiled string contains no URL. An unpinned `https:` import is where the transition lives, in this one place:
- *During the transition,* the plugin leaves it as a live import, as today, and the loader reports `imports-unpinned`. That surfaces like `update-available`, in the settings row and the approval prompt, with "Pin imports" as its action.
- *After the transition,* the plugin refuses it. Refusing in the plugin, and not only in the freezer, also covers the load path's recompile of an old record after a compiler bump, which would otherwise emit a live network import.
- *The host* refuses an unpinned import in both phases, since Node cannot load it. Babel 8 standalone parses the attribute under the loader's presets, and TypeScript 6 accepts it with the existing `https://*` module declaration **[measured]**. The plugin changes the compiled output, so `COMPILER_VERSION` is bumped.

*Instantiating.*
- *Tab.* The approval record (`CompiledRecord`) gains an optional `vendored: {integrity → module text}`, written only by `approveExtension` after the freezer verifies it. Absent means none, so `isApprovalRecord` keeps accepting every existing approval. At load, each placeholder becomes a blob URL over the stored text.
  - *Compiler bumps:* the load-path re-pin copies the record (`{...approval, …}`), so `vendored` survives and nothing is re-fetched **[read]**.
  - *Idempotency:* `approveExtension` treats a record as current only if its source hash and compiler version match **and** every pinned import in the source has a `vendored` entry. Without the third clause, a record re-pinned without its bytes during a version window would make "Update" a permanent no-op.
  - *Lifetime:* the record is deleted on uninstall through the agent verb. Disabling keeps the pin by design (`ExtensionsOverridesEditor`), and so does deleting the block in the outliner **[read]**. So about 1 MB of vendored text per pinned import stays in the device's IndexedDB until then. That is accepted: it is bounded, and re-enabling needs no fetch.
- *Host.* Verified bytes are cached at `<state>/vendored/<sha256>.mjs`. At boot the host reads the cached file once and checks its hash. On a miss or mismatch it fetches, verifies and rewrites the file; a bad fetch is a `load-error`. It then imports those same in-memory bytes as a `data:` URL. A `file://` import would not do: vite-node passes a `.mjs` outside `node_modules` through Vite's SSR transform, so the host would run transformed code, not the bytes it hashed, whereas `data:` stays external **[measured]**. Importing from memory also leaves no gap between the hash check and the load. The vendored module is not put through Babel-to-CJS: that transform takes 0.8 s on this bundle and keeps `import.meta`, which would fail inside the CJS evaluator's function body. The extension itself stays Babel-to-CJS.
- *Default-import interop.* A module namespace has no `__esModule` flag and cannot be given one, and Babel's CJS helpers then treat the whole namespace as a default export. So `import d from '<url>'` would yield the whole namespace on the host and the real default in a tab **[read]**. The host's `require` therefore hands out, for every specifier (`@/` modules included), a wrapper with `__esModule: true` whose properties are getters over the namespace, so live bindings survive.

*Testing identity.* A local test server serves a fixture "CDN" module with named and default exports, top-level await and a read of `import.meta`. Only its accessibility is asserted, since its `url` is `blob:` in a tab and `data:` on the host. A fixture extension imports it three ways: namespace, default and named. The same assertions run through the host platform in vitest and through the tab platform in headless Playwright. The host test also asserts the vendored module was not transformed. Each of these deletions must fail a named test:
- the hash comparison;
- the self-contained check;
- the `__esModule` wrapper.

*What a pin does not give.* Pinning trusts whatever the CDN served at pin time. The pin also covers only the module's static shape. A bundle that builds an `import()` at runtime (`new Function('u', 'return import(u)')`) passes the AST check, then fetches live in a tab and fails on the host. That is code the pinned bundle chose to load, outside the pin, and rule 4's "fetches or evaluates code" review item is what catches it. A 1 MB minified bundle is not reviewable by reading, so "pulls package X at hash H" joins the rule 4 review items, and the hash guarantees only that every device runs the same bytes. Pinned imports are not synced. A device approving after the CDN stops serving those bytes cannot approve until the import is re-pinned or its version bumped, which is a visible source change. Syncing the bytes as media blocks is deferred until that happens. The bytes would be transport, not trust: the pin in the source is still what a device checks.

## 6. Enable state and the allowlist

**The host has one gate: the allowlist.** Enable intent is per user, and the host signs in as a different account. "Enabled in my tab" also does not mean "run on my server": 21 of the 35 extensions contribute UI. So the host reads no intent, and the allowlist implies enabled.

**Config** gains two optional fields:

```json
"timeZone": "<IANA zone, e.g. Europe/Berlin>",
"extensions": [{"block": "<extension block id>", "file": "<reviewed source, relative to the config>"}]
```

To allowlist an extension or take a new version of one, the operator:
1. reviews the file at a commit, using the rule 3 and rule 4 items;
2. installs that file with `install-extension`, so tabs and host run the same bytes;
3. points the config entry at that file;
4. restarts the host.

`health` reports each entry as one of:
- `running`;
- `update-available`: the live block differs from the reviewed copy, which keeps running. The host also logs it at boot;
- `missing`: no live block with that id;
- `load-error`.

Each entry also carries the extension's current `diagnosticsFacet` snapshots. Matrix already publishes unconfigured, missing-token and retrying states **[read]**.

**`timeZone`** is applied as `TZ` by `launch.ts` before it starts the host, and `health` reports it. A daily note is chosen by local date (`formatIsoDate` uses local-zone getters **[read]**). Without the field, a host in UTC files a message under a different day than the owner's tab would for part of every day. When a tab and the host race to create the same message, the first create to reach the server wins, so the day would be effectively random. The same applies today to the host's `daily-note` verb and anything it files under "today", so this field is worth landing on its own.

## 7. What the host honours

| Facet kind | On the host |
|---|---|
| Data: property and type seeds, editor overrides as data, mutators, processors, queries | Honoured, as part of the one runtime. This closes part of [headless-client.md](headless-client.md) §10's narrower seed set for allowlisted extensions |
| `appEffectsFacet` | Started only for contributions whose source carries an allowlisted block's `block:<id>` prefix. They run only while the gate is open and `writeRefusal()` is null, and stop when either stops holding. This needs one core change: the reconciler takes the effect list it runs instead of reading the facet whole. Static-plugin effects stay off, because the host's static runtime already holds prefs-bootstrap effects from the backlinks and grouped-backlinks data extensions **[read]**. Prefs writes pass a read-only Repo (`UserPrefs` scope **[read]**), so "no effects on a read-only host" is a data guarantee and gets its own test |
| UI: mounts, renderers, gutter items, decorators | In the runtime, read by nothing. No skip, stub or refuse code |
| Actions | `run-action` stays refused. Enabling it is a separate decision |

A read-only host (`writable` false) loads the runtime and starts no effects.

**Environment.**
- *`window` and `document`* stay as the shared shim provides them (`window ??= globalThis`, a minimal `document`), with no jsdom: libraries would take DOM paths and fake support. `window.addEventListener` does not exist there **[measured]**. The one effect-path caller is Matrix's own restart event, which the slice-3 edit removes. Core's `refreshAppRuntime` dispatches on `window`. On the host, only the extension verbs and the `eval` context reach it, and the host refuses all of those; its other callers are app-side plugins the host does not load **[read]**.
- *Device storage.* `window.localStorage` is Node's file-backed store in the state directory, already used for the session **[read]**. A new `pnpm headless storage set <config> <key>` reads one value from stdin, the way `login` prompts, and never echoes it. Like every subcommand it takes the state directory's pidfile, so it cannot run beside the daemon. That is how the Matrix token reaches the host, with nothing Matrix-specific in the host.
- *Per-user prefs.* The host sets `preferencesPage` to the owner's user page, an existing config field. The slice-3 Matrix edit reads its config with `readPluginPref(repo, preferencesRootId(repo, ws), …)` (`src/data/stateBlocks.ts`), which reads without creating anything. So the host follows the owner's homeserver, room and auto-start, and mints no prefs block of its own. A tab's reads are unchanged, because its root is its own page. The edit also makes the effect re-read its config when the prefs block changes, instead of only at start or on its in-tab restart event. Without that, the host ignores a prefs change until it restarts.
- *Toasts* go to sonner's module queue with no `<Toaster/>` to drain them. Matrix toasts once per failure streak, and its diagnostics already carry the same states, so no sink is added **[read]**.

**Two ingesting clients.** A tab and the host polling the same room is the normal path, not an edge case. Every message is a create that collides on its derived id, and the server keeps the first create to arrive **[read]**. This converges on ids, parents (given `timeZone`) and content, with two exceptions:
- *Content* matches only while every client runs the same version. A tab keeps its pinned version until it is re-approved there, and the host keeps its reviewed copy until the operator updates it. So after any change to the extension, content can differ until every client has the new version. Before slice 3, a tab also unwraps links by `window.location`. If slice 3 falls back to replacing the SDK, the replacement must produce the SDK's exact media URL.
- *Order keys* are computed from each client's local view, so a lagging client can interleave display order **[read]**. Accepted: only display order is affected.

The host never resurrects a message the owner deleted: the ingest checks the derived id with `tx.get`, which sees tombstones, and with the gate open the host has the full view **[read]**. A write refused mid-poll throws before `saveNextBatch`, so the cursor holds and the next poll retries **[read]**.

**Rollout.** No mixed-version machinery is added. The host is already in the drain set. An extension that imports a new kernel export means: deploy, update the checkout, restart the host.

## 8. Slices

0. **Pinned URL imports in tabs.** This slice is core, changes tabs, and stands on its own. It closes the gap that an approval does not cover a URL import's bytes for every pinned import; slice 0b closes it for the rest.
   - The pinned-import reader and the freezer.
   - The placeholder plugin, with the `COMPILER_VERSION` bump.
   - `vendored` on the approval record, and blob substitution at load.
   - "Pin imports" in the approve flow, `pin-imports` in the CLI, and the `install-extension` refusal.

   Nothing stops loading ([§9](#9-decisions) D3). An extension with an unpinned URL import keeps running in tabs as today and reports `imports-unpinned` until it is pinned and re-approved on each device. On the owner's replica that is one block, the Matrix extension ([§2](#2-population)).

   **0b. End the transition.** Remove the live-import path, so the transpile plugin refuses unpinned imports and `install-extension` refuses them too. This is due once no installed extension reports `imports-unpinned`, checked with one read-only query over the installed extension blocks, as in §2. It is tracked as its own issue when slice 0 is filed. When it lands, an extension still unpinned stops loading until it is pinned. Its seeds then drop out meanwhile, so writes to its properties are refused or decoded through a preset ([headless-client.md](headless-client.md) §10 "Seeds"), though no stored data changes.
1. **Core seams, with no change in tabs.**
   - The compile-platform setter.
   - The Node evaluator, extracted from `src/test/` to check before importing.
   - The reconciler taking an explicit effect list.
   - One source-normalisation function, shared by install and host.

   The existing loader and effect tests cover the tab path unchanged.
2. **Host loading.**
   - `extensions` and `timeZone` in the config.
   - The async resolve after the first gate open, with the agent context on a `LiveRuntimeHandle`.
   - The read-only approval store built from the config.
   - Effects started only for allowlisted blocks while writable.
   - Pinned imports on the host: the fetch-verify cache, native import, and the `__esModule` wrapper.
   - `headless storage set`.
   - `health.extensions`, and the boot log line for `update-available`.

   It is verified on a local stack with a fixture extension. The gate is mutation-checked one clause at a time, each with its named test:
   - an unlisted block is never evaluated;
   - a listed block whose live source differs runs the reviewed file's code, never the live content, and reports `update-available`;
   - a disallowed or computed specifier is a load error before any import runs;
   - effects do not start on a read-only host;
   - a static plugin's effect does not start.
3. **Matrix on the host.** This slice changes the extension first:
   - pin the SDK import: add `&target=es2024` and run `pin-imports`;
   - page back through `prev_batch` when a timeline comes back `limited`. Today a gap of more than 30 messages since the saved cursor is silently skipped on that client, tabs included. It is filed as a bug of its own, and worth shipping on its own, ahead of this slice;
   - read prefs through `readPluginPref` and re-read them on change;
   - key the token by homeserver;
   - remove `migrateEventNamespace`, a one-time data migration gated only by a device-local flag that a new device lacks. It is a no-op today: 0 rows pending and 1,402 already migrated on the owner's tab replica **[measured]**. Removed, it can never fire from the host. `migrateLegacyConfig`, the other flag-gated one-time step, only sets its flag on a device without the legacy blob;
   - read the app origin from a constant instead of `window.location`.

   Then reinstall the extension, re-approve it in tabs, allowlist it, and set the token. Two costs are still unmeasured, and together they decide whether this fits beside the host under the target's OOM policy:
   - Loading the extension and its `@/` imports cost about 290 MB RSS over a bare vite-node process on a laptop, with the SDK stubbed **[measured]**. The marginal cost over a running host is not measured.
   - Whether the es2024 browser-target SDK bundle runs under Node, and what it costs there, is not verified.

   If either fails, the fallback is to replace the SDK's three calls with about twenty lines of `fetch`. That stays a Matrix-only change; pinned imports remain the general path.

Deferred: synced vendored bytes, multi-module closures and any bundler, externals mapped to the importmap (the peer-dependency case), runtime assets reached through `import.meta.url` (a blob URL breaks `new URL(…, import.meta.url)`; the SDK's only such use is a lazy crypto path Matrix never calls **[read]**), `run-action`, static-plugin effects, per-effect headless flags, `--permission` as a seat belt, an out-of-process runner, a toast sink, and the Readwise effect (slice 2 covers it mechanically once someone allowlists it).

## 9. Decisions

- **D1, decided by the owner (2026-11-27): run the reviewed copy, and log that a review is needed.** This matches a tab's #67 behaviour, and ingest keeps going after the extension changes in the graph. The rejected alternative was to refuse a block whose live source no longer matches. That would mean code the graph no longer holds never starts, at the cost of pausing ingest until an operator acts. The cost accepted is that the host can keep writing an old shape after the extension changed, until its reviewed copy is updated.
- **D2, decided by the owner (2026-11-27): keep CDN imports working, pinned, and resolved the same way in tab and host** ([§5](#pinned-url-imports)). The rejected alternatives were:
  - removing Matrix's one URL import and refusing URL imports outright;
  - moving the host to Deno, whose lockfile pins remote modules. It would take the host off Node, and its PowerSync SDK depends on a native SQLite addon untested under Deno. It would also leave tabs unpinned.
- **D3, decided by the owner (2026-11-27): a transition period.** When slice 0 lands, an unpinned URL import keeps loading live in tabs, with an `imports-unpinned` warning whose action is "Pin imports". The live path is removed in slice 0b, once nothing installed still reports the warning.
  - *Cost accepted:* tabs keep the unpinned behaviour for the transition's length, and the transpile plugin carries a second branch until 0b removes it.
  - *Rejected:* refusing unpinned imports at once. That closes the gap immediately, but an extension stops until someone pins it on every device.
  - *Unaffected:* the host loads pinned imports only, in both phases.

## 10. Still open

| Unverified | Settled in |
|---|---|
| How the contributors processor attributes effect writes, which go through `repo.tx` directly rather than `executeCommand`'s contributor binding | slice 2 |
| A message write that commits locally but is rejected at upload: it goes to the host's rejected-upload quarantine with the rest of its transaction, while the cursor has already moved past it | slice 3 |
| Marginal memory of the loaded extension modules on a running host, the pinned SDK bundle included | slice 3, on the target |
| Whether the es2024 browser-target SDK bundle runs under Node | slice 3 |
| Whether `target=es2024` keeps giving a single self-contained file across esm.sh versions and packages. The freezer checks rather than assumes, so a change is a refusal, never a wrong load | slice 0, then on every pin |
