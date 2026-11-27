# Installed extensions in the headless host

> **Status:** Proposed. Nothing is implemented, and the open decisions are in [§9](#9-decisions). Last verified against code: 2026-11-27.
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

- **The loader is platform-shaped already.** `dynamicExtensionsExtension` (`src/extensions/dynamicExtensions.ts`) applies two gates. Gate 1 is the synced enable intent. Gate 2 is a device-local approval that pins the approved source hash and its compiled output. It then validates the export, prefixes provenance (`block:<id>`), and binds seeds. Persistence (`persistent`) and the compile cache are injectable. Transpile and instantiate are module-private functions with test setters **[read]**.
- **Effects are React-free.** `EffectReconciler` and `LiveRuntimeHandle` in `src/extensions/liveRuntime.ts` start and stop `appEffectsFacet` contributions by id against a runtime **[read]**.
- **Extension sources evaluate in Node today, in tests.** `src/test/exampleModuleResolver.ts` transpiles with the loader's own presets to CommonJS and runs the result over a `require` built from real module imports **[read]**.
- **Both effect extensions load in the host's process shape.** Under vite-node with `scripts/headless/vite.config.ts` on Node 26, the Matrix and Readwise extensions evaluate to their default export through that Babel→CJS path, with or without the `window`/`document` shim **[measured]** (by the design author, with the `https:` import stubbed). The `appEffectsFacet` they contribute is the same object the host imports, so facet identity holds. Every `@/` module Matrix imports loads without a DOM, including `@/components/ui/*`, sonner-backed toasts, `react` and `react/jsx-runtime` **[measured]**.

What is missing, and **[read]** unless marked:
- No app runtime on the host. It resolves `staticDataExtensions` and runs no effects (`scripts/headless/host.ts`).
- No extension loader on the host. The verb table refuses `eval`, the extension verbs and `run-action` (`scripts/headless/commands.ts`).
- No enable intent on the host: `extensions-settings` is not in `staticDataExtensions`. The [headless-client.md](headless-client.md) §10 sentence about the enable-intent read staying on the host's page describes a read the host never makes; this design replaces it ([§6](#6-enable-state-and-the-allowlist)).
- `import('https://…')` fails in Node with `ERR_UNSUPPORTED_ESM_URL_SCHEME` **[measured]**.
- `window.addEventListener` is undefined under the current shim (`window ??= globalThis`). Matrix's effect calls it at start, and core's `refreshAppRuntime` calls `window.dispatchEvent` **[read]**.

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
1. **A host runs an extension block only if its own config names that block id with the SHA-256 of its source.** The config file is the trust anchor, as it already is for confirming a plaintext workspace. Only someone with a shell as the daemon's user can write it. No bridge verb grants, changes or revokes this (the extension verbs stay refused), and no synced value takes part: not intent, not approval state, not the source.
2. **A block runs only while its live source hashes to the configured value** ([§9](#9-decisions) D1). If a block's source is edited anywhere, the host stops running it and `health` says why.
3. **Imports resolve only to the checkout's own modules**: `@/…`, `react`, `react/jsx-runtime` and `react-dom*`. Anything else is a load error that names the specifier. This includes `https:`, bare packages, `node:*` and computed `import()`. It is a portability rule, not a sandbox, since `process` is a global, and the code says so.
4. **Allowlisting a block trusts it with the workspace key, the host's session and the daemon's OS account.** The operator procedure says this in those words.

| Attacker | What runs on the host |
|---|---|
| A compromised editor account edits an allowlisted block's source | Nothing. The hash stops matching, and the block stops |
| A compromised editor installs a new extension block | Nothing. Its id is not in the config |
| A holder of a bridge token, including a read-write one | Nothing. No verb reaches the allowlist |
| A compromised CDN | Nothing. URL imports do not load |
| The allowlisted source itself is malicious or buggy | Everything the daemon's OS user can reach |

The AGENTS.md review rule that rates "synced data that runs code in another device's client" as P1 holds: synced data can only stop code on the host, never start it. The last row is the cost of the feature, and the operator signs for it per block with a hash. On a machine where the daemon shares an OS user with agent sessions, those agents can already read the key file ([headless-client.md](headless-client.md) §8). An allowlisted extension then reaches what those agents already reach. A separate OS user is hardening, not a precondition.

## 5. Loading

**Shape.** The host resolves `[staticDataExtensions, dynamicExtensionsExtension({…})]` into one runtime and installs it with `repo.setFacetRuntime`, as a tab does. It does this once, after the gate first opens, because the extension-block query needs a complete view. The loader options are:
- `overrides`: built from the allowlist (every listed id enabled), so gate 1 skips unlisted blocks before compiling them, as it already does;
- gate 2: a hash check against the config instead of a device-local approval record.

The second option adds one small seam to the loader: an injected "may this block run, and which source" decision that defaults to today's approval lookup. The host passes the hash check. The tab path does not change.

**Compiling under Node.** The compile pipeline is now two module-private functions with `__set…ForTest` setters. It becomes one injected platform `{transpile, instantiate}`.
- The browser platform is today's code: Babel to ESM, then a blob-URL `import()` through the page importmap.
- The Node platform is Babel to CommonJS with the same `EXTENSION_BABEL_PRESETS`, evaluated over a `require` map. The map is built by parsing the module's specifiers (`importedSpecifiers`, already AST-based), enforcing rule 3, and importing each `@/x.js` as `@/x` through vite-node. That gives the same module instances the host runs, and the specifiers are the exact-filename forms the importmap accepts.

The evaluator moves out of `src/test/exampleModuleResolver.ts` into one core owner that the tests and the host both import. The host compiles the live source on each boot, about 70 ms per extension **[measured]**. It keeps no compiled-output store, because with D1's stop-on-drift there is never a pin to run.

**UI imports are loaded, not avoided.** The Matrix extension imports its dialog, buttons and toast modules, which load in Node with no DOM **[measured]**. Loading them is not a separate trust question, since the whole file is allowlisted by one hash. A headless entry module or a per-extension "headless" declaration would split every extension for a population of two, so it is rejected unless memory forces it ([§8](#8-slices)).

**URL imports are refused, not pinned.** Node cannot import `https:`. The esm.sh `?bundle` URL is not one file: it is a stub plus dozens of transitive imports, some on semver-range paths, and the response varies by user agent **[measured]**. Pinning it would mean crawling, bundling and hashing a closure that changes between requesters, and a quick bundle attempt failed on missing exports **[measured]**. Matrix uses the SDK for three calls: `createClient`, the `/sync` request and `mxcUrlToHttp` **[read]**. Those are about twenty lines of `fetch`. The proposal is to replace them in the extension ([§9](#9-decisions) D2) and to defer URL-import support until a second extension needs it.

## 6. Enable state and the allowlist

**The host has one gate: the allowlist.** Enable intent is per user, stored in the user's own plugin prefs block (`getPluginPrefsBlock(…, repo.user, …)` **[read]**), and the host signs in as a different account. "Enabled in my tab" also does not mean "run on my server": 21 of the 35 extensions are UI. So the host reads no intent, and the allowlist implies enabled.

**Config** gains one optional field:

```json
"extensions": [{"block": "<extension block id>", "sha256": "<hex of its source>"}]
```

To allowlist an extension, take the reviewed file (for example the checked-in copy that `install-extension` stored). Hash it with `shasum -a 256 <file>`, add the line, and restart the host. Equal hashes mean identical bytes, so reviewing the file is reviewing the block. When the source changes, the same three steps follow its reinstall. A config entry whose block is missing, deleted, or hashes differently is reported in `health` and does not run.

**Drift while running.** The host watches each allowlisted block. When the live source stops matching, or the block is deleted, the host stops that block's effects at once. It keeps the block's data contributions until the next restart, because seeds already registered describe stored data and dropping them mid-run would only refuse writes.

## 7. What the host honours

| Facet kind | On the host |
|---|---|
| Data: property and type seeds, editor overrides as data, mutators, processors, queries | Honoured, as part of the one runtime. This closes part of [headless-client.md](headless-client.md) §10's narrower seed set for allowlisted extensions |
| `appEffectsFacet` | Started only for contributions whose source is an allowlisted block (the loader's `block:<id>` prefix), only while the gate is open and `writeRefusal()` is null, and stopped when either stops holding. This needs a small core change: the reconciler takes the effect list it runs instead of reading the facet whole. Static-plugin effects stay off, because the host's static runtime already holds prefs-bootstrap effects from the backlinks and grouped-backlinks data extensions that would mint prefs blocks for the host account **[read]** |
| UI: mounts, renderers, gutter items, decorators | In the runtime, read by nothing. No skip, stub or refuse code |
| Actions | `run-action` stays refused. Enabling it is a separate decision |
| Diagnostics (`diagnosticsFacet`) | Reported through `health` (below) |

A read-only host (`writable` false) loads the runtime and starts no effects.

**Environment.**
- *`window`.* The shared Node shim makes `window` an `EventTarget` by binding `addEventListener`, `removeEventListener` and `dispatchEvent` onto `globalThis`. `document` stays the minimal stub, with no jsdom: libraries would take DOM paths and fake support.
- *Device storage.* `window.localStorage` is Node's file-backed store in the state directory, already used for the session **[read]**. A new `headless storage set|unset|keys <config> <key>` subcommand sets one entry. It reads the value from stdin, never echoes it, and refuses while the daemon holds the lock. That is how the Matrix access token reaches the host, with nothing Matrix-specific in the host.
- *Per-user prefs.* The host account gets its own Matrix prefs block (homeserver, room, auto-start) the first time the effect starts on a writable host. It is configured by editing that block from any tab. That creates the host account's user page and prefs subtree, which narrows [headless-client.md](headless-client.md) §8's "the host creates none" to "none except an allowlisted extension's own prefs". [§9](#9-decisions) D3 asks whether to accept that.
- *Toasts.* `@/utils/toast` gains a sink override held in a leaf module, the pattern `auth.storage` uses. The host's sink logs each toast and keeps the last few for `health`. Without it, sonner queues toasts with no `<Toaster/>` to drain them **[reasoned]**.
- *`health.extensions`.* One entry per allowlisted block, `{block, state, configuredHash, liveHash}`. `state` is one of `running`, `source-changed`, `missing`, `load-error` or `effect-error`, plus the current `diagnosticsFacet` snapshots. Matrix already publishes unconfigured, missing-token and retrying states **[read]**.

**Rollout.** No mixed-version machinery is added. The host is already in the drain set. An extension that imports a new kernel export means: deploy, update the checkout, restart the host. A tab and the host ingesting the same room at once is the designed case, because derived ids converge.

## 8. Slices

1. **Core seams, with no change in tabs.**
   - The injected compile platform.
   - The Node evaluator extracted from `src/test/`.
   - The loader's run-decision seam.
   - The reconciler taking an explicit effect list.
   - The toast sink.
   - The `window` EventTarget shim.

   Existing loader and effect tests cover the tab path unchanged.
2. **Host loading.**
   - The config field.
   - The hash gate.
   - The drift watch.
   - Load after the first gate open; effects only while writable.
   - `headless storage`.
   - `health.extensions`.

   It is verified on a local stack with a fixture extension. The gate is mutation-checked one clause at a time, each with its named test:
   - an unlisted block is never evaluated;
   - a listed block with a different hash is never evaluated;
   - a drift mid-run stops its effect;
   - a disallowed specifier is a load error;
   - effects do not start on a read-only host.
3. **Matrix on the host.** This slice changes the extension first:
   - replace the SDK with `fetch`;
   - remove `migrateEventNamespace`, a one-time data migration gated only by a device-local flag that a new device lacks. It is a no-op today: 0 rows pending and 1,402 already migrated on the owner's tab replica **[measured]**. Removed, it can never fire from the host;
   - read the app origin from a constant instead of `window.location`, so tab and host write identical content for a given event.

   Then reinstall the extension, allowlist it, set the token and the prefs, and measure on the target host. Loading the extension and its imports cost about 290 MB RSS over a bare vite-node process **[measured]** on a laptop. The marginal cost over a running host is not measured, and it decides whether this fits beside the host under the target's OOM policy.

Deferred: pinned URL imports, `run-action`, static-plugin effects, per-effect headless flags, `--permission` as a seat belt, an out-of-process runner, the Readwise effect (slice 2 covers it mechanically once someone allowlists it).

## 9. Decisions

- **D1. Drift: stop (proposed) or keep running the pinned version.**
  - *Stop* means no compiled-output store and no approval command, and code the graph no longer has never writes. Ingest pauses on the host until the operator updates the hash; open tabs keep ingesting meanwhile.
  - *Keep running* matches the tab's #67 behaviour and keeps ingest going. It needs a file-backed approval store, an approve subcommand and compiler-version re-pinning, and it can keep writing an old shape after the extension changed.
- **D2. Matrix SDK: replace with `fetch` in the extension (proposed) or build pinned URL imports.** Replacing it also drops the SDK from tabs. Pinning is a bundler project with no second consumer.
- **D3. Host-owned prefs: accept that the host account gets its own user page and Matrix prefs block (proposed),** configured from a tab. The alternative is to make the extension read its prefs through `preferencesRootId`, so a host with `preferencesPage` set reads the owner's prefs. That is an extension change, and it applies to any per-user prefs an extension reads.

## 10. Still open

| Unverified | Settled in |
|---|---|
| How the contributors processor attributes effect writes, which go through `repo.tx` directly rather than `executeCommand`'s contributor binding | slice 2 |
| Whether a write refused mid-poll (a demotion, an upload hold) still advances Matrix's `/sync` cursor on that device. If it does, the host silently skips those messages, though a tab ingesting the room still writes them | slice 3 |
| Marginal memory of the loaded extension modules on a running host | slice 3, on the target |
