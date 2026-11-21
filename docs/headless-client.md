# Headless client

> **Status:** Slice 1 implemented and tested locally. Last verified against code: 2026-11-21. Hosted scratch-workspace checks remain for the owner. Slices 2–4 describe future work.
> Each claim is tagged **[read]** (seen in the code, by the author or a reviewer citing the line), **[measured]** (run or queried, with where) or **[reasoned]** (inferred; the slice that verifies it is named in [§13](#13-still-open)).
> Not re-read since 2026-11-19: the §4 table, the row-level-security and per-user-row claims in §8, the 4 s timer in §9, the count of app-side-only seed plugins in §10.

## 1. Goal

Run the data layer and the agent surface with no browser tab, so `agent-dispatch`, `kmagent` and `km-mcp` work when no device has the app open.

A headless client is a Node process that signs in, syncs, decrypts and materializes like a device, and serves the bridge protocol the tab serves today. It is a new kind of *device*, and the design treats it as one wherever it can: the same Repo, the same data extensions, key flows and workspace-open sequence. The read-only slice connects for downloads only.

## 2. Scope

**A host that keeps its disk: one long-lived process, one database directory, on a machine that stays up.** Owner decisions: persistent hosts first; transient containers are wanted eventually, so this design must not foreclose them ([§12](#12-later)); the host signs in as a dedicated member account; a queue older than a week is not uploaded without an operator.

**Encrypted and plaintext workspaces** (owner decision). The config names the workspace's mode, and the host serves it only when the device's pin ends up equal to that mode. For a plaintext workspace the config line is the confirmation a person gives on the tab's key gate.

It protects against: a plaintext upload to an encrypted workspace; a headless write that differs from the same write made in a tab; a workspace backfill run from the host; two processes on one database; an agent reading the key or the session through the agent surface; a write made without write access or against a view that has not caught up; a stale queue uploading unattended.

It does not cover hosts that lose their disk. That case needs a database snapshot that can be exported, restored and re-identified.

## 3. What already exists

- **The agent surface already runs under Node.** `scripts/agent-eval/host.ts` opens a `@powersync/node` database, builds a Repo with the data extensions, and serves it through the real `startBridgeLoop` + `executeCommand` to the real bridge server (`packages/agent-cli/dist/server.js`), so the real `kmagent` and km MCP server drive it. **[read]** It has no `db.connect()`, no sign-in, no key, and a throwaway database built by test factories.
- **The seam is one function**, `BridgeLoopOptions.execute(command)` in `src/plugins/agent-runtime/bridgeLoop.ts`. **[read]**
- **The bridge server does not care what registers.** A tab is an HTTP client of it, and so is the eval host. **[read]**
- **The core data layer touches no browser global** beyond a few guarded reads. The browser-bound files are the OPFS boot (`repoProvider.ts`, `localDbVfs.ts`) and storage-backed device state (mode pins, the telemetry client id, the Supabase session). **[read]**
- **Workspace backfills refuse without a claim**, on the operator path and the runner alike, and the one production backfill is `trigger: 'operator'`. **[read]**
- **A Repo can be read-only.** `isReadOnly` / `setReadOnly` reject document writes; UI-state, user-prefs and automation scopes pass through. **[read]**
- **Rows staged before a Repo exists are not lost**: triggers capture them durably, and the sync observer, which starts in the Repo constructor, drains the backlog. **[read]**
- **"Is this workspace's view complete" has an owner**: `repo.workspaceViewGap(workspaceId)`, with `repo.flushSyncObserver()` and `repo.rematerializeWorkspace()` as its remedies and `repo.holdBulkSyncLoad()` for a first load. The tab's first-sync gate (#1777) is built on them. **[read]**

## 4. Measurements

Read-only queries against a live client:

| | |
|---|---|
| Blocks, all workspaces | about 1.18 M **[measured]** |
| Largest workspace | about 99% of them; roughly 65 MB of content and 28 MB of properties as plaintext **[measured]** |
| Local database file | about 6.3 GB, no free pages **[measured]** |
| Data behaviour contributed by installed extensions | property and type seeds only. Every mutator, processor, invalidation rule, query and local-schema contribution in the live runtime comes from the kernel or a plugin already in `staticDataExtensions` **[measured]** |

Not measured, and needed before trusting the host on the real graph: cold sync plus materialization time under Node, peak memory, the Node database size.

The only figure for a first sync of this graph is a browser's, from #1773: 173 rows/s with the app's live queries mounted and 381 rows/s with their re-runs stubbed out, which it reads as the write transaction's own rate. For 1.18 M rows that is between about 50 minutes and 2 hours. The host has no live queries and a different SQLite, so its rate is unknown in both directions.

## 5. Shape

```
agent-dispatch ─┐                                     ┌─ PowerSync service
kmagent ────────┼─ bridge server ─── headless host ───┤
km-mcp ─────────┘    127.0.0.1                        └─ Supabase (auth, upload RPCs)
```

One daemon per graph, registered with the existing bridge server as a client, under its own profile and token. `agent-dispatch`, `kmagent` and `km-mcp` are pointed at that profile and are otherwise unchanged.

A daemon rather than a library each agent embeds, because the database is the unit of identity: PowerSync's own client id lives in the file and write checkpoints are requested per client id (`powersync_client_id()`, `/write-checkpoint2.json?client_id=…` in the SDK). **[read]** One process owning one directory makes "two clients with one identity" unrepresentable.

The entry point lives in **`scripts/headless/`**. `scripts/` is already typechecked with Node types, already exempt from the kernel/plugin lint as a consumer above both layers, and already has tests in the gate (`scripts/agent-eval`). **[read]** It runs from a checkout with `vite-node`; a bundled artifact waits for a host without a checkout.

## 6. The app shell's duties

A tab is safe to write from because the app shell around the Repo does several things. The host has no shell, so each duty needs an owner. Every row is something a Repo alone does not do.

| Duty | In a tab | In the host |
|---|---|---|
| Persist the session and device state (mode pins) | `localStorage`; supabase-js uses it only when `window` and `document` both exist at client construction **[read]** | Node's own `localStorage`, persisted with `--localstorage-file` in the state directory, and handed to the Supabase client explicitly ([§10](#10-code-changes)) |
| Decide access before anything materializes or writes | `resolveWorkspaceEntry`, then the key gate **[read]** | The same function, answered from the configured mode and, for E2EE, the key file (boot step 5) |
| Hold the workspace until its view is complete | The first-sync gate: read-only and unbootstrapped until `workspaceViewGap` clears **[read]** | The gate in [§7](#the-gate), on every boot and every re-join |
| Open the workspace's data | `bootstrapWorkspace`: definitions ready, the alias-seat and property-child namespaces (an encrypted workspace needs `K_id` for them), the reference derivations, system pages, seed materialization **[read]** | The data half of that function, called whole ([§10](#10-code-changes)) |
| Follow the member role | `setReadOnly(role === 'viewer')` at open and on change **[read]** | The gate; a missing row counts as no access, where a tab opens writable on one |
| Defer catch-up work off startup | `requestIdleCallback` | Absent in Node, where deep-idle work runs on a zero-delay timer **[read]**; the gate is what holds it back |
| Pick up new code | Tabs reload on deploy | Nothing reloads a daemon. The host is in the drain set ([§9](#9-failure-and-recovery)) |
| Surface rejected and held uploads | The system-status UI | `health` |

## 7. Boot

1. **Lock** the state directory with the pidfile helper `agent-dispatch` already has (stale-pid detection, so a SIGKILL does not block the restart). **[read]** `headless login` takes the same lock, so it never runs beside the daemon.
2. **Device storage.** The process is started with `--localstorage-file` pointing into the state directory (mode 0700; the file is created 0644 **[measured]**). `window` is provided after the app's module graph loads, as the eval shim does, because the mode-pin module looks for `window.localStorage`. **[read]**
3. **Sign in.** Restore and refresh the session. An absent session or permanent refusal exits non-zero naming the `login` subcommand. A retryable transport failure reuses a still-valid stored session, keeping warm-boot health available behind the checkpoint gate. With an expired token and no connection, restart once connectivity returns. A `SIGNED_OUT` event shuts down a running host. The installed auth-js preserves the session on a permanently refused proactive refresh while the access token is valid. After expiry the same refusal clears storage and emits `SIGNED_OUT`. **[measured]** against a fake transport, with the rotated session restored in a second Node process.
4. **Open the database**, await `waitForReady()`, sample the sync status's `lastSyncedAt`, then run client-schema initialisation. Sampling before ready would read `undefined` and take the persisted value's arrival for a server answer. **[read]**
5. **Decide access** with `resolveWorkspaceEntry`, which can return ready, waiting for the workspace row, or locked. Lock reasons include `key-required`, `server-e2ee`, `quarantine` (unpinned plaintext) and `finishing-upgrade` (interrupted pin upgrade). The host refuses an interrupted upgrade in either mode and leaves its marker for recovery. **[read]** Then, by the configured mode:
   - *encrypted:* on `key-required` or a first-encounter `server-e2ee`, run the existing `unlockWorkspaceWithKey` flow with the key file, against the synced canary, into the process-wide key store (in memory, since Node has no IndexedDB **[read]**). It pins `e2ee` when the key validates.
   - *plaintext:* on `quarantine`, pin `plaintext` with the same `setModePin` the tab's gate calls. **[read]** This is the one place the host pins on the config's word and the server row's, with no key to prove it, which is exactly what the person clicking "confirm plaintext" in a tab goes on.

   Resolve again, and proceed only when the answer is ready *and* the pin equals the configured mode. Everything else exits non-zero with the reason: a config that says plaintext against a row that says encrypted, or the reverse, never pins anything. When the workspace row is not local yet (the first boot), step 6 runs first and this step waits for the row. The real PowerSync core makes the row visible on completion of the checkpoint that contains it. Before that the operations remain in the oplog. **[measured]** locally. The hosted service determines how it divides a first download into checkpoints. The downloaded data survives a wrong-key refusal, so the owner can correct the key file and restart.
6. **Connect for downloads.** The Node host uses PowerSync's download-only options, the production credential lookup and the deployment's WebSocket transport. The SDK installs no upload callback. Startup refuses a pre-existing upload queue and preserves it for recovery. If a permitted Repo scope queues a write after startup, the row stays on disk. **[measured]** with the SDK's normalized connector and a real UI-state transaction.
7. **Build the Repo, read-only**: `new Repo({db, cache, user, syncObserverDeps, isReadOnly: true})` with no backfill claim, the `staticDataExtensions` runtime, and the configured workspace active. Always after step 5, so the observer's first drain already has the key and defers nothing. Not through `createTestRepo`, which installs a working stand-in claim. **[read]** On the first boot (the workspace has no blocks) take `repo.holdBulkSyncLoad(workspaceId)` at once and release it when the gate first opens: its contract, that nothing waits on the write lock and the rows are reaching `blocks` for the first time, is true here. **[read]**
8. **Register with the bridge server.** Once access is decided and the Repo exists, the slice-1 read-only token serves `health` and `ping` while the gate is closed. The bridge checks token scope before forwarding a command. This makes a long first drain observable. While waiting for the first workspace row there is no Repo to register.
9. **Run the gate** for the life of the process.
10. **Shutdown** (SIGTERM). Re-register with an empty token list, stop polling and drain in-flight commands. If the server is unreachable its client record expires after 60 seconds. Stop the gate, disconnect sync, flush and stop the observer, unpin, advance one Node timer turn, await deferred Repo work and cancel delayed processors before closing the database. Slice 1 never starts with pending uploads.

### The gate

Serving is a state the host enters and can leave, not a point boot passes once. One function decides it, re-run on every sync-status change, member-row change and drain end.

**Entry conditions.** The slice-1 profile serves only `health` and `ping` until all of these hold:
- the server has answered in this process: `lastSyncedAt` differs from the value sampled in step 4. `onFirstSync` cannot serve, because `hasSynced` persists across sessions, and `onSyncSettled` is true between connecting and a queued download starting. **[read]** On the Node SDK the field moved after every reconnect with nothing changed and never while idle (**[measured]** 2026-11-05, self-hosted service, SDK since upgraded);
- `repo.workspaceViewGap(workspaceId)` is null: nothing staged, sync settled, no re-materialization running, no downloaded row left unapplied. All arms, where the tab's gate asks only the local ones behind a per-device marker; a daemon has no reason to open on a backlog. While the gap is transient the host waits and kicks the drain with `repo.flushSyncObserver()`, since a failed drain window otherwise retries only on the next arrival. A durable gap does not clear by waiting: `health` gives the count, and the read-only bridge profile cannot invoke the local repair command. **[read]** Sized on one live client by #1777: zero such rows;
- the host's member row is local.

**Open**: reads are served. Slice 1 keeps the Repo read-only for every role, awaits the shared data bootstrap and both namespace reads, and enables watcher events. In slice 3, on entering and on any later change of role, the host sets `repo.setReadOnly(…)` and then calls the data half of the workspace bootstrap ([§10](#10-code-changes)), in the tab's order: gates, role, bootstrap. Idempotent, as a tab calls it on every open. The Repo is writable only while the role is editor or owner *and* the upload queue is not held.

**Back to closed** when the member row disappears. Removing the member drops the whole workspace from the device, and restoring it returns the member row and a million blocks in one checkpoint **[read]**; without this the host would be writable over a workspace that is still draining, and its get-or-create verbs would mint pages the server already has.

Admission lasts for the observed membership. Ordinary downloads, staging backlogs and offline operation preserve reads, watchers and the existing workspace bootstrap. Membership loss cancels an in-progress open or closes an admitted workspace. A rejoin goes through every entry check again. Shutdown also cancels the open. The host returns fixed reasons for failed checks and logs the diagnostic locally.

The host does not use the tab's per-workspace first-sync marker; that marker exists so a tab is not held again by a later backlog.

### The upload hold (slice 3)

The host wraps the connector's upload: if the oldest queued write is more than a week old, it throws the existing `UploadHeldError` instead of uploading, and the Repo goes read-only. Age is `now` minus the smallest `updated_at` a queued entry carries; the upload trigger emits it whenever the column changed, which is every write except a derived-column patch. **[read]** `health` reports the hold, the queue depth and the oldest age. Restarting with `--release-stale-queue` uploads it; nothing is discarded either way.

Why: the server merges a patch's columns in on arrival. It knows the row moved under the edit, and bumps the version, but refuses nothing, so a weeks-old agent patch would replace whatever a person wrote to the same column since. **[read]** The hold sits where uploads happen, so it covers a restart after weeks down and a process that stayed up through a long outage alike. It guards one device against a rule every device has; whether the server should let the stale write win at all is #1783, and the hold goes when that is answered there. A held queue also stops downloaded checkpoints applying **[read]**, so a host that boots held stays closed.

## 8. Identity, secrets, invariants

**Account: a dedicated member with the editor role** (owner decision). The credential on an unattended machine is bounded by row-level security to the workspaces it is a member of, cannot change ownership, convert the workspace or flip its `properties_migration` mode, and is revoked by removing the member. **[read]** It can still do everything a writer can, including deleting blocks. Per-user rows are minted only app-side, so the host creates none. **[read]** The account may own a personal workspace if it ever opened the app; that workspace is never pinned, so nothing materializes in it and nothing can be written to it. **[read]**

The read scope of the bridge token is the member account's local replica. The configured workspace controls admission and the Repo's active workspace. Once the gate opens, a read-only SQL query can inspect any rows already downloaded for the account, including raw staging and workspace metadata. The session and device key live outside this database. **[read]**

**Sign-in.** The app offers an emailed code or an anonymous session. **[read]** `headless login` uses the emailed code, once, interactively. A password or service credential would be a new auth surface for one host; not proposed.

**Workspace key.** Read once at start from a file the config names (mode 0600) and handed to the unlock flow, which zeroes its parsed copy; the string read from the file is left to the garbage collector. **[read]** No key-delivery endpoint: it would put the key on a server, which is what end-to-end encryption exists to avoid, and the revocable thing is membership.

**Invariants.** Each names its mechanism and the test that fails when the mechanism is deleted.

1. **Only classified verbs run, and only in the state that allows them.** One table in `scripts/headless/`, typed `Record<KnownCommandType, 'always' | 'open' | {refuse: string}>`, so a verb added to the protocol is a compile error until someone classifies it, as `knownCommandRegistry` already does. **[read]** The table does not say which verbs write: a read-only Repo refuses those itself. The one write that bypasses the Repo is `sql` in execute mode, so `sql` is served only when `isReadOnlyAgentCommand` says so. *Test:* table-driven, one case per refusal and per state.
2. **A write needs write access and a complete view.** The gate. Slice 1 forces read-only even for an editor or owner. *Test:* a normal document write reaches the read-only Repo and is refused; with the row removed, every verb but the `always` ones is; with the row restored beside a backlog, writes stay refused until the gap clears. Each clause deleted fails its own case.
3. **One identity per database.** The pidfile lock. The state directory is never copied to another machine. *Test:* a second boot, and a `login`, on a held directory exit before opening the database.
4. **No workspace backfill from the host.** The Repo has no backfill claim, and the host refuses `run-backfill`. On a read-only Repo the shared bootstrap schedules seed materialization, which declines to write. The slice 1 test observes that call, verifies that a reference gets its missing local target column, and checks that the document content and empty upload queue are preserved. **[measured]** Writable first-open parity belongs to slice 3.
5. **A plaintext upload to an encrypted workspace is impossible.** The production resolver derives the upload mode from the device pin. An encrypted pin requires the key. A synced row reporting encryption while the device lacks that pin holds uploads. The plaintext first-encounter path requires both the configured mode and the synced row to say plaintext. The owner accepts the same reliance on that row as a person confirming plaintext in a tab. **[read]** As defence in depth, `createPowerSyncConnector` requires an encryption resolver and validates each create and patch before compaction can merge its envelope with a later edit. An invalid or absent `workspace_id` quarantines the entire original transaction in `ps_crud_rejected`. Later valid transactions drain. A missing key or held workspace leaves the transaction queued for retry. Local tests cover both malformed operations and both config/row mode mismatches. **[measured]**
6. **A stale queue is not uploaded unattended.** Slice 1 refuses any nonempty upload queue before connecting and preserves the queued rows on disk. **[measured]** Slice 3 will add the age-based hold and test release of an eight-day-old write.
7. **The agent surface returns neither the key nor the session.** `eval` is refused, and a pass over the served read commands searches their serialized results for a synthetic device-storage value and workspace key. **[measured]** on the local test database.
8. **Attribution is unchanged**: with the contributors processor in the runtime (it is in `staticDataExtensions`), `executeCommand` rebinds `repo.withTxContext({contributorId, contributorSource: 'agent'})` and an unchosen contributor is refused. **[read]** *Test:* the slice 3 parity test compares attribution columns too.

<a id="verbs"></a>**Host command classes.** The bridge grants a read-only token in slice 1. Its protocol scope excludes document writes, `watch-events` and `rematerialize-workspace` before the commands below reach the host. The latter two change watcher registrations and local materialized rows respectively. Their host handlers remain available to in-process tests. Active dispatch continues to use the writable tab.
- *always:* `health`, `ping`, `rematerialize-workspace`.
- *open* (served once the gate is open): read-only `sql` (also applied to SQL inside watcher definitions), `get-block`, `get-subtree`, `view-*`, `backlinks`, `grouped-backlinks`, `page`, `daily-note`, `search`, `comments`, `recent-changes`, `block-history`, `data-model`, `resolve-block-id`, `list-contributors`, `describe-runtime`, `runtime-summary`, `watch-events`; and the block writes `create-block`, `update-block`, `edit-block`, `move-block`, `delete-block`, `restore-block`, `append-markdown`, `reconcile-markdown-subtree`, `create-page`, `add-comment`, `create-contributor`.
- *refused:* `eval` (it runs with the daemon's OS privileges and could read the key file); the extension verbs and `audit-extension` (they compile through the page's importmap and blob URLs); `run-action`; `run-backfill`, `audit-properties`; `add-media` / `read-media` (not ported; [§12](#12-later)).

The planned writable profile covers dispatch and the graph MCP tools except media. Slice 1 provides the read subset. **[read]** An agent with a shell on the same machine as the same OS user can still read the key file; run the daemon as its own user if that matters.

## 9. Failure and recovery

| Failure | What happens | Recovery |
|---|---|---|
| Killed mid-upload | The queue is on disk. Delivery is at-least-once: creates are insert-or-skip, a replayed patch re-applies the same columns **[read]** | Restart |
| Killed between a write and its post-commit processor | Derived columns such as parsed references stay underived until the block is next edited; content is intact. Same as a tab closed at that moment **[read]** | None; accepted |
| Session refresh refused | Boot exits non-zero. Mid-run a permanent refusal after access-token expiry emits sign-out and exits | Run `pnpm headless login <config.json>`, restart |
| Wrong or missing key | Boot exits before bridge registration | Fix the key file, restart |
| No network at boot, or a long first drain | A retryable refresh failure reuses a still-valid stored session. A warm host can register and report a closed gate. An expired session without a usable refresh exits. A cold host needs its first workspace row before it registers. | Restore connectivity. Restart if the process exited. |
| Downloaded rows still unapplied at entry | The gate stays closed and `health` reports the gap | Preserve the state directory for operator diagnosis. The slice-1 token cannot invoke local rematerialization. |
| Demoted to viewer | The Repo goes read-only at once; writes already queued are rejected by row-level security into `ps_crud_rejected`, which `health` counts | Restore the role. The rejected rows stay in the host's `blocks` and nowhere else, so its view differs from the server's by those rows until slice 3 decides whether to serve the retry or discard them |
| Membership removed | The gate closes and the workspace leaves the device | Restore the member; the gate re-opens when the re-download has drained |
| Slice 1 finds queued writes on disk | Boot refuses before connecting and preserves the queue | Keep the state directory intact for inspection and recovery |
| Slice 3: oldest queued write over a week old | The upload hold; the host is read-only and, at boot, closed | Look at the queue, then restart with `--release-stale-queue` |
| Workspace converted to encrypted while the host is configured plaintext | Uploads hold and arriving rows defer **[read]**; nothing plaintext leaves | Conversion is a coordinated event: stop the host first, as for a deploy. Afterwards set the config to `e2ee` with the key file. Which flow upgrades the host's existing plaintext pin is not designed ([§13](#13-still-open)) |
| Corrupt or suspect database | Refuse to boot; never auto-wipe | Inspect the queue first: deleting the state directory discards the queue, the rejected rows and device storage. Then delete it, `login`, cold-sync |

**Deploys.** Nothing gates an old client: there is no minimum-version check, and an unknown `properties_migration` mode parses as `'cell'`, so an old daemon would write cell-shaped properties into a workspace that had moved on. **[read]** The host is therefore in the drain set, with no new machinery: before a deploy that changes schema, codecs, seeds or the migration mode, stop the host with an empty queue, update the checkout, start it. `health` reports the checkout's commit so the running version is visible.

## 10. Code changes

**Core (`src/`, no plugin imports), each an extraction or a strictness change:**
- *Client-schema initialisation.* Browser and Node share the ordered DDL and backfills. The browser adapter executes a batch of statements including its completion sentinel. The Node adapter prepares one statement per call. **[read]** Direct importers of `initializeClientSchema`, `BATCH_SENTINEL_SQL` and the `SchemaDb` type now use `src/data/internals/initializeClientDatabase.ts`. That module also constructs the raw-table schema and runs the ordered backfills. Browser OPFS setup stays in `repoProvider.ts`. `createTestDb.ts` uses the shared implementation when preparing its template.
- *Connection setup.* Browser and host share credential lookup and WebSocket transport. The browser installs its encrypting uploader. The host supplies only download options. The resolver needs no extraction: `createSyncResolver` and `readWorkspaceEncryptionMode` are already platform-neutral, and `resolverForUser` only memoizes them over the browser's database map. **[read]**
- *Workspace bootstrap.* `openWorkspaceData` waits for definitions, starts both namespace reads, schedules the workspace backfills and local derivations, ensures system pages, then schedules seed materialization. The tab passes its remember-workspace callback, invoked after starting both reads and before scheduling backfills, and continues to layout without waiting for IndexedDB. The read-only host awaits both returned promises. A local test reaches seed scheduling, verifies that a pre-existing reference gets its local target column, and checks the upload queue is empty.
- *Auth storage*: `services/supabase.ts` passes `auth.storage` from an override a leaf module holds, unset in browsers, so `createClient` behaves there exactly as today.
- `createPowerSyncConnector` requires the `encryption` option. TypeScript rejects an omitted option, and an untyped caller omitting it gets a `TypeError` during construction. A create or patch missing a valid `workspace_id` quarantines its original transaction before transport.
- `health` reports the rejected-upload count, and uses an optional provider for the host's commit, forced role, gate reason and checkpoint timestamps. The existing upload-queue preview remains available. Age-based hold reporting belongs to slice 3.

**`packages/agent-dispatch`:** the pidfile helper's "already running" message takes the daemon's name instead of hard-coding its own. **[read]** A README note on the headless profile. Nothing else there or in `packages/agent-cli` changes.

**New, in `scripts/headless/`:** entry point, boot, the read gate, `login`, the verb table. It calls `startBridgeLoop` directly, as the eval host does, and reuses the eval host's `window`/`document` shim (which leaves an existing `localStorage` alone **[read]**). The host wires the watcher event transport on admission. Registering a watcher over the bridge requires a writable token in a later slice. **[read]**

**Device storage needs no code.** Node 26 persists `localStorage` across processes under `--localstorage-file`, with `window` and `document` still undefined. **[measured]** on this machine's Node; Node labels Web Storage experimental. If that proves fragile the fallback is a file-backed `Storage` of some forty lines with a write-temp-then-rename.

**Config.** One file: state directory, workspace id, the workspace's mode (`e2ee` or `plaintext`), key-file path when encrypted, bridge profile. The bridge URL and secret come from `agent-cli`'s `bridgeUrl()` / `bridgeSecret()`, and the host's token lives in `agent-cli`'s token store under its profile (`loadStoredToken` / `writeStoredToken`), where the CLIs already look. **[read]** The operator supervises both processes under one OS user. The owner procedure below uses systemd user units or temporary launchd jobs.

**Seeds.** Eleven static plugins register seeds only on the app side **[measured]**, and installed extensions cannot load in Node (Babel plus blob-URL imports **[read]**), so the host's seed set is narrower than a tab's. The read-only runtime uses `staticDataExtensions` without the React `kernelValuePresetsExtension`. The served read commands run against the data runtime. Write parity is slice 3's first check: a write to a property whose seed the host lacks must be refused or stored under the synced definition, never re-typed. Only if that fails do the static seeds move into data extensions.

**Untouched:** Supabase, the sync rules.

## 11. Slices

Slices 1 and 2 run every boot step with the role forced to read-only, so the gate opens for reads and nothing else.

1. **Read-only host on a scratch encrypted workspace**, and the same boot against a scratch plaintext one, which differs only in step 5. The extractions, device storage with a test that a refreshed session survives a restart, `login`, lock, boot, the gate, the read verbs. Asserts `ps_crud` stays empty throughout: a read-only Repo still passes UI-state, prefs and automation writes, and the served reads make none. A separately injected UI-state write remains queued because the SDK has no uploader. **[read]**
2. **The real graph, still read-only.** Measure cold sync, memory and file size. Compare `health` counts and a sample of `view-*` outputs with a tab's.
3. **Writes on a scratch encrypted workspace.** The missing-seed check first; then role-following, the write verbs, the upload hold, and a parity test: one command sequence against a tab-shaped and a host-shaped runtime yields identical rows.
4. **The real graph.** First open the workspace once in a browser as the host's account, so the first-open writes are made by the tab path and the host's own open should queue nothing; check `health`'s queue depth after it. Then stop the tab-pointed `agent-dispatch` and point it at the host's profile. Dispatch runs only there, so the claim race it documents does not widen.

### Owner verification for slice 1

Use a scratch graph and a dedicated member account. In the deployed browser app, sign in as that member, open the envelope in the workspace header, select the scratch invitation and click **Accept**. The browser calls `accept_invitation` and navigates to that workspace. On macOS, open the app with `open https://stvad.github.io/knowledge-medium/`. On Linux, use `xdg-open https://stvad.github.io/knowledge-medium/`. The headless login command only authenticates the device.

From this checkout, use Node 26 and run `node scripts/ensure-deps.mjs`. Set `config` to the desired absolute path for a new config file. Copy the [example config](../scripts/headless/config.example.json) outside the checkout and set `workspaceId` to the scratch workspace ID. Paths in the config resolve relative to that file. For an encrypted run, place the exported scratch key in the configured mode-0600 file.

```sh
config=/absolute/path/to/headless.json
install -m 600 scripts/headless/config.example.json "$config"
```

For the plaintext run, set `mode` to `plaintext`, omit `keyFile` and use a separate state directory and profile. The launcher creates the state directory with mode 0700 and selects Node's persistent Web Storage file. Use a dedicated profile in the same OS user's agent-cli store. Export the deployment's three public client settings in the launching shell. The headless Vite config disables dotenv loading.

```sh
export VITE_SUPABASE_URL='<public project URL>'
export VITE_SUPABASE_ANON_KEY='<public client key>'
export VITE_POWERSYNC_URL='<PowerSync endpoint URL>'
pnpm headless login "$config"
```

Enter the dedicated member's email and emailed code at the prompts. The daemon and login take the same lock, so stop the daemon before repeating login. With the default loopback bridge configuration, the two foreground commands are `pnpm agent:server` and `pnpm headless run "$config"`. Run the following from the checkout to supervise them during a Linux scratch run. The two transient user units use the same OS user's agent-cli settings. Use an existing supervised bridge if it already owns the configured port.

```sh
systemd-run --user --unit=km-scratch-bridge --working-directory="$PWD" \
  --setenv=PATH --property=Restart=on-failure "$(command -v node)" packages/agent-cli/dist/server.js
systemd-run --user --unit=km-scratch-host --working-directory="$PWD" \
  --setenv=PATH --setenv=VITE_SUPABASE_URL --setenv=VITE_SUPABASE_ANON_KEY --setenv=VITE_POWERSYNC_URL \
  --property=Restart=on-abnormal "$(command -v node)" scripts/headless/launch.ts run "$config"
systemctl --user status km-scratch-bridge km-scratch-host
journalctl --user -u km-scratch-host -n 30
```

Once registered, wait for `host.closedReason` to become null and verify that `host.readOnly` is true, `uploadQueueBlocks` is zero, and `rejectedUploads` is zero on the scratch device. Record health, restart the host without changing the workspace, and check health again after registration. On the warm boot, `host.baselineSyncedAt` must contain the previously persisted checkpoint in epoch milliseconds. Once `host.closedReason` is null, verify that `host.lastSyncedAt` is greater than this baseline.

```sh
pnpm agent --profile headless-scratch health
pnpm agent --profile headless-scratch sql get 'SELECT count(*) AS queued FROM ps_crud'
systemctl --user restart km-scratch-host
pnpm agent --profile headless-scratch health
pnpm agent --profile headless-scratch sql get 'SELECT count(*) AS queued FROM ps_crud'
```

If the bridge belongs to the scratch run, restart it and confirm the host registers again.

```sh
systemctl --user restart km-scratch-bridge
pnpm agent --profile headless-scratch health
systemctl --user stop km-scratch-host km-scratch-bridge
```

For a macOS scratch run, launch the same two foreground programs as temporary user jobs from the checkout. The job arguments below pass only the three public client settings. For a private scratch bridge, choose an unused loopback port and pass the same port to both jobs and the CLI.

```sh
export AGENT_RUNTIME_PORT=18787
domain="gui/$(id -u)"
scratch_job() {
  label=$1
  shift
  launchctl submit -l "$label" -- /bin/sh -c 'cd "$1" && shift && exec "$@"' sh "$PWD" \
    /usr/bin/env "PATH=$PATH" "AGENT_RUNTIME_PORT=$AGENT_RUNTIME_PORT" "$@"
}
scratch_job org.knowledge-medium.scratch-bridge "$(command -v node)" packages/agent-cli/dist/server.js
scratch_job org.knowledge-medium.scratch-host /usr/bin/env \
  "VITE_SUPABASE_URL=$VITE_SUPABASE_URL" "VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY" \
  "VITE_POWERSYNC_URL=$VITE_POWERSYNC_URL" "$(command -v node)" scripts/headless/launch.ts run "$config"
pnpm agent --profile headless-scratch health
launchctl kill SIGTERM "$domain/org.knowledge-medium.scratch-host"
# Once the host exits, start it from the same job definition.
launchctl kickstart "$domain/org.knowledge-medium.scratch-host"
pnpm agent --profile headless-scratch health
pnpm agent --profile headless-scratch sql get 'SELECT count(*) AS queued FROM ps_crud'
launchctl kickstart -k "$domain/org.knowledge-medium.scratch-bridge"
pnpm agent --profile headless-scratch health
launchctl bootout "$domain/org.knowledge-medium.scratch-host"
launchctl bootout "$domain/org.knowledge-medium.scratch-bridge"
```

These hosted sign-in, invitation, reconnect and supervision checks require the owner's environment.

## 12. Later

**Media verbs.** Without them an agent on the host cannot read an image in a note or attach a file. Owner: no strong view on scope, so the plan is fetch-on-`read-media` and upload-on-`add-media`, with no replication of every asset down to the host. What it takes, none started:
- *Byte storage.* Node has no OPFS (`navigator.storage` is undefined on Node 26 **[measured]**). The store class takes its root directory as a dependency (`OpfsByteStoreDeps.getRoot`), and File System Access adapters over a real directory exist (`@jsonjoy.com/fs-node-to-fsa`, `native-file-system-adapter`; neither tried). But `createByteStore()` picks the in-memory store under Node and has no seam to say otherwise. **[read]**
- *The upload queue* is IndexedDB or in memory, so pending uploads would not survive a restart. **[read]**
- *The lanes* gate on `isRemoteSyncActive()`, which only the browser's `ensurePowerSyncReady` sets, and import `repoProvider.ts`, which pulls in `@powersync/web`. **[read]**
- *The verbs.* `add-media` refuses unless the app-side media renderer is registered, which stands in for "the attachments plugin is on". **[read]**

So it is a port of the attachments plugin's storage and lanes to a second platform, with its own design, not a shim.

**Transient containers.** Two different things get called that.

*A transient agent with a persistent client.* The container runs the agent and reaches the host over the bridge. The bridge server speaks HTTP with `Authorization: Bearer` and has a guarded switch for listening beyond loopback (`AGENT_RUNTIME_ALLOW_NETWORK`). **[read]** Behind a TLS tunnel the agent's credential is a revocable bearer token for one host name, and neither the key nor the database enters the container. This needs its own short design (exposure, token scope, rate limits) and should be tried first.

*A transient client.* The container itself syncs and decrypts, so it starts from a saved database or pays a cold sync. A snapshot is a 6 GB file **[measured]** holding plaintext, whole-file encrypted, stored somewhere never public, refreshed by something and downloaded at each fresh start. It also needs: export only with an empty queue and no open transaction; a schema and app version stamp; a restore that mints a new PowerSync client id and resets device storage; completion defined as "uploaded and acknowledged", because a reclaimed container loses its queue; and a way to deliver the key.

What this design keeps open for it at no cost: the state directory is the whole device, so a snapshot is that directory; boot is "open what is there, then sync", so a restore is the same boot; the host is the only writer of its directory, so it is the only thing that could export it consistently; the gate is already something the host waits on. Slice 2's measurements decide how much of the snapshot path is worth building.

## 13. Still open

| Unverified | Settled in |
|---|---|
| `lastSyncedAt` moving on a reconnect with nothing changed, on the current SDK and against the hosted service | owner scratch run |
| Dedicated-member login, browser invitation acceptance and process supervision in the deployment | owner scratch run |
| Hosted first-download checkpoint boundaries | owner scratch run |
| Cold sync time, memory and file size under Node | slice 2 |
| A write to a property whose seed the host lacks | slice 3 |
| Writable `openWorkspaceData` preserving an existing tab-created workspace | slice 3 |
| How often the sync stream reconnects | slice 3 |
| Whether to serve the rejected-upload retry or discard rejected rows | slice 3 |
| Upgrading a host's plaintext pin after the workspace is converted (the tab has `upgradeWorkspacePin` for this) | when a plaintext workspace served by a host is first converted |
| A synced agent write never landing on another device's undo stack | slice 3 |
| Resetting PowerSync's client id being sufficient after a restore | the transient-client design |
