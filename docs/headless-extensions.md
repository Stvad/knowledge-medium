# Installed extensions in the headless host

> **Status:** Proposed. Nothing is implemented. Three decisions are settled by the owner and one is proposed; all are in [§9](#9-decisions). Last verified against code: 2026-11-27.
> Claims are tagged as in [headless-client.md](headless-client.md). **[read]** means seen in the code. **[measured]** means run or queried, and the entry says where. **[reasoned]** means inferred; the slice that would verify it is named.

## 1. Goal

User-installed extensions are the extension blocks stored in the graph. This design lets the headless host (`scripts/headless/`, [headless-client.md](headless-client.md)) run them, so the host is a complete client and not just the data layer. It aims to keep a tab and the host on the same code wherever the platforms allow, and names every place they differ ([§8](#8-where-tab-and-host-differ)).

The motivating case is the Matrix chat client extension. Its `/sync` ingest is an app effect, `appEffectsFacet`. It writes each message under block ids derived from the Matrix event id (`pluginBlockId`). Today the ingest runs only while a tab is open. An always-on host should run it instead. The owner chose to make installed extensions work headless in general, rather than move Matrix into a static plugin or write a standalone poller. A headless browser is ruled out on the target host because memory is small and the OOM killer kills browser pages first.

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

- **The loader has the seams this needs.** `dynamicExtensionsExtension` (`src/extensions/dynamicExtensions.ts`) applies two gates. Gate 1 is the synced enable intent (an overrides map keyed by block id), checked before compiling. Gate 2 is a device-local approval that pins the approved source hash and its compiled output. The loader then validates the export, prefixes provenance (`block:<id>`), and binds seeds. The approval store is injectable through its `persistent` option, and the loader reports a pin that differs from the live source as `update-available`. Its `verifyLiveSource` option skips gate 2 and compiles the live `block.content` (used only by the install path) **[read]**.
- **The tab resolves with toggle boundaries.** `resolveAppRuntime` (`src/facets/resolveAppRuntime.ts`) honours toggle boundaries and `enables` subtrees, and the loader preserves those boundaries for it. The bare `resolveFacetRuntime` does not **[read]**.
- **The compile pipeline is two steps.** `compileExtensionModule.ts` splits transpile (Babel, ESM output with the automatic JSX runtime) from instantiate (blob-URL `import()` through the page importmap). Each is a module-private function with a `__set…ForTest` setter, beside a full source→module override for tests **[read]**.
- **Effects are React-free.** `EffectReconciler` and `LiveRuntimeHandle` (`src/extensions/liveRuntime.ts`) start and stop `appEffectsFacet` contributions by id **[read]**.
- **The host can run the tab's compiled ESM unchanged.** A plugin in the vite-node config resolved a runtime-registered virtual module holding extension ESM text, the same text a tab imports from a blob URL. Under vite-node on Node 26 **[measured]**:
  - its `@/x.js` imports resolved to the host's own module instances: `appEffectsFacet` and a data-layer function were identical objects, so facets match;
  - default and namespace imports were correct with no interop wrapper;
  - top-level `await` and `import.meta` worked;
  - a dependency the plugin resolved to a `data:` URL loaded natively, untransformed.
- **Both effect extensions load in the host's process shape.** The Matrix and Readwise extensions evaluate to their default export under vite-node with the headless config, and every `@/` module Matrix imports loads without a DOM, including `@/components/ui/*`, sonner-backed toasts and `react` **[measured]**. That establishes that their modules load, not that their effects run correctly on a host: Readwise's effect reads and creates the acting account's own preferences **[read]**.

What is missing, all **[read]** except the one marked:
- The host resolves only `staticDataExtensions`, through `resolveFacetRuntimeSync`, and runs no effects (`scripts/headless/host.ts`). It builds its agent context on that runtime before the gate opens.
- The verb table refuses `eval`, the extension verbs and `run-action` (`scripts/headless/commands.ts`).
- There is no enable intent on the host: `extensions-settings` is not in `staticDataExtensions`, and intent is per user, kept in the user's own extensions prefs block.
- `import('https://…')` fails in Node with `ERR_UNSUPPORTED_ESM_URL_SCHEME` **[measured]**.
- Neither platform pins a URL import. A tab resolves one over the network each time the extension loads, so the approval covers the import's URL but not the bytes it serves. The host cannot load one at all.

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

**The boundary: only locally granted bytes execute on the host.**
1. **A host runs an extension block only if its own config names that block id with the path of a reviewed copy of its source.** The config file and the files it names are the trust anchor. The config already stands in for a person's confirmation of a plaintext workspace, though there it sits alongside the server row and here it stands alone. Whoever can write the config or a named file as the daemon's OS user can grant code execution, as they already can by editing the checkout the host runs. That includes any agent session running as that user, and those sessions read graph content. No bridge verb grants, changes or revokes the grant (the extension verbs stay refused), and no synced value takes part: not intent, not approval state, not the source.
2. **The host runs the reviewed copy, never the live block content** ([§9](#9-decisions) D1, decided). This is the tab's #67 rule with the reviewed file as the pin. The live block still has to exist, since the loader walks live extension blocks:
   - deleting the block in the graph stops it at the next restart;
   - restoring it starts the reviewed copy again.

   The grant is the config line, so revoking it permanently means removing that line. When the live source differs from the reviewed copy, the host keeps running the reviewed copy. It logs that a review is needed and reports `update-available` in `health`.
3. **What compiled code may import is checked on the compiled output, after every transform.** The check runs inside the shared transpile step, on fresh approvals, install verification and recompiles alike. It reads the emitted module's static imports, re-exports and literal `import()` calls. That output includes imports the source never wrote: the automatic JSX runtime import, and any origin a `@jsxImportSource` comment selects for it.
   - *Allowed:* what `index.html`'s importmap maps (the rule `runnableSpecifier` already encodes, so tab and host accept the same set), and pinned-import placeholders ([§5](#pinned-url-imports)).
   - *A load error naming the specifier:* everything else, including an unpinned `https:` import, a bare package, `node:*` and a computed `import()`.
   - *The one exception:* during the transition ([§9](#9-decisions) D3), a tab still loads an unpinned `https:` import live, as today, with a warning. The host never does.
   - *Also refused on the host:* direct imports of the extension compile and loader modules, since they evaluate graph content with no hash check.

   This is a portability rule, not a sandbox. Code can still use `new Function`, `process.getBuiltinModule`, or code it fetches at runtime. The rule 4 review has to catch "fetches or evaluates code" and "re-exports a static plugin", since provenance prefixing would start that plugin's effects as the block's own.
4. **Allowlisting a block trusts it with the workspace key, the host's session and the daemon's OS account.** The operator procedure says this in those words, and lists the review items from rule 3 and [§5](#pinned-url-imports).
5. **The reviewed copy comes from a reviewed commit, never from the graph.** Copying the live block into the file would let whoever edited the block choose what the host runs. So `health` and the log say only that the live source differs, and never carry its content or hash. To compare them, the host normalises the file the way `install-extension` does before storing (it trims trailing whitespace), with one function shared by install and host.
6. **A device-stored secret is bound to the destinations it may be used for.** Synced config must not be able to redirect it. For Matrix that destination is the homeserver *and* the room. A Matrix token carries the account's access to every room it has joined on that server, so binding it to the homeserver alone would let a synced room change ingest a room the editor cannot otherwise read. The token is stored under its (homeserver, room) pair, so changing either in synced prefs finds no token and reports missing-token until someone re-authorises it locally. This applies to tabs too.

| Attacker | What they get on the host |
|---|---|
| A compromised editor account edits an allowlisted block's source | Nothing. The host keeps running the reviewed copy and reports `update-available` |
| A compromised editor installs a new extension block | Nothing. Its id is not in the config |
| A compromised editor deletes, then restores, an allowlisted block | Only the reviewed copy again, which the operator already granted |
| A compromised editor edits the synced config an allowlisted extension reads | Only what the reviewed code does with that config. The secret does not follow a changed destination (rule 6) |
| A holder of a bridge token, including a read-write one | Nothing. No verb reaches the allowlist |
| A compromised CDN | Nothing after pin time. A device fetches a pinned import only when it approves, and refuses bytes that do not hash to the pin. Bytes served at pin time are trusted as pinned, and code a pinned bundle loads at runtime is outside the pin (rule 4) |
| The allowlisted source itself is malicious or buggy | Everything the daemon's OS user can reach |

The AGENTS.md review rule that rates "synced data that runs code in another device's client" as P1 holds: synced data can stop granted code, or restore a block whose code is already granted, but can never start bytes the host has not been granted. The last row is the cost of the feature, and the operator signs for it per block by naming a reviewed file. If the daemon shares an OS user with agent sessions, those agents can already read the key file ([headless-client.md](headless-client.md) §8), so a separate user is hardening, not a precondition. If the daemon runs as the operator's own account, the last row reaches everything that account holds, and the procedure must say so.

A tab is different by design: there, a paired agent with a write-capable bridge token can already install and verify extensions, which evaluates candidate source before any pin exists. That authority is the tab's and is not extended to the host.

## 5. Loading

**Runtime.** A writable host, after the gate first opens, resolves `[staticDataExtensions, dynamicExtensionsExtension({…})]` with `resolveAppRuntime`. It passes overrides derived from its allowlist, the same boundary-aware resolver a tab uses, so toggle boundaries and `enables` subtrees behave identically. It waits for the gate because the extension-block query needs a complete view.

A read-only host loads no installed extensions at all. A function-shaped export receives the Repo while resolving, before any effect filter applies, and a preferences write passes a read-only Repo (`UserPrefs` scope **[read]**). Evaluating installed code there could therefore queue a write that the next read-only boot refuses.

The agent context reads the runtime's inventories (actions, renderers, facet listings) when a command asks, not once at boot, so served verbs see the extensions' seeds.

**The gate uses the loader's existing seams, with no change to the loader's gates.**
- *Gate 1* gets `overrides` built from the allowlist, so unlisted blocks are skipped before compiling, as they are today.
- *Gate 2* gets the host's approval store through the loader's existing `persistent` option. It is a read-only `CompiledModuleCache` built from the config: `read(blockId)` returns a record holding the normalised reviewed file as `approvedSource`, with its hash, its compiled output and its vendored modules. For an unlisted id it returns nothing. It never throws, because a thrown read reads as an unreadable approval; it reports a file or compile failure itself, as a `load-error` in `health`. `write` and `delete` are no-ops, since the records are always current here, so the load path's compiler-bump re-pin never runs **[read]**.
- *The rest is existing code.* The loader runs the pinned output and reports `update-available` through `approvalStatusReporter` when the live hash differs **[read]**. The host logs that report and shows it in `health`.

**One compiled module, two instantiators.** Both platforms run the same transpile: Babel to ESM with `EXTENSION_BABEL_PRESETS` and the shared import plugin. So a given source compiles to the same string on both, and a record's `compiled` field means the same thing everywhere. Only instantiation is per platform, and it takes the whole approval record, the compiled text plus its vendored modules:
- *Tab:* today's blob-URL `import()` through the page importmap, with vendored modules as blob URLs.
- *Host:* a plugin in `scripts/headless/vite.config.ts` serves each compiled extension as a virtual module, `km-ext:<block>@<hash>`, from an in-process registry the host fills, and the host `import()`s that id. Its `@/…` imports resolve through Vite to the host's own module instances, and vendored placeholders resolve to `data:` URLs that vite-node leaves native. Each of these was measured with a probe extension ([§3](#3-what-already-exists)).

The transpile and instantiate setters become one platform setter, `setExtensionCompilePlatform({instantiate})`, and the full-compile override stays test-only. Nothing evaluates extensions as CommonJS on either platform, so top-level `await`, `import.meta`, default-import interop, live bindings and lazy `import()` behave the same in both. Compiling the reviewed file on each boot costs about 70 ms per extension **[measured]**, so the host persists no compiled output.

Each extension block gets its own module instance on both platforms, including its own instance of any vendored module it imports: a tab makes a blob URL per block, and the host makes a distinct `data:` URL per block. Two blocks importing the same digest therefore never share module state, in either platform.

**UI imports are loaded, not avoided.** The Matrix extension imports its dialog, buttons and toast modules, which load in Node with no DOM **[measured]**. Loading them is not a separate trust question, since one review covers the whole file. A headless entry module or a per-extension "headless" declaration would split every extension for a population of two, so it is rejected unless memory forces it ([§10](#10-slices)).

<a id="pinned-url-imports"></a>**Pinned URL imports, the same in tab and host** ([§9](#9-decisions) D2, decided). Users keep writing CDN imports. The pin goes into the source, on the import itself:

```ts
import * as sdk from 'https://esm.sh/matrix-js-sdk@38.0.0?bundle&target=es2024'
  with {integrity: 'sha256-…'}
```

Because the hash is source text, the tab's existing source pin (#67) and the host's reviewed file both cover it. That needs no lock file, no new property and no synced bytes. Each device fetches each pinned URL once, when it approves the extension, and nothing is fetched at load. Tab and host therefore run byte-identical modules, or the approval is refused.

*What esm.sh serves* (fetched and inspected as text, never executed; 2026-11-27) **[measured]**:
- *Without `target=`:* the response depends on the user agent. A browser gets a stub plus 136 modules (2.79 MB), 52 of them on semver-range paths and 56 not immutable, with `Vary: User-Agent`. A Node agent gets a different build that imports `node:` builtins. The Matrix extension's current URL is this form, so pinning it starts with adding `target=`.
- *With `&target=es2024`:* esm.sh serves a 107-byte stub that re-exports one 1,164,790-byte module. That module has no static or dynamic imports, is served `immutable`, and is identical across user agents and repeated fetches. It is 296 KB gzipped.
- *Not separate modes:* `?standalone`, `?bundle=all` and `?bundle-deps` return the same bytes as `?bundle`.
- *Treated as observed, not as a contract:* `target=es2024` giving one file held for this SDK and for `date-fns`. A package with a peer dependency still pulls it from a range path; `react-markdown` pulls a second React that way.

*The freezer* is one function, shared by the CLI, the tab and the host:
1. *Fetch safely.* HTTPS only, no credentials, a byte limit and a time limit. Redirects and the stub's forwarding hop may only go to HTTPS URLs on the origin of the URL being pinned. When the expected digest is already known (a re-approval or a host cache refill), check it before any further analysis.
2. *Stubs.* If the body is only `export * from "<one URL>"`, optionally plus `export {default} from` the same URL, fetch that target too. The stub is kept as a module of its own, with its one specifier rewritten to the target's placeholder, so the namespace an import sees is exactly the stub's. A bare `export *` does not re-export a default, and flattening to the target would add one. Any other stub shape is refused.
3. *Self-contained.* Refuse unless the target module has no import or export-from statements and no `import()`, checked from the AST. The error names the count and, when the response varied by user agent, suggests pinning `target=`, since a browser cannot set its user agent and such a URL could never freeze identically in a tab and in Node.
4. *Integrity.* The value is the SHA-256 over the stub text and the target bytes together. This is not what the web's subresource-integrity attribute means.

Multi-module closures are refused, not bundled. A tab has no bundler, and a raw closure would need its specifiers rewritten at load, where blob URLs cannot express cycles **[reasoned]**.

*Adding the pin.*
- *CLI:* a new `pin-imports <file>` verb runs the freezer and writes the attributes into the file. `install-extension` warns about a URL import with no integrity value during the transition, and refuses one after it.
- *In a tab:* the approval prompt offers "Pin imports" for an unpinned source. The action is bound to the exact source the prompt showed, by hash. When the running approval already differs from that source, it asks for an explicit update first.
  - It freezes once and splices the attributes in at each import's AST offsets, never regenerating the code, since the source is user data.
  - In the write transaction it re-reads the block. It writes the pinned source only if the content still equals what was shown, so a concurrent edit is never overwritten, and a failed comparison leaves the old approval in place.
  - It then approves exactly the bytes it wrote, with the modules it verified, and never reloads by id.
  - If the device approval cannot be stored after the graph write commits, it reports that re-approval is still needed and keeps the old pin.
- *Other devices* see `update-available` and keep their old pin until they approve the new source with "Update", which fetches there.
- *The host* never writes a source; its reviewed file must already be pinned.

*Install verification* (`compileForVerification`, the loader's verify mode) instantiates live source with no record, so it runs the freezer in memory for each pinned import.

*Compiling.* The shared import plugin replaces each pinned specifier with `km-vendored:<integrity>` and drops the attribute, so the compiled string contains no URL. Babel 8 standalone parses the attribute under the loader's presets, and TypeScript 6 accepts it with the existing `https://*` module declaration **[measured]**. The plugin changes compiled output, so `COMPILER_VERSION` is bumped. An unpinned `https:` import is where the transition lives, in this one place:
- *During the transition,* a tab keeps it as a live import, as today. The loader reports `imports-unpinned`, which surfaces like `update-available`, in the settings row and the approval prompt, with "Pin imports" as its action.
- *Ending the transition (slice 0b)* bumps `COMPILER_VERSION` again. Every existing approval then recompiles from its approved source under the final rule before it can run. A slice-0 approval that still carries a live import fails closed there, even on a device that was offline or held a disabled extension through the transition.
- *The host* refuses an unpinned import in both phases, since Node cannot load it.

*The approval record (tab).* `CompiledRecord` gains an optional `vendored: {integrity → modules}`, written only by `approveExtension` after the freezer verifies it.
- *Old records:* absent means none, so `isApprovalRecord` keeps accepting every existing approval.
- *Compiler bumps:* the load-path re-pin copies the record (`{...approval, …}`), so `vendored` survives and nothing is re-fetched **[read]**.
- *Idempotency:* `approveExtension` treats a record as current only if its source hash and compiler version match **and** every pinned import in the source has a `vendored` entry. Without the third clause, a record re-pinned without its bytes during a version window would make "Update" a permanent no-op.
- *Lifetime:* the record is deleted on uninstall through the agent verb. Disabling keeps the pin by design (`ExtensionsOverridesEditor`), and so does deleting the block in the outliner **[read]**. So about 1 MB of vendored text per pinned import stays in the device's IndexedDB until then. That is accepted: it is bounded, and re-enabling needs no fetch.

*The host cache.* Verified modules are cached at `<state>/vendored/<integrity>/`. At boot the host reads the cache once and checks the digest. On a miss or mismatch it fetches, verifies and rewrites it; a bad fetch is a `load-error`, and the procedure documents that a cold cache means network access at boot. It then serves those same in-memory bytes as `data:` URLs. A `file://` import would not do: vite-node passes a `.mjs` outside `node_modules` through Vite's SSR transform, so the host would run transformed code, not the bytes it hashed **[measured]**. Importing from memory also leaves no gap between the hash check and the load.

*Testing identity.* A local test server serves a fixture "CDN" stub and target: named and default exports, top-level await, and a read of `import.meta` whose accessibility only is asserted, since its `url` is `blob:` in a tab and `data:` on the host. A fixture extension imports it three ways, namespace, default and named, has its own top-level `await`, imports a `@/` module lazily, and uses JSX. Both platforms run the same assertions: the host in vitest, the tab in headless Playwright.
- *Shared output:* the compiled string is asserted byte-identical across the two.
- *Untransformed on the host:* the host test asserts the vendored module was not transformed.
- *Policy:* a `@jsxImportSource` fixture pointing at a URL must be refused before any request.
- *Mutation checks:* each of these deletions must fail a named test: the hash comparison, the self-contained check, the stub-surface preservation, the post-transform import check, and the per-block instance rule.

*What a pin does not give.* Pinning trusts whatever the CDN served at pin time. It covers only the module's static shape. A bundle that builds an `import()` at runtime (`new Function('u', 'return import(u)')`) passes the AST check, then fetches live in a tab and fails on the host. That is code the pinned bundle chose to load, outside the pin, and the rule 4 review item "fetches or evaluates code" is what catches it. A 1 MB minified bundle is not reviewable by reading, so "pulls package X at hash H" joins the rule 4 review items; the hash guarantees only that every device runs the same bytes.

Pinned imports are not synced. A device approving after the CDN stops serving those bytes cannot approve until the import is re-pinned or its version bumped, which is a visible source change. Syncing the bytes as media blocks is deferred until that happens; they would be transport, not trust, since the pin in the source is still what a device checks.

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

These states are host-owned and always served. The extension's own `diagnosticsFacet` snapshots are added only while read admission is open. A diagnostic is extension code plus free text that can carry workspace content or upstream errors, and `health` is served while the gate is closed, after a membership loss included. So the host neither calls nor returns diagnostics then, and drops any it collected when admission closes.

**`timeZone`** is applied as `TZ` by `launch.ts` before it starts the host, and `health` reports it. A daily note is chosen by local date (`formatIsoDate` uses local-zone getters **[read]**). Without the field, a host in UTC files under a different day than the owner would expect for part of every day. The same applies today to the host's `daily-note` verb and anything it files under "today", so this field is worth landing on its own.

## 7. What the host honours

| Facet kind | On the host |
|---|---|
| Data: property and type seeds, editor overrides as data, mutators, processors, queries | Honoured, as part of the one runtime. This closes part of [headless-client.md](headless-client.md) §10's narrower seed set for allowlisted extensions |
| `appEffectsFacet` | Started only for contributions whose source carries an allowlisted block's provenance prefix. It reuses the predicate that already parses those sources for the bridge, moved beside the code that writes them. They run only while the gate is open and `writeRefusal()` is null. Eligibility is re-evaluated on every admission or writability change, since a demotion or an upload hold changes writability with no visibility change. This needs one core change: the reconciler takes the effect list it runs instead of reading the facet whole. Static-plugin effects stay off, because the host's static runtime already holds prefs-bootstrap effects from the backlinks and grouped-backlinks data extensions **[read]** |
| UI: mounts, renderers, gutter items, decorators | In the runtime, read by nothing. No skip, stub or refuse code |
| Actions | `run-action` stays refused. Enabling it is a separate decision |

**Environment.**
- *`window` and `document`* stay as the shared shim provides them (`window ??= globalThis`, a minimal `document`), with no jsdom: libraries would take DOM paths and fake support. `window.addEventListener` does not exist there **[measured]**. The one effect-path caller is Matrix's own restart event, which the slice-3 edit replaces with a module-local `EventTarget`. It still needs a local signal for a token change, a manual restart and a cursor reset, none of which changes a synced preference. Core's `refreshAppRuntime` dispatches on `window`. On the host only the extension verbs and the `eval` context reach it, and the host refuses all of those; its other callers are app-side plugins the host does not load **[read]**.
- *Device storage.* `window.localStorage` is Node's file-backed store in the state directory, already used for the session **[read]**. A new `pnpm headless storage set <config> <key>` reads one value from stdin, the way `login` prompts, and never echoes it. Like every subcommand it takes the state directory's pidfile, so it cannot run beside the daemon. Nothing in the host is Matrix-specific.
- *Per-user prefs.* The host sets `preferencesPage` to the owner's user page, an existing config field. The slice-3 Matrix edit reads its config with `readPluginPref(repo, preferencesRootId(repo, ws), …)` (`src/data/stateBlocks.ts`), which reads without creating anything. So the host follows the owner's homeserver and room, and mints no prefs block of its own. A tab's reads are unchanged, because its root is its own page. The edit also makes the effect re-read its config when the prefs block changes, instead of only at start or on its in-tab restart event.
- *Toasts* go to sonner's module queue with no `<Toaster/>` to drain them. Matrix toasts once per failure streak, and its diagnostics already carry the same states, so no sink is added **[read]**.

<a id="one-writer"></a>**One ingesting device per room** ([§9](#9-decisions) D4, proposed). Derived ids were meant to let several clients ingest one room and converge, but they do not converge when two replicas' property schemas differ **[read]**.
- *Why the layout depends on the replica.* Whether an attribute bullet is promoted into a property depends on the local schema (`promotedValueAcceptorFor(repo)`), and promoted bullets are removed. A message's child ids then follow positions in the remaining tree (`messageNodeId(…, nodePath)`).
- *How rows duplicate.* Two replicas that disagree about one bullet lay the same message out differently. The server keeps the first create per row id, so the rows unique to each writer both land, and a sibling can appear twice.
- *Why tab and host disagree.* The host's seed set is narrower than a tab's ([headless-client.md](headless-client.md) §10), so this is the likely case, not a rare one.

So exactly one device ingests a given room at a time, and that device is the one holding the room's token and its `/sync` cursor, both device-local. A tab without the token reports missing-token and does not poll. Handing ingest to the host:
1. stop the tab's ingest;
2. copy its token and its cursor value to the host with `headless storage set`, then remove both from the tab;
3. start the host.

The host continues from exactly the event the tab stopped at, so no message falls into the gap. Without the cursor, a fresh device drops its whole first timeline and saves the cursor after it **[read]**. Handing back is the same in reverse.

Order keys, version skew and link unwrapping stop mattering for convergence, because one writer has one view. The ingest still has to be safe to replay, since a cursor handoff, paging back through `prev_batch`, or a crash between a write and the cursor save all replay events:
- *Recognise handled events.* It recognises an event already handled by its identity, the `matrix-event:id` property, across live rows, tombstones and moved rows. That check runs in the write transaction, before it creates a day, registers properties or restores a container. Today the check is a `tx.get` on the derived root id plus a scan of the day container's live children, run after the container is ensured **[read]**. So replaying a deleted or moved older message, minted before ids were derived, makes a new copy, and replaying any message can restore a container the user deleted.
- *Cancel cleanly.* Each config read gets its abort controller before its first `await`, and the controller is checked before every write and every cursor save. Today the controller is created after the preferences read **[read]**, so a stop or a second change during that read can leave an untracked poll running.

A write refused mid-poll throws before the cursor save, so the cursor holds and the next poll retries **[read]**.

**Rollout.** No mixed-version machinery is added. The host is already in the drain set. An extension that imports a new kernel export means: deploy, update the checkout, restart the host.

## 8. Where tab and host differ

Everything not listed here is the same code on both platforms: the loader and its gates, the record shape, the boundary-aware resolver, the transpile step and its import rule, the compiled output, the freezer, the reconciler, every data facet, and the extensions' own source.

| Difference | Why it cannot be shared | Kept small by |
|---|---|---|
| Who grants an approval: a click in the tab, the config file on the host | Different trust anchors ([§4](#4-trust)) | One record shape behind `CompiledModuleCache` |
| Instantiation: blob URLs, or a vite-node virtual module plus `data:` URLs | A browser and Node load modules differently | Both take the same record and the same compiled string |
| Which effects start: all of them in a tab; on the host, only allowlisted blocks while writable | The host runs unattended with an OS-level grant | The same reconciler, given a different list |
| Status: the UI in a tab, `health` and the log on the host | No UI on the host | The same approval and diagnostic reporters |
| Local time: the OS in a tab, `timeZone` on the host | The OS zone of a server is arbitrary | The same date code |
| Unpinned URL imports load live in a tab during the transition | Owner decision D3; temporary | One branch in the import plugin, removed by slice 0b |

The parity test in [§5](#pinned-url-imports) runs the same fixture extension through both instantiators and checks the compiled string, the export values and the import-policy refusals.

## 9. Decisions

- **D1, decided by the owner (2026-11-27): run the reviewed copy, and log that a review is needed.** This matches a tab's #67 behaviour, and ingest keeps going after the extension changes in the graph. The rejected alternative was to refuse a block whose live source no longer matches. That would mean code the graph no longer holds never starts, at the cost of pausing ingest until an operator acts. The cost accepted is that the host can keep writing an old shape after the extension changed, until its reviewed copy is updated.
- **D2, decided by the owner (2026-11-27): keep CDN imports working, pinned, and resolved the same way in tab and host** ([§5](#pinned-url-imports)). The rejected alternatives were:
  - removing Matrix's one URL import and refusing URL imports outright;
  - moving the host to Deno, whose lockfile pins remote modules. It would take the host off Node, and its PowerSync SDK depends on a native SQLite addon untested under Deno. It would also leave tabs unpinned.
- **D3, decided by the owner (2026-11-27): a transition period.** When slice 0 lands, an unpinned URL import keeps loading live in tabs, with an `imports-unpinned` warning whose action is "Pin imports". Slice 0b removes the live path once nothing installed still reports the warning, and bumps the compiler version so every old approval is rechecked.
  - *Cost accepted:* tabs keep the unpinned behaviour for the transition's length, and the import plugin carries a second branch until 0b removes it.
  - *Rejected:* refusing unpinned imports at once. That closes the gap immediately, but an extension stops until someone pins it on every device.
  - *Unaffected:* the host loads pinned imports only, in both phases.
- **D4, proposed: one ingesting device per room, handed over with its token and cursor** ([§7](#one-writer)).
  - *Why:* two writers do not converge when their property schemas differ, and tab and host differ by construction. The handoff keeps every message.
  - *Cost:* while the host ingests, the owner's tabs do not, and show missing-token for that room.
  - *Rejected:* keeping simultaneous writers and making them converge. That needs an event representation independent of each replica's schema and a reconciliation rule, proven by an exact-tree test over two divergent replicas and both upload orders. It is a project of its own for a case one writer avoids.

## 10. Slices

0. **Pinned URL imports in tabs.** This slice is core, changes tabs, and stands on its own. It closes the gap that an approval does not cover a URL import's bytes for every pinned import; slice 0b closes it for the rest.
   - The post-transform import check, the pinned-import reader and the freezer.
   - The placeholder plugin, with the `COMPILER_VERSION` bump.
   - `vendored` on the approval record, and an instantiate that takes the record.
   - "Pin imports" bound to the shown source, `pin-imports` in the CLI, and the `install-extension` warning.

   Nothing stops loading ([§9](#9-decisions) D3). An extension with an unpinned URL import keeps running in tabs as today and reports `imports-unpinned` until it is pinned and re-approved on each device. On the owner's replica that is one block, the Matrix extension ([§2](#2-population)).

   **0b. End the transition.** Remove the live-import branch, so the import plugin and `install-extension` refuse unpinned imports, and bump `COMPILER_VERSION` so every existing approval recompiles under the final rule before it runs. It is due once no installed extension reports `imports-unpinned`, checked with one read-only query over the installed extension blocks, as in §2; that query shows only that sources migrated, which is why the compiler bump is needed for old device approvals. It is tracked as its own issue when slice 0 is filed. When it lands, an extension still unpinned stops loading until it is pinned. Its seeds then drop out meanwhile, so writes to its properties are refused or decoded through a preset ([headless-client.md](headless-client.md) §10 "Seeds"), though no stored data changes.
1. **Core seams, with no change in tabs.**
   - The platform setter for instantiate.
   - The reconciler taking an explicit effect list.
   - The provenance predicate moved beside the loader.
   - One source-normalisation function, shared by install and host.

   The existing loader and effect tests cover the tab path unchanged.
2. **Host loading.**
   - `extensions` and `timeZone` in the config.
   - `resolveAppRuntime` after the first gate open, on writable hosts only, with the agent context reading inventories on demand.
   - The read-only approval store built from the config.
   - The virtual-module instantiator and the `data:` vendored cache.
   - Effect eligibility recomputed on admission and writability changes.
   - `headless storage set`.
   - `health.extensions`, with diagnostics only while admission is open, and the boot log line for `update-available`.

   It is verified on a local stack with fixture extensions, alongside the parity test. The gate is mutation-checked one clause at a time, each with its named test:
   - an unlisted block is never evaluated;
   - a listed block whose live source differs runs the reviewed file's code, never the live content, and reports `update-available`;
   - a disallowed, computed or transform-generated specifier is a load error before any import runs;
   - a read-only host evaluates no installed code;
   - a demotion stops effects with no visibility change;
   - a static plugin's effect does not start;
   - a membership removal leaves no diagnostic in `health` and calls none;
   - a deleted-then-restored allowlisted block runs its reviewed copy.
3. **Matrix on the host.** This slice changes the extension first:
   - pin the SDK import: add `&target=es2024` and run `pin-imports`;
   - recognise handled events by event identity before creating anything, and cancel cleanly ([§7](#one-writer));
   - page back through `prev_batch` when a timeline comes back `limited`. Today a gap of more than 30 messages since the saved cursor is silently skipped on that client, tabs included. It is filed as a bug of its own, needs the event-identity check above as its stop condition, and is worth shipping ahead of this slice;
   - read prefs through `readPluginPref` and re-read them on change;
   - bind the token to its (homeserver, room) pair;
   - remove `migrateEventNamespace`, a one-time data migration gated only by a device-local flag that a new device lacks. It is a no-op today: 0 rows pending and 1,402 already migrated on the owner's tab replica **[measured]**. Removed, it can never fire from the host. `migrateLegacyConfig`, the other flag-gated one-time step, only sets its flag on a device without the legacy blob;
   - read the app origin from a constant instead of `window.location`.

   Then reinstall the extension, re-approve it in tabs, allowlist it, and hand ingest over ([§7](#one-writer)). The acceptance test is a handoff with one message sent in the gap, a replay of a deleted older message, and a replay against a deleted day container. Two costs are still unmeasured, and together they decide whether this fits beside the host under the target's OOM policy:
   - Loading the extension and its `@/` imports cost about 290 MB RSS over a bare vite-node process on a laptop, with the SDK stubbed **[measured]**. The marginal cost over a running host is not measured.
   - Whether the es2024 browser-target SDK bundle runs under Node, and what it costs there, is not verified.

   If either fails, the fallback is to replace the SDK's three calls (`createClient`, the `/sync` request, `mxcUrlToHttp` **[read]**) with about twenty lines of `fetch`. That stays a Matrix-only change; pinned imports remain the general path.

Deferred:
- around pinned imports: synced vendored bytes, multi-module closures and any bundler, and externals mapped to the importmap (the peer-dependency case);
- runtime assets reached through `import.meta.url`: a blob URL breaks `new URL(…, import.meta.url)`, and the SDK's only such use is a lazy crypto path Matrix never calls **[read]**;
- `run-action`, static-plugin effects, per-effect headless flags, `--permission` as a seat belt, an out-of-process runner, and a toast sink;
- the Readwise effect, until it reads preferences through `preferencesRootId` instead of the acting account's own.

## 11. Still open

| Unverified | Settled in |
|---|---|
| How the contributors processor attributes effect writes, which go through `repo.tx` directly rather than `executeCommand`'s contributor binding | slice 2 |
| A message write that commits locally but is rejected at upload: it goes to the host's rejected-upload quarantine with the rest of its transaction, while the cursor has already moved past it. Recovery is the quarantine's retry, which has to be shown to work before the host is the sole writer | slice 3 |
| Marginal memory of the loaded extension modules on a running host, the pinned SDK bundle included | slice 3, on the target |
| Whether the es2024 browser-target SDK bundle runs under Node | slice 3 |
| Whether `target=es2024` keeps giving a single self-contained file across esm.sh versions and packages. The freezer checks rather than assumes, so a change is a refusal, never a wrong load | slice 0, then on every pin |
| Whether the virtual-module instantiator behaves the same with the full host running, beyond the probe extension | slice 2 |
