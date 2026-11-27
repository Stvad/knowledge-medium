# Installed extensions in the headless host

> **Status:** Proposed. Nothing is implemented. One decision is settled and one is open; both are in [§9](#9-decisions). Last verified against code: 2026-11-27.
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
| With an `https:` import | 5 in the graph. In this repo's copies, only the Matrix extension (`https://esm.sh/matrix-js-sdk@38.0.0?bundle`) **[read]** |

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
3. **Imports resolve only to what `index.html`'s importmap maps.** The rule reuses `runnableSpecifier`, so tab and host accept the same specifiers. Specifiers are checked from the AST before anything is imported. Anything else is a load error that names the specifier: `https:`, bare packages, `node:*`, computed `import()`. The host also refuses direct imports of the extension compile and evaluator modules, since they evaluate graph content with no hash check. This is a portability rule, not a sandbox. A pinned source can still use `new Function`, `process.getBuiltinModule`, or code it fetched. The review in rule 4 has to catch "fetches or evaluates code", and also "re-exports a static plugin", since provenance prefixing would start that plugin's effects as the block's own.
4. **Allowlisting a block trusts it with the workspace key, the host's session and the daemon's OS account.** The operator procedure says this in those words, and lists the review items from rule 3.
5. **The reviewed copy comes from a reviewed commit, never from the graph.** Copying the live block into the file would let whoever edited the block choose what the host runs. So `health` and the log say only that the live source differs, and never carry its content or hash. To compare them, the host normalises the file the way `install-extension` does before storing, which trims trailing whitespace, so a raw hash of the file never matches **[measured]**. That normalisation becomes one function, shared by install and host.
6. **A device-stored secret is stored under the destination it may be sent to.** Synced config must not be able to redirect it. For Matrix, the access token is kept per homeserver, so a synced homeserver change finds no token and reports missing-token.

| Attacker | What they get on the host |
|---|---|
| A compromised editor account edits an allowlisted block's source | Nothing. The host keeps running the reviewed copy and reports `update-available` |
| A compromised editor installs a new extension block | Nothing. Its id is not in the config |
| A compromised editor edits the synced config an allowlisted extension reads | Only what the reviewed code does with that config. The secret does not follow a changed destination (rule 6). A changed room makes the host ingest that room, which an editor could write into the graph directly anyway |
| A holder of a bridge token, including a read-write one | Nothing. No verb reaches the allowlist |
| A compromised CDN | Nothing. A pinned source cannot import from it |
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

**URL imports are refused, not pinned.** Node cannot import `https:`. The esm.sh `?bundle` URL is not one file: it is a stub plus dozens of transitive imports, some on semver-range paths, and the response varies by user agent **[measured]**. Pinning it would mean crawling, bundling and hashing a closure that changes between requesters, and a quick bundle attempt failed on missing exports **[measured]**. Matrix uses the SDK for three calls: `createClient`, the `/sync` request and `mxcUrlToHttp` **[read]**. Those are about twenty lines of `fetch`. The proposal is to replace them in the extension ([§9](#9-decisions) D2) and to defer URL-import support until a second extension needs it.

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
- *Content* matches only while every client runs the same version. A tab keeps its pinned version until it is re-approved there, and the host keeps its reviewed copy until the operator updates it. So after any change to the extension, content can differ until every client has the new version. Before slice 3, a tab also unwraps links by `window.location` and builds media URLs through the SDK, so the `fetch` replacement must produce the SDK's exact media URL.
- *Order keys* are computed from each client's local view, so a lagging client can interleave display order **[read]**. Accepted: only display order is affected.

The host never resurrects a message the owner deleted: the ingest checks the derived id with `tx.get`, which sees tombstones, and with the gate open the host has the full view **[read]**. A write refused mid-poll throws before `saveNextBatch`, so the cursor holds and the next poll retries **[read]**.

**Rollout.** No mixed-version machinery is added. The host is already in the drain set. An extension that imports a new kernel export means: deploy, update the checkout, restart the host.

## 8. Slices

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
   - `headless storage set`.
   - `health.extensions`, and the boot log line for `update-available`.

   It is verified on a local stack with a fixture extension. The gate is mutation-checked one clause at a time, each with its named test:
   - an unlisted block is never evaluated;
   - a listed block whose live source differs runs the reviewed file's code, never the live content, and reports `update-available`;
   - a disallowed or computed specifier is a load error before any import runs;
   - effects do not start on a read-only host;
   - a static plugin's effect does not start.
3. **Matrix on the host.** This slice changes the extension first:
   - replace the SDK with `fetch`;
   - page back through `prev_batch` when a timeline comes back `limited`. Today a gap of more than 30 messages since the saved cursor is silently skipped on that client, tabs included (filed as a bug of its own);
   - read prefs through `readPluginPref` and re-read them on change;
   - key the token by homeserver;
   - remove `migrateEventNamespace`, a one-time data migration gated only by a device-local flag that a new device lacks. It is a no-op today: 0 rows pending and 1,402 already migrated on the owner's tab replica **[measured]**. Removed, it can never fire from the host. `migrateLegacyConfig`, the other flag-gated one-time step, only sets its flag on a device without the legacy blob;
   - read the app origin from a constant instead of `window.location`.

   Then reinstall the extension, re-approve it in tabs, allowlist it, and set the token. Loading the extension and its imports cost about 290 MB RSS over a bare vite-node process on a laptop **[measured]**. The marginal cost over a running host is not measured, and it decides whether this fits beside the host under the target's OOM policy.

Deferred: pinned URL imports, `run-action`, static-plugin effects, per-effect headless flags, `--permission` as a seat belt, an out-of-process runner, a toast sink, and the Readwise effect (slice 2 covers it mechanically once someone allowlists it).

## 9. Decisions

- **D1, decided by the owner (2026-11-27): run the reviewed copy, and log that a review is needed.** This matches a tab's #67 behaviour, and ingest keeps going after the extension changes in the graph. The rejected alternative was to refuse a block whose live source no longer matches. That would mean code the graph no longer holds never starts, at the cost of pausing ingest until an operator acts. The cost accepted is that the host can keep writing an old shape after the extension changed, until its reviewed copy is updated.
- **D2. Matrix SDK: replace it with `fetch` in the extension (proposed), or build pinned URL imports.** Replacing it also drops the SDK from tabs. Pinning is a bundler project with no second consumer.

## 10. Still open

| Unverified | Settled in |
|---|---|
| How the contributors processor attributes effect writes, which go through `repo.tx` directly rather than `executeCommand`'s contributor binding | slice 2 |
| A message write that commits locally but is rejected at upload: it goes to the host's rejected-upload quarantine with the rest of its transaction, while the cursor has already moved past it | slice 3 |
| Marginal memory of the loaded extension modules on a running host | slice 3, on the target |
