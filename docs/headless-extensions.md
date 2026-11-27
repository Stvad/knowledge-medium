# Installed extensions in the headless host

> **Status:** Approved by the owner (2026-11-27); not yet implemented. Four decisions are settled by the owner; all are in [§9](#9-decisions). Last verified against code: 2026-11-27.
> Claims are tagged as in [headless-client.md](headless-client.md). **[read]** means seen in the code. **[measured]** means run or queried, and the entry says where. **[reasoned]** means inferred; the slice that would verify it is named.

## 1. Goal

User-installed extensions are the extension blocks stored in the graph. This design lets the headless host (`scripts/headless/`, [headless-client.md](headless-client.md)) run them, so the host is a complete client and not just the data layer. Tab and host share code wherever the platforms allow, and [§8](#8-where-tab-and-host-differ) names every place they differ.

The motivating case is the Matrix chat client extension, whose `/sync` ingest is an app effect (`appEffectsFacet`). Today it runs only while a tab is open; an always-on host should run it instead. The owner chose to make installed extensions work headless in general, rather than move Matrix into a static plugin or write a standalone poller. A headless browser is ruled out on the target host because memory is small and the OOM killer kills browser pages first.

Scope: this design covers loading, trusting and running installed extensions on the host. Making the Matrix ingest itself correct with several writers and across a handoff is the extension's own work, tracked in its issues; [§7](#matrix-ingest) lists what slice 3 needs from it.

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

- **The loader.** `dynamicExtensionsExtension` (`src/extensions/dynamicExtensions.ts`) applies two gates. Gate 1 is the synced enable intent (an overrides map keyed by block id), checked before compiling. Gate 2 is a device-local approval (#67) that pins the approved source, its hash and its compiled output. The loader validates the export, prefixes provenance (`block:<id>`), binds seeds, and reports a pin that differs from the live source as `update-available`. The approval store is injectable through `persistent`, and an in-memory implementation exists (`InMemoryCompiledModuleCache`) **[read]**.
- **The runtime around it is React-bound.** `AppRuntimeProvider.tsx` resolves with the boundary-aware `resolveAppRuntime`, batches the error and approval stores, installs the runtime on the Repo, and drives `EffectReconciler` (`src/extensions/liveRuntime.ts`, itself React-free) **[read]**.
- **The compile pipeline is two steps.** Transpile is Babel to ESM with the automatic JSX runtime (`EXTENSION_BABEL_PRESETS`); instantiate is a blob-URL `import()` through the page importmap. Each has a test-only setter (`compileExtensionModule.ts`) **[read]**.
- **The host can link that ESM natively.** Under vite-node with the headless alias, on Node 26 with `--experimental-vm-modules`, the tab's Babel output of a JSX extension was linked as a `vm.SourceTextModule`. A linker resolved each import through the host's own module graph **[measured]**:
  - `@/` modules and `react` came back as the host's own instances, so facets match;
  - default and namespace imports were correct, and top-level `await` worked;
  - `import.meta` held only `url`, and `require` and `module` were undefined;
  - a missing named import failed at link with a `SyntaxError`, as in a browser;
  - stack frames named `km-extension://<block>.tsx`.
- **Both effect extensions' modules load in the host's process.** This was measured with the https import stubbed and with `document` absent. With the eval shim's partial `document`, a CSS-in-JS dependency reached through `@/context/repo` throws on load **[measured]**.

What is missing, all **[read]** except the one marked:
- The host resolves only `staticDataExtensions` and runs no effects (`scripts/headless/host.ts`).
- The verb table refuses `eval`, the extension verbs and `run-action` (`scripts/headless/commands.ts`).
- The host has no enable intent: `extensions-settings` is not in `staticDataExtensions`, and intent is per user.
- `import('https://…')` fails in Node with `ERR_UNSUPPORTED_ESM_URL_SCHEME` **[measured]**.
- Neither platform pins a URL import: a tab fetches it at every load, so its approval covers the URL but not the bytes.

## 4. Trust

This section decides everything else.

**On the host, an extension is a program run as the daemon's OS user.** In a tab, an approved extension already holds the session, every decrypted row and the use of the workspace key, inside the browser's origin sandbox. On the host it also gets the extractable key (key file, key command, or the string in memory), the OS user's files and processes, unrestricted network access and persistence on the machine. That is why `eval` is refused ([headless-client.md](headless-client.md) §8), and it applies to extension code the same way.

**No in-process mechanism isolates code that needs the Repo** **[reasoned]**. `node:vm` modules and ShadowRealm are not security boundaries; a worker thread shares the process's permissions; Node's `--permission` is process-wide and the host itself needs the key source and state directory; a separate process would need an RPC Repo, a new extension API, and would still read and write the whole graph. The one real lever is the daemon's OS user: a dedicated user with nothing else in its home.

**The boundary: only locally granted bytes execute on the host.**
1. **The grant is the host's config.** The host runs an extension block only if its config names that block id with the path of a reviewed copy of its source. Whoever can write the config or a named file as the daemon's OS user can grant code execution, as they already can by editing the checkout the host runs. That includes any agent session running as that user, and those sessions read graph content. No bridge verb grants, changes or revokes the grant, and no synced value takes part.
2. **The host runs the reviewed copy, never the live block content** ([§9](#9-decisions) D1). The live block must still exist, since the loader walks live extension blocks: deleting it stops it at the next restart, and restoring it runs the reviewed copy again. A grant is revoked by removing its config line. When the live source differs, the host keeps running the reviewed copy, logs that a review is needed and reports `update-available`.
3. **Imports are checked where they are linked.** One rule, owned by one function, decides what compiled code may import:
   - *allowed:* the page importmap's exact keys, `@/` modules from the same file set the production build emits (the `allSrcEntries` glob and its exclusions, so a test or service-worker file is refused on both platforms), and pinned imports ([§5](#pinned-url-imports));
   - *refused:* everything else, including a hand-written `km-vendored:` placeholder and `import.meta` beyond `url`;
   - *host only:* also refuses the extension compile and approval modules and the agent command layer, since they evaluate graph content or run refused verbs.

   A tab applies the rule to the compiled output, so generated imports such as the JSX runtime, or an origin chosen by `@jsxImportSource`, are covered. The host applies it again in its linker, which sees every edge the module actually links, including literal dynamic imports. This is a portability rule, not a sandbox: code can still call `new Function`, `process.getBuiltinModule` or fetch code at runtime.
4. **Allowlisting a block trusts it with the workspace key, the host's session and the daemon's OS account.** The operator procedure says so, and its review items are: fetches or evaluates code; re-exports a static plugin (provenance prefixing would start that plugin's effects as the block's own); reads browser globals the host lacks ([§5](#5-loading)); and "pulls package X at hash H" for each pinned import.
5. **The reviewed copy comes from a reviewed commit, never from the graph.** Copying the live block into the file would let whoever edited it choose what the host runs. So `health` and the log report fixed status strings, never the live content, its hash or its synced name. The host compares the file with the block after the same normalisation `install-extension` applies (it trims trailing whitespace), using one function shared by both.
6. **A device-stored secret is bound to the destinations it may be used for**, so synced config cannot redirect it. For Matrix that is the workspace, the homeserver and the room: the token carries the account's access to every joined room on its server, and a tab's storage is shared across workspaces on one origin. A changed tuple finds no token until someone re-authorises it locally. This applies to tabs too.

| Attacker | What they get on the host |
|---|---|
| A compromised editor edits an allowlisted block's source | Nothing. The reviewed copy keeps running; `health` says `update-available` |
| A compromised editor installs a new extension block, or deletes and restores an allowlisted one | Nothing new. An unlisted id never runs; a restored one runs the reviewed copy |
| A compromised editor edits synced config an allowlisted extension reads | Only what the reviewed code does with it. Secrets do not follow a changed destination (rule 6) |
| A holder of a bridge token, including a read-write one | Nothing. No verb reaches the grant |
| A compromised CDN | Nothing after pin time. Bytes are fetched only when a device approves, and must match the pin |
| The allowlisted source itself is malicious or buggy | Everything the daemon's OS user can reach |

The AGENTS.md rule rating "synced data that runs code in another device's client" as P1 holds: synced data can stop granted code, or restore a block whose code is already granted, but never start ungranted bytes. If the daemon shares an OS user with agent sessions, those agents can already read the key file ([headless-client.md](headless-client.md) §8), so a separate user is hardening, not a precondition; if it runs as the operator's own account, the last row reaches everything that account holds. A tab differs by design: a paired agent with a write-capable token can already install and verify extensions there.

## 5. Loading

**One runtime controller, two hosts.** The resolve-and-reconcile logic now inside `AppRuntimeProvider` becomes a React-free controller in core. The controller:
- resolves `[static extensions, dynamicExtensionsExtension(…)]` with `resolveAppRuntime`;
- publishes the runtime to the Repo and the reporters;
- reconciles effects through a caller-supplied filter.

The tab's provider becomes a thin React wrapper over it, and the host calls the same controller. So toggle boundaries, `enables` subtrees and the publication order are the same code on both.

**When the host evaluates installed code.** Only when it is admitted *and* currently writable: configured `writable`, an editor or owner, and no upload hold. It checks again after preparation and before starting the runtime. A function-shaped export receives the Repo while it resolves, and a preferences write passes a read-only Repo **[read]**, so evaluating extensions on a host that may not write could queue a write that is held or refused. A download-only host therefore loads no installed extensions. Effect eligibility is re-evaluated on every admission or writability change, since a demotion or hold changes writability with no visibility change. The agent context reads the runtime's inventories when a command asks, so served verbs see the extensions' seeds.

**The host's approvals.** At boot the host compiles each reviewed file and fills an `InMemoryCompiledModuleCache` with the resulting record, which it passes as `persistent`. A file that fails to read or compile, and a listed block the loader reports as `needs-approval`, show as `load-error`. Gate 1 gets `overrides` built from the allowlist. The loader itself does not change.

**One compiled module, two instantiators.** Both platforms run the same transpile, so a record's `compiled` text means the same thing everywhere. Instantiation takes the whole record, the compiled text plus its vendored modules:
- *Tab:* today's blob-URL `import()` through the page importmap, with vendored modules as blob URLs.
- *Host:* a `vm.SourceTextModule` per extension block, identified as `km-extension://<block>.tsx`, with `import.meta` set to `{url}`. Its linker applies rule 3, then:
  - resolves an importmap key to the module the importmap names, so `react-dom/server` and its variants pick the same facade as in a tab;
  - resolves an `@/` module through vite-node, wrapped as a `vm.SyntheticModule` over the host's own namespace;
  - resolves a pinned import to a `vm.SourceTextModule` over its verified bytes.

  The launcher adds `--experimental-vm-modules`.

The setters become one platform setter, `setExtensionCompilePlatform({instantiate, allowUnpinnedLive})`. The second option is the D3 transition flag, true only for a tab during the transition. Every extension block gets its own module instances on both platforms, vendored modules included. Compiling the reviewed files at boot costs about 70 ms per extension **[measured]**.

**Globals.** The host provides `window` with its file-backed `localStorage`, and no other browser global: no `document`, `location`, `indexedDB`, `requestIdleCallback` or `requestAnimationFrame`. Dropping the eval shim's partial `document` is what lets the Matrix module load ([§3](#3-what-already-exists)). It is safe because `eval`, the shim's only consumer that needs it, is refused on the host. The host runs with `NODE_ENV=production`, so React matches a production tab. The Tailwind utilities load that the compile path starts on every resolution (`ensureExtensionUtilitiesCss`) moves into the tab's provider, its only consumer; on the host it ran PostCSS for about 0.7 s **[measured]**.

**UI imports are loaded, not avoided.** Matrix's dialog, button and toast modules load in Node **[measured]**. One review covers the whole file, so loading them is no separate trust question. A headless entry module or a per-extension "headless" declaration would split every extension for a population of two.

<a id="pinned-url-imports"></a>**Pinned URL imports, the same in tab and host** ([§9](#9-decisions) D2). Users keep writing CDN imports, and the pin sits on the import in the source:

```ts
import * as sdk from 'https://esm.sh/matrix-js-sdk@38.0.0/es2024/matrix-js-sdk.bundle.mjs'
  with {integrity: 'sha256-…'}
```

The tab's source pin and the host's reviewed file both cover the hash, so there is no lock file, no new property and no synced bytes. Each device fetches each pinned URL once, at approval, and runs byte-identical modules or refuses the approval.

*What esm.sh serves* (fetched and inspected as text, never executed; 2026-11-27) **[measured]**:
- *Without `target=`:* a browser gets a stub plus 136 modules (2.79 MB), some on semver ranges and not immutable, varying by user agent. The Matrix extension's current URL has this form.
- *With `&target=es2024`:* a 107-byte stub forwarding to one 1,164,790-byte module (296 KB gzipped). The target has no imports, is served `immutable`, and is identical across user agents and fetches. This held for the SDK and `date-fns`. A package with a peer dependency still pulls it from a range path.

*The freezer*, shared by the CLI, the tab and the host:
1. Fetch over HTTPS, with no credentials, no redirects, and a size and time limit.
2. Refuse unless the module is self-contained: no imports, re-exports or `import()`, checked from its AST.
3. The integrity value is the SHA-256 of those bytes, which is what subresource integrity means.

A stub or a redirect is refused with a message naming the canonical URL to pin instead. Multi-module closures are refused, not bundled.

*Adding the pin.* `pin-imports <file>` rewrites each CDN import to its canonical self-contained URL and adds the hash. In a tab, the approval prompt offers "Pin imports", which writes the pinned source only if the block still holds the source it showed. Every approval path (Enable, Update, Pin imports) approves exactly the revision it showed, by hash, never a reload by id. Other devices adopt the pinned source through "Update", which fetches there; the host's reviewed file must already be pinned.

*Storage.* The tab's approval record gains an optional `vendored: {integrity → bytes}`. Absent means none, so existing approvals stay valid. A record counts as current only if every pinned import in its source has an entry. The host caches verified bytes under a hex-named file per digest and fetches on a miss, so a cold cache needs network access at boot.

*Compiling.* The import plugin replaces each pinned specifier with a placeholder resolved at instantiation, and bumps `COMPILER_VERSION`. An unpinned `https:` import written in the source is the D3 transition, in this one place:
- during the transition, a tab keeps loading it live and reports `imports-unpinned`;
- slice 0b removes that branch and bumps `COMPILER_VERSION` again, so every existing approval recompiles under the final rule before it runs. That includes an approval on a device that was offline through the transition.

A generated URL import, such as one from `@jsxImportSource`, is refused in both phases.

*What a pin does not give.* It trusts what the CDN served at pin time, and covers only the module's static shape: a bundle that builds an `import()` at runtime is outside it, which the rule 4 review covers. Pinned bytes are not synced, so a device approving after the CDN stops serving them must re-pin or bump the version; syncing them as media blocks waits until that happens.

## 6. Enable state, config and health

**One gate on the host: the allowlist.** Intent is per user and the host is a different account, and "enabled in my tab" does not mean "run on my server". So the host reads no intent; the allowlist implies enabled. Config gains one optional field:

```json
"extensions": [{"block": "<extension block id>", "file": "<reviewed source, relative to the config>"}]
```

To allowlist an extension or take a new version, the operator:
1. reviews the file at a commit, against the rule 4 items;
2. installs that file;
3. points the config entry at it;
4. restarts the host.

**Time zone.** The host chooses daily notes by local date (`formatIsoDate` **[read]**), so the service unit sets `TZ` to the owner's zone; the launcher passes the environment through. `health` reports the effective zone. This applies to the host's existing `daily-note` verb too (#1901).

**Health.** `health.extensions` is one more contributor to the host's existing `hostHealth` composition, beside the upload hold and media. Each entry reports `running`, `update-available`, `missing` or `load-error` as a fixed string, served always. Free text comes only while read admission is open: an extension's `diagnosticsFacet` snapshots and its load-error message. These can carry workspace content or upstream errors, and `health` is served while the gate is closed, after a membership loss included.

## 7. What the host honours

| Facet kind | On the host |
|---|---|
| Data: seeds, editor overrides as data, mutators, processors, queries | Honoured, as part of the one runtime. This narrows [headless-client.md](headless-client.md) §10's missing-seed set for allowlisted extensions |
| `appEffectsFacet` | Only contributions carrying an allowlisted block's provenance, while admitted and writable. This uses the provenance predicate the bridge already parses, moved beside the loader. Static-plugin effects stay off: the static runtime holds prefs-bootstrap effects that would mint prefs for the host account **[read]** |
| UI: mounts, renderers, gutter items, decorators | In the runtime, read by nothing |
| Actions | `run-action` stays refused |

**Device storage.** `pnpm headless storage set <config> <key>` writes one `localStorage` value from stdin, prompting as `login` does and never echoing it. It takes the state directory's pidfile, so it cannot run beside the daemon. Nothing in the host is Matrix-specific.

**Per-user prefs.** The host sets `preferencesPage` to the owner's user page, and the slice-3 Matrix edit reads its config with `readPluginPref(repo, preferencesRootId(repo, ws), …)`. That reads without creating anything, so the host follows the owner's homeserver and room and mints no prefs block of its own. A tab's reads are unchanged.

<a id="matrix-ingest"></a>**What slice 3 needs from the Matrix extension** ([§9](#9-decisions) D4). One device ingests a room by default, and ingest stays correct when several do, as tabs already do today. These are fixes to the extension, tracked in its issues:
- *Several writers converge* (#1905, #1907). Today, writers whose property schemas differ, such as a tab and the host with its narrower seed set, can duplicate a message's child rows. Two writers promoting a brand-new key mint two definitions.
- *Replays and gaps are safe* (#1900). A cursor copy, history paging or a crash before the cursor save all replay events, and a gap longer than 30 messages is skipped today.
- *A handoff loses nothing* (#1908). Ingest moves to the host by handing over the credential, without dropping the gap.
- *The token is bound to its destination* (rule 6). Its config re-reads on change, and its stop path cancels cleanly.
- *Host-safe code.* It drops the device-flagged `migrateEventNamespace` (0 rows pending, 1,402 migrated on the owner's replica **[measured]**), uses no `window.location`, and pins its SDK import.

**Rollout.** No mixed-version machinery. The host is in the drain set: an extension that imports a new kernel export means deploy, update the checkout, restart the host.

## 8. Where tab and host differ

Everything else is the same code on both: the runtime controller and resolver, the loader and its gates, the record shape, the transpile and its import rule, the freezer, the reconciler, every data facet, and the extensions' own source.

| Difference | Why it cannot be shared | Kept small by |
|---|---|---|
| Who grants an approval: a click in the tab, the config on the host | Different trust anchors ([§4](#4-trust)) | One record shape and store interface |
| When a grant takes effect: at once in a tab, at restart on the host | The host has no UI to approve in | Config is read at boot |
| Instantiation: blob URLs, or `vm` modules with a linker | A browser and Node load modules differently | Same compiled text, same import rule, native ESM linking on both. The host links `@/` modules as snapshots (`SyntheticModule`), so a later reassignment of a `let` export is not seen; kernel modules export functions and constants |
| Modules the host refuses beyond the shared rule | The compile, approval and command modules are an escape from the host's verb table | Enforced in the host's linker |
| Overrides: the user's in a tab, the allowlist's on the host | The host reads no per-user intent | A nested toggle on the host takes its default |
| Which effects start: all in a tab, allowlisted and writable on the host | The host runs unattended with an OS-level grant | The same controller, given a filter |
| Extensions on a download-only host: none | Evaluating them can queue writes ([§5](#5-loading)) | Their seeds are missing there, which the missing-seed rule already handles |
| Globals: a browser's, or only `window` with `localStorage` | No DOM in Node | A rule 4 review item |
| Status: the UI, or `health` and the log | No UI on the host | The same reporters |
| Local time: the OS, or the service's `TZ` | A server's zone is arbitrary | The same date code |
| A cold host cache fetches pinned bytes at boot | A tab keeps its bytes in its approval record | One freezer |
| Unpinned URL imports load live in tabs during the transition | D3; temporary | One flag, removed by slice 0b |

A parity test runs one fixture extension through both instantiators. The fixture covers JSX, top-level `await`, a lazy `@/` import, default, named and namespace imports, a missing export, and policy refusals. The test asserts the same export values and the same refusals on both.

## 9. Decisions

- **D1, decided by the owner (2026-11-27): run the reviewed copy and log that a review is needed**, as a tab does under #67.
  - *Rejected:* refusing a block whose live source drifted, which stops ingest until an operator acts.
  - *Cost accepted:* the host can keep writing an old shape until its reviewed copy is updated.
- **D2, decided by the owner (2026-11-27): keep CDN imports, pinned, resolved the same way in tab and host.** Rejected:
  - refusing URL imports outright;
  - moving the host to Deno, whose lockfile pins remote modules but whose PowerSync SDK depends on a native addon untested there, and which leaves tabs unpinned.
- **D3, decided by the owner (2026-11-27): a transition period.** Tabs keep loading unpinned imports live with an `imports-unpinned` warning until slice 0b removes that path and rechecks every approval.
  - *Rejected:* refusing unpinned imports at once.
  - *Unaffected:* the host loads pinned imports only.
- **D4, decided by the owner (2026-11-27): one ingesting device per room by default, and correct with several**, as tabs ingest together today.
  - *Rejected:* relying on one writer alone, where a handoff mistake would corrupt messages instead of merely doing extra work.

## 10. Slices

Each gate clause and each refusal gets a named test, mutation-checked per AGENTS.md.

0. **Pinned URL imports in tabs** (core, changes tabs). It closes the gap that an approval does not cover a URL import's bytes.
   - The shared import rule on compiled output, the freezer, the placeholder plugin, and `vendored` on the record.
   - Revision-bound approvals.
   - "Pin imports" and `pin-imports`, plus the `install-extension` warning.

   Nothing stops loading (D3). One installed extension reports `imports-unpinned` today.

   **0b. End the transition.** Remove the live branch and bump `COMPILER_VERSION`, once a read-only query like §2's shows nothing unpinned is installed. That query shows only that sources migrated, which is why the bump rechecks device approvals. An extension still unpinned then stops loading until pinned, and its seeds drop out meanwhile, though no stored data changes. This gets its own issue when slice 0 is filed.
1. **Core seams, no change in tabs.**
   - The React-free runtime controller, with the tab's provider on top.
   - The platform setter.
   - The provenance predicate.
   - The source-normalisation function.
   - The Tailwind call moved into the provider.
2. **Host loading.**
   - The allowlist.
   - The in-memory approval store filled at boot.
   - The `vm` instantiator, its linker and the vendored cache.
   - The evaluation boundary and effect eligibility.
   - `headless storage set`.
   - `health.extensions`.
   - `window`-only globals and `NODE_ENV=production`.

   It is verified on a local stack with fixture extensions and the parity test.
3. **Matrix on the host.** The extension work in [§7](#matrix-ingest), then reinstall, re-approve in tabs, allowlist it and hand ingest over (#1908).
   - Memory is measured in two steps on the target: the running host with the SDK stubbed, then with the pinned SDK. Loading the extension's `@/` imports alone cost about 290 MB RSS over a bare vite-node process on a laptop **[measured]**.
   - If the SDK's browser build does not run under Node, or costs too much, replace its three calls (`createClient`, the `/sync` request, `mxcUrlToHttp` **[read]**) with `fetch` in the extension.

Deferred:
- synced vendored bytes, multi-module closures and bundling, and peer dependencies mapped to the importmap;
- assets reached through `import.meta.url`;
- `run-action` and static-plugin effects;
- `--permission` as a seat belt, and an out-of-process runner;
- the Readwise effect, until it reads preferences through `preferencesRootId`.

## 11. Still open

| Unverified | Settled in |
|---|---|
| How the contributors processor attributes effect writes, which go through `repo.tx` directly rather than `executeCommand`'s contributor binding | slice 2 |
| The `vm` instantiator with the full host running and real extensions, beyond the probe | slice 2 |
| Whether `NODE_ENV=production` takes effect under vite-node for the host's React | slice 2 |
| Marginal memory of loaded extensions on the running host, the pinned SDK included, and whether that bundle runs under Node | slice 3, on the target |
| Whether `target=es2024` keeps giving one self-contained file across esm.sh versions and packages. The freezer checks rather than assumes, so a change is a refusal, never a wrong load | slice 0, then on every pin |
