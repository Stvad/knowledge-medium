# Headless client

> **Status:** Slices 1 and 3 implemented; slice 1's hosted checks run on a scratch workspace, slice 2 run read-only on the real graph, and slice 4 cut over and reverted on 2026-11-22 (results in §4, §11 and §13). Last verified against code: 2026-11-22.
> Each claim is tagged **[read]** (seen in the code, by the author or a reviewer citing the line), **[measured]** (run or queried, with where) or **[reasoned]** (inferred; the slice that verifies it is named in [§13](#13-still-open)).
> Not re-read since 2026-11-19: the §4 table, the row-level-security and per-user-row claims in §8, the count of app-side-only seed plugins in §10.

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

### Slice 2: the host's first sync of that graph

Read-only, download-only host on an Apple M2 Max laptop (12 cores, 64 GB RAM, Node 26), sampled once a minute; 2026-11-21. **[measured]**

| | |
|---|---|
| Download | about 1.14 M staged rows in roughly 3 minutes |
| Drain into `blocks` | about 4,000 rows/s early, falling to about 2,100 rows/s over the last 400 k as the file grew |
| Start to the gate opening | about 15 minutes, including a full re-materialization that ran for about 4 minutes after the drain had finished (#1805) |
| After opening | several minutes at full CPU during which reads queued and timed out (#1808); a warm restart admitted in 7 s and answered at once |
| Peak memory | 2.5 GB RSS during the drain, about 2.0 GB when open, about 0.4 GB after a warm restart |
| State directory | 4.8 GB (the browser's database for the same graph: 6.3 GB) |
| Agreement with a tab | block totals, live blocks, typed rows, reference rows and alias rows equal to within 18 rows, which the tab has staged but not applied. Byte-identical outputs for `daily-note` (3 dates), `search` (2), `data-model`, `get-subtree`, `backlinks`. `grouped-backlinks` groups differently: the host read its own account's grouping preferences, which are empty (#1809; `preferencesPage` in §10 points it at a user page). `recent-changes` is empty on the host, since it reads this device's local transaction log, which a new device starts without |
| Planner statistics | none: the host never ran the `ANALYZE` check a tab schedules at boot, and `grouped-backlinks` timed out until a manual `ANALYZE` (#1807; the host now runs it when its gate first opens, see [§13](#13-still-open)) |

The browser figure for the same graph, from #1773 and #1771 (a 4-core Linux VM): 140-381 rows/s depending on what is mounted. The two runs differ in hardware, SQLite build and VFS, so the gap is not attributed; the sync-throughput epic (#1806) holds both.

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
| Decide access before anything materializes or writes | `resolveWorkspaceEntry`, then the key gate **[read]** | The same function, answered from the configured mode and, for E2EE, the workspace key (boot step 6) |
| Hold the workspace until its view is complete | The first-sync gate: read-only and unbootstrapped until `workspaceViewGap` clears **[read]** | The gate in [§7](#the-gate), on every boot and every re-join |
| Open the workspace's data | `bootstrapWorkspace`: definitions ready, the alias-seat and property-child namespaces (an encrypted workspace needs `K_id` for them), the reference derivations, system pages, seed materialization **[read]** | The data half of that function, called whole ([§10](#10-code-changes)) |
| Follow the member role | `setReadOnly(role === 'viewer')` at open and on change **[read]** | The gate; a missing row counts as no access, where a tab opens writable on one |
| Defer catch-up work off startup | `requestIdleCallback` | Absent in Node, where deep-idle work runs on a zero-delay timer **[read]**; the gate is what holds it back |
| Pick up new code | Tabs reload on deploy | Nothing reloads a daemon. The host is in the drain set ([§9](#9-failure-and-recovery)) |
| Surface rejected and held uploads | The system-status UI | `health` |

## 7. Boot

1. **Lock** the state directory with the pidfile helper `agent-dispatch` already has (stale-pid detection, so a SIGKILL does not block the restart). **[read]** `headless login` and `headless storage set` take the same lock as the daemon.
2. **Device storage.** The process is started with `--localstorage-file` pointing into the state directory (mode 0700; the file is created 0644 **[measured]**). After the app's module graph loads, the host provides `window.localStorage` for the mode-pin module. **[read]**
3. **Sign in.** Restore and refresh the session. An absent session or permanent refusal exits non-zero naming the `login` subcommand. A retryable transport failure reuses a still-valid stored session, keeping warm-boot health available behind the checkpoint gate. With an expired token and no connection, restart once connectivity returns. A `SIGNED_OUT` event shuts down a running host. The installed auth-js preserves the session on a permanently refused proactive refresh while the access token is valid. After expiry the same refusal clears storage and emits `SIGNED_OUT`. **[measured]** against a fake transport, with the rotated session restored in a second Node process.
4. **Read the workspace key** (encrypted only; [§8](#8-identity-secrets-invariants)). An unreadable key exits here, before anything connects.
5. **Open the database**, await `waitForReady()`, sample the sync status's `lastSyncedAt`, then run client-schema initialisation. Sampling before ready would read `undefined` and take the persisted value's arrival for a server answer. **[read]**
6. **Decide access** with `resolveWorkspaceEntry`, which can return ready, waiting for the workspace row, or locked. Lock reasons include `key-required`, `server-e2ee`, `quarantine` (unpinned plaintext) and `finishing-upgrade` (interrupted pin upgrade). The host refuses an interrupted upgrade in either mode and leaves its marker for recovery. **[read]** Then, by the configured mode:
   - *encrypted:* on `key-required` or a first-encounter `server-e2ee`, run the existing `unlockWorkspaceWithKey` flow with the workspace key, against the synced canary, into the process-wide key store (in memory, since Node has no IndexedDB **[read]**). It pins `e2ee` when the key validates.
   - *plaintext:* on `quarantine`, pin `plaintext` with the same `setModePin` the tab's gate calls. **[read]** This is the one place the host pins on the config's word and the server row's, with no key to prove it, which is exactly what the person clicking "confirm plaintext" in a tab goes on.

   Resolve again, and proceed only when the answer is ready *and* the pin equals the configured mode. Everything else exits non-zero with the reason: a config that says plaintext against a row that says encrypted, or the reverse, never pins anything. When the workspace row is not local yet (the first boot), step 7 runs first and this step waits for the row. The real PowerSync core makes the row visible on completion of the checkpoint that contains it. Before that the operations remain in the oplog. **[measured]** locally. The hosted service determines how it divides a first download into checkpoints. The downloaded data survives a wrong-key refusal, so the owner can correct the key and restart.
7. **Connect.** With `writable` omitted or false, the SDK gets download-only options and boot refuses a pre-existing upload queue. With `writable: true`, the host installs the tab's encrypting connector behind the upload hold. Both modes use the deployment's credential lookup and WebSocket transport. A writable host with queued operations but no local workspace row refuses before connecting. Preserve its database for inspection: it cannot validate its configured mode before replay, and pending uploads prevent the missing row's checkpoint from applying.
8. **Build the Repo, read-only**: `new Repo({db, cache, user, syncObserverDeps, isReadOnly: true})` with no backfill claim, the `staticDataExtensions` runtime, and the configured workspace active. Always after step 6, so the observer's first drain already has the key and defers nothing. Not through `createTestRepo`, which installs a working stand-in claim. **[read]** On the first boot (the workspace has no blocks) take `repo.holdBulkSyncLoad(workspaceId)` at once and release it when the gate first opens: its contract, that nothing waits on the write lock and the rows are reaching `blocks` for the first time, is true here. **[read]** The same first open runs the planner-statistics check (`runAnalyzeIfStale`), which every device receives from `initializeClientDatabase` and schedules itself; a tab runs it at deep idle at boot and after its first sync. After the drain, so `sqlite_stat1` describes the downloaded graph. **[read]**
9. **Register with the bridge server.** Once access is decided and the Repo exists, both token scopes serve `health` and `ping` while the gate is closed. A writable config grants a read-write token, which can also request local rematerialization while closed. The bridge checks token scope before forwarding a command. This makes a long first drain observable. While waiting for the first workspace row there is no Repo to register.
10. **Run the gate** for the life of the process.
11. **Shutdown** (SIGTERM). Re-register with an empty token list, stop polling and drain in-flight commands. If the server is unreachable its client record expires after 60 seconds. Stop the gate, wait for a running `ANALYZE` check, disconnect sync, flush and stop the observer, unpin, advance one Node timer turn, await deferred Repo work and cancel delayed processors before closing the database. Pending and rejected uploads stay on disk.

### The gate

Serving is a state the host enters and can leave, not a point boot passes once. One function decides it, re-run on every sync-status change, workspace or membership change and drain end.

**Entry conditions.** The slice-1 profile serves only `health` and `ping` until all of these hold:
- the server has answered in this process: `lastSyncedAt` differs from the value sampled in step 5. `onFirstSync` cannot serve, because `hasSynced` persists across sessions, and `onSyncSettled` is true between connecting and a queued download starting. **[read]** On the Node SDK the field moved after every reconnect with nothing changed and never while idle (**[measured]** 2026-11-05, self-hosted service, SDK since upgraded);
- `repo.workspaceViewGap(workspaceId)` is null: nothing staged, sync settled, no re-materialization running, no downloaded row left unapplied. All arms, where the tab's gate asks only the local ones behind a per-device marker; a daemon has no reason to open on a backlog. While the gap is transient the host waits and kicks the drain with `repo.flushSyncObserver()`, since a failed drain window otherwise retries only on the next arrival. A durable gap does not clear by waiting: `health` gives the count, and the read-only bridge profile cannot invoke the local repair command. **[read]** Sized on one live client by #1777: zero such rows;
- the workspace row and the host’s member row are both local.

**Open.** The gate sets the Repo's access before calling `openWorkspaceData` on entry and on a role change. Only an editor or owner on a write-enabled host with no stale upload hold gets a writable Repo. Before admission, membership and the workspace view gap come from one database snapshot. The host checks again after flushing a backlog and awaits both namespace reads before admitting commands. It rechecks membership when a command arrives so demotion takes effect even ahead of the table notification. A failed membership read closes admission and revokes write access.

**Back to closed.** Admission belongs to the member row’s id. The gate watches the workspace and membership tables and reads both rows in the same snapshot as the view gap. A missing row closes admission and cancels any pending bootstrap. Removing and re-inviting the same account gives it a new member id, even when its role stays the same. If the changes arrive between refreshes, that id change expires the old watchers and preparation. The restored member passes every entry check before its workspace opens. Ordinary downloads, workspace renames and offline operation preserve the current membership’s admission. **[measured]** on the local replica.

The host does not use the tab's per-workspace first-sync marker; that marker exists so a tab is not held again by a later backlog.

### The upload hold (slice 3)

The queue’s head is its lowest `ps_crud.id`. The host keeps one device-local record of that id and the wall-clock time it first became the head, in `headless_upload_head` in the same SQLite database as the queue. The first enqueue creates the record. Removing the head records its successor or clears the record if the queue is empty. Both changes commit with the queue change, including while the host is offline. An entry appended behind the head leaves its clock running. A queue inherited from a version without this record receives its first observation on upgrade.

At boot and before each collected upload batch, the host compares elapsed time with seven days. Exactly seven days remains eligible. Beyond seven days it holds the whole queue, makes the Repo read-only and throws `UploadHeldError` on an upload attempt. An explicit restart with `--release-stale-queue` permits the head that was already stale at that startup. The next head starts its own clock. This rule applies to every queued operation, including patches without a version. Seed definitions, a new daily note and the first comment can all upload on the run that created them. **[measured]** against the production connector with a fake sink.

Why: the server merges a patch's columns in on arrival. It knows the row moved under the edit, and bumps the version, but refuses nothing, so a weeks-old agent patch would replace whatever a person wrote to the same column since. **[read]** The hold sits where uploads happen, so it covers a restart after weeks down and a process that stayed up through a long outage alike. It guards one device against a rule every device has; whether the server should let the stale write win at all is #1783, and the hold goes when that is answered there. With a held queue, the real PowerSync core can download new rows into its oplog. The checkpoint does not advance and the new rows do not reach staging **[measured]**. A warm host booted held stays behind its checkpoint gate. A previously admitted host continues serving its last applied view read-only. In `health.host`, `uploadHold` explains the stall, `queuedEntries` counts raw operations, `oldestQueuedAgeMs` gives the elapsed time for the current head and is null for an empty queue, and `closedReason` reports actual admission.

## 8. Identity, secrets, invariants

**Account: a dedicated member with the editor role** (owner decision). The credential on an unattended machine is bounded by row-level security to the workspaces it is a member of, cannot change ownership, convert the workspace or flip its `properties_migration` mode, and is revoked by removing the member. **[read]** It can still do everything a writer can, including deleting blocks. Per-user rows are minted only app-side, so the host creates none. **[read]** The account may own a personal workspace if it ever opened the app; that workspace is never pinned, so nothing materializes in it and nothing can be written to it. **[read]**

The read scope of the bridge token is the member account's local replica. The configured workspace controls admission and the Repo's active workspace. Once the gate opens, a read-only SQL query can inspect any rows already downloaded for the account, including raw staging and workspace metadata. The session and device key live outside this database. **[read]**

**Sign-in.** The app offers an emailed code or an anonymous session. **[read]** `headless login` uses the emailed code, once, interactively. A password or service credential would be a new auth surface for one host; not proposed.

**Workspace key.** Read once at start, before the host connects, from exactly one source the config names, and handed to the unlock flow, which zeroes its parsed copy; the string read stays in the host's memory until it stops, beside the imported key. **[read]** A key that cannot be read fails the boot before anything syncs.

- `keyFile`: a file, resolved relative to the config, which must have mode 0600.
- `keyCommand`: an argv array run without a shell, such as `["security", "find-generic-password", "-s", "knowledge-medium-headless", "-a", "<workspace-id>", "-w"]` for the macOS login keychain, or `op read` or `pass show` for those stores. Its trimmed stdout is the key. It gets no stdin, so a store that would prompt there fails rather than waits. A nonzero exit, a signal, empty output, or still running at 15 seconds (it is then killed) fails the boot; the message names the program (`argv[0]`) and how it ended, never its stdout or stderr. A program path containing `/` resolves relative to the config, like `keyFile`; the arguments are passed as written. A bare name searches the host's `PATH`, so a store outside the system directories needs an absolute path under a supervisor that does not pass `PATH` (a plain launchd plist gets only the system directories). To check that a keychain item exists without printing the key, run the same `security` command without `-w`.

A key command keeps the key out of a plaintext file at rest: off backups, file-sync folders and anything that sweeps the home directory. It does not keep it from the agents: any process running as the same OS user can run the same command. Only running the daemon as its own OS user does that, as the verb list below says.

No key-delivery endpoint: it would put the key on a server, which is what end-to-end encryption exists to avoid, and the revocable thing is membership.

**Invariants.** Each names its mechanism and the test that fails when the mechanism is deleted.

1. **Only classified verbs run, and only in the state that allows them.** One table in `scripts/headless/`, typed `Record<KnownCommandType, 'always' | 'open' | 'writable' | {refuse: string}>`, so a verb added to the protocol is a compile error until someone classifies it, as `knownCommandRegistry` already does. **[read]** The table does not say which verbs write: a read-only Repo refuses those itself. Two writes bypass the Repo. `sql` in execute mode is never served: `sql` runs only when `isReadOnlyAgentCommand` says so. `retry-rejected-upload` writes the upload queue directly, so it is `writable`: served once the gate is open and the gate's `writeRefusal()` is null, the same predicate that sets the Repo's read-only state. *Test:* table-driven, one case per refusal and per state.
2. **A write needs write access and a complete view.** The gate. The default config forces read-only even for an editor or owner. *Test:* a normal document write reaches the read-only Repo and is refused; with the row removed, every verb but the `always` ones is; with the row restored beside a backlog, writes stay refused until the gap clears. Each clause deleted fails its own case.
3. **One identity per database.** The pidfile lock. The state directory is never copied to another machine. *Test:* a second boot, and a `login`, on a held directory exit before opening the database.
4. **No workspace backfill from the host.** The Repo has no backfill claim, and the host refuses `run-backfill`. On a read-only Repo the shared bootstrap schedules seed materialization, which declines to write. The slice 1 test observes that call, verifies that a reference gets its missing local target column, and checks that the document content and empty upload queue are preserved. **[measured]** The writable parity fixture verifies the host seed pass on a tab-prepared workspace and inspects the queue before issuing commands.
5. **A plaintext upload to an encrypted workspace is impossible.** The production resolver derives the upload mode from the device pin. An encrypted pin requires the key. A synced row reporting encryption while the device lacks that pin holds uploads. The plaintext first-encounter path requires both the configured mode and the synced row to say plaintext. The owner accepts the same reliance on that row as a person confirming plaintext in a tab. **[read]** As defence in depth, `createPowerSyncConnector` requires an encryption resolver and validates each create and patch before compaction can merge its envelope with a later edit. An invalid or absent `workspace_id` quarantines the entire original transaction in `ps_crud_rejected`. Later valid transactions drain. A missing key or held workspace leaves the transaction queued for retry. Local tests cover both malformed operations and both config/row mode mismatches. **[measured]**
6. **A stale queue is not uploaded unattended.** Slice 1 refuses any nonempty upload queue before connecting and preserves the queued rows on disk. **[measured]** The writable host checks the persisted head clock before upload. A head that has waited eight days holds every operation behind it, including a queue consisting entirely of stamp-less patches.
7. **The agent surface returns neither the key nor the session.** `eval` is refused, and a pass over the served read commands searches their serialized results for a synthetic device-storage value and workspace key. **[measured]** on the local test database.
8. **Attribution is unchanged**: with the contributors processor in the runtime (it is in `staticDataExtensions`), `executeCommand` rebinds `repo.withTxContext({contributorId, contributorSource: 'agent'})` and an unchosen contributor is refused. **[read]** *Test:* the slice 3 parity test compares attribution columns too.

<a id="verbs"></a>**Host command classes.** The bridge grants a read-only token in slice 1. Its protocol scope excludes document writes, `watch-events` and `rematerialize-workspace` before the commands below reach the host. The latter two change watcher registrations and local materialized rows respectively. Their host handlers remain available to in-process tests. Active dispatch continues to use the writable tab.
- *always:* `health`, `ping`, `rematerialize-workspace`, `rejected-uploads`.
- *writable* (served once the gate is open and the host may upload: configured writable, member role editor or owner, no stale-queue hold; otherwise refused with which of those failed): `retry-rejected-upload`; `add-media`, which stores bytes and queues their upload before its transaction ([Media](#media)).
- *open* (served once the gate is open): read-only `sql` (also applied to SQL inside watcher definitions), `get-block`, `get-subtree`, `view-*`, `backlinks`, `grouped-backlinks`, `page`, `daily-note`, `search`, `comments`, `recent-changes`, `block-history`, `data-model`, `resolve-block-id`, `list-contributors`, `describe-runtime`, `runtime-summary`, `watch-events`, `read-media`; and the block writes `create-block`, `update-block`, `edit-block`, `move-block`, `delete-block`, `restore-block`, `append-markdown`, `reconcile-markdown-subtree`, `create-page`, `add-comment`, `create-contributor`.
- *refused:* `eval` (it runs with the daemon's OS privileges and could read the key file or run the key command); the extension verbs and `audit-extension` (they compile through the page's importmap and blob URLs); `run-action`; `run-backfill`, `audit-properties`.

The write-enabled profile serves the listed write verbs via the shared command layer. The default profile provides the read subset. **[read]** An agent with a shell on the same machine as the same OS user can still read the key file or run the key command; run the daemon as its own user if that matters.

## 9. Failure and recovery

| Failure | What happens | Recovery |
|---|---|---|
| Killed mid-upload | The queue is on disk. Delivery is at-least-once: a replayed create preserves the existing row and touches it to emit a sync echo. A replayed patch re-applies its columns **[read]** | Restart |
| Killed between a write and its post-commit processor | Derived columns such as parsed references stay underived until the block is next edited; content is intact. Same as a tab closed at that moment **[read]** | None; accepted |
| Session refresh refused | Boot exits non-zero. Mid-run a permanent refusal after access-token expiry emits sign-out and exits | Run `pnpm headless login <config.json>`, restart |
| Wrong or missing key | Boot exits before bridge registration; an unreadable key (missing file, failed key command) exits before connecting | Fix the key source, restart |
| No network at boot, or a long first drain | A retryable refresh failure reuses a still-valid stored session. A warm host can register and report a closed gate. An expired session without a usable refresh exits. A cold host needs its first workspace row before it registers. | Restore connectivity. Restart if the process exited. |
| Downloaded rows still unapplied at entry | The gate stays closed and `health` reports the gap | Preserve the state directory for operator diagnosis. The slice-1 token cannot invoke local rematerialization. |
| Demoted to viewer | The local member-row change immediately revokes Repo write access. Already queued operations still go to the server, where a permanent rejection goes into `ps_crud_rejected`. The `rejectedUploads` health field counts those rows. The host keeps the local edits and their quarantine records; nothing retries them on its own | Restore the role, list with `rejected-uploads`, then `retry-rejected-upload <txId>` for each transaction, oldest first. A retry requeues the whole transaction. It goes ahead only while every column it wrote still holds, on the host, the value the latest rejected write gave it; once a later edit or a download reached such a column, sending either value would lose the other, so it is refused and the edit stays quarantined for a hand re-apply. Nothing holds back a download over a quarantined row. It is also refused while the host cannot upload (read-only, held, or `writable: false`), while the queue holds a write to one of its rows, and when a row is no longer in `blocks`. A transaction the server refuses again returns to quarantine. There is no discard verb: dropping rejected rows loses data and is a separate decision |
| Membership removed | The gate closes and the workspace leaves the device | Restore the member; the gate re-opens when the re-download has drained |
| Download-only config finds queued writes on disk | Boot refuses before connecting and preserves the queue | Keep the state directory intact for inspection and recovery |
| Same queue head for more than a week | The upload hold; the host is read-only and, at boot, closed | Look at the queue, then restart with `--release-stale-queue` |
| Workspace converted to encrypted while the host is configured plaintext | Uploads hold and arriving rows defer **[read]**; nothing plaintext leaves | Conversion is a coordinated event: stop the host first, as for a deploy. Afterwards set the config to `e2ee` with a key source. Which flow upgrades the host's existing plaintext pin is not designed ([§13](#13-still-open)) |
| Corrupt or suspect database | Refuse to boot; never auto-wipe | Inspect the queue first: deleting the state directory discards the queue, the rejected rows and device storage. Then delete it, `login`, cold-sync |

**Deploys.** Nothing gates an old client: there is no minimum-version check, and an unknown `properties_migration` mode parses as `'cell'`, so an old daemon would write cell-shaped properties into a workspace that had moved on. **[read]** The host is therefore in the drain set, with no new machinery: before a deploy that changes schema, codecs, seeds or the migration mode, stop the host with an empty queue, update the checkout, start it. `health` reports the checkout's commit so the running version is visible.

## 10. Code changes

**Core (`src/`, no plugin imports), each an extraction or a strictness change:**
- *Client-schema initialisation.* Browser and Node share the ordered DDL and backfills. The browser adapter executes a batch of statements including its completion sentinel. The Node adapter prepares one statement per call. **[read]** Direct importers of `initializeClientSchema`, `BATCH_SENTINEL_SQL` and the `SchemaDb` type now use `src/data/internals/initializeClientDatabase.ts`. That module also constructs the raw-table schema and runs the ordered backfills. Browser OPFS setup stays in `repoProvider.ts`. `createTestDb.ts` uses the shared implementation when preparing its template. The module also builds the planner-statistics check and hands it to each device through the required `scheduleAnalyzeCheck` option, so every device decides when it runs; test databases pass a no-op. **[read]**
- *Connection setup.* Browser and host share credential lookup and WebSocket transport. The browser installs its encrypting uploader. The writable host wraps the same uploader. The default host supplies only download options. The resolver needs no extraction: `createSyncResolver` and `readWorkspaceEncryptionMode` are already platform-neutral, and `resolverForUser` only memoizes them over the browser's database map. **[read]**
- *Workspace bootstrap.* `openWorkspaceData` waits for definitions, starts both namespace reads, schedules the workspace backfills and local derivations, ensures system pages, then schedules seed materialization. After the data bootstrap succeeds, the tab remembers the workspace for the next launch and continues to layout without waiting for either namespace read. The read-only host awaits both returned promises. A local test reaches seed scheduling, verifies that a pre-existing reference gets its local target column, and checks the upload queue is empty.
- *Auth storage*: `services/supabase.ts` passes `auth.storage` from an override a leaf module holds, unset in browsers, so `createClient` behaves there exactly as today.
- `createPowerSyncConnector` requires the `encryption` option. TypeScript rejects an omitted option, and an untyped caller omitting it gets a `TypeError` during construction. A create or patch missing a valid `workspace_id` quarantines its original transaction before transport.
- *Rejected-upload retry.* `src/data/rejectedUploads.ts` lists the quarantine by transaction and requeues one transaction whole, refusing one whose columns have changed locally since. The tab's dialog and both agent verbs call it, so the tab's Retry now requeues a row's whole transaction rather than that row alone.
- `health` reports the rejected-upload count, and uses an optional provider for the host's commit, effective read-only state, gate reason and checkpoint timestamps. The existing upload-queue preview remains available. The host also reports its stale-queue hold, operation count and elapsed time at the head of the queue.

**`packages/agent-dispatch`:** the pidfile helper's "already running" message takes the daemon's name instead of hard-coding its own. **[read]** A README note on the headless profile. `packages/agent-cli` gains the `rejected-uploads` and `retry-rejected-upload` verbs; a tab serves them too, without the host's upload checks.

**New, in `scripts/headless/`:** entry point, boot, the read gate, `login`, the verb table. It calls `startBridgeLoop` directly, as the eval host does. The headless process has `window.localStorage` and no global `document`. The host wires the watcher event transport on admission. Registering a watcher over the bridge requires a writable token. **[read]**

**Device storage needs no code.** Node 26 persists `localStorage` across processes under `--localstorage-file`, with `window` and `document` still undefined. **[measured]** on this machine's Node; Node labels Web Storage experimental. If that proves fragile the fallback is a file-backed `Storage` of some forty lines with a write-temp-then-rename.

**Config.** One file: state directory, workspace id, the workspace's mode (`e2ee` or `plaintext`), exactly one of `keyFile` or `keyCommand` when encrypted, bridge profile, optional boolean `writable` (default false), and optional `preferencesPage`, a user page's block id (#1809). Per-user preferences that read verbs consult, such as `grouped-backlinks`' grouping defaults and `backlinks`' daily-note filter, resolve from that page; unset, they resolve from the host account's own page, which has none. `preferencesRootId` in `src/data/stateBlocks.ts` decides this for every preference read a served verb makes; a tab's root is its own user page. Preference and UI-state writes still go to the host account's own page, and the host never writes the configured one. The host reads no extension enable intent, because it loads no installed extensions and refuses the toggle verbs **[read]**. [headless-extensions.md](headless-extensions.md) proposes a host-config allowlist instead. Before opening workspace data the gate refuses a `preferencesPage` that is not a live user page of the configured workspace (its id must be the user page derived from the user it names), so the host serves nothing instead of quietly reading defaults. The refusal reaches callers as the gate's fixed `Could not open workspace data`, with the detail in the host's log, and is re-checked on each wake until the page qualifies. *Test:* `scripts/headless/preferencesPage.test.ts` runs the same `grouped-backlinks` and daily-note `backlinks --filter effective` calls through a tab and through a host pointed at that tab's user page, checks they agree where the defaults would not, and checks the configured page's rows and the upload queue after host-side preference and UI-state writes. **[measured]** The bridge URL and secret come from `agent-cli`'s `bridgeUrl()` / `bridgeSecret()`, and the host's token lives in `agent-cli`'s token store under its profile (`loadStoredToken` / `writeStoredToken`), where the CLIs already look. **[read]** The operator supervises both processes under one OS user. The owner procedure below uses systemd user units or temporary launchd jobs.

**Seeds.** Eleven static plugins register seeds only on the app side **[measured]**, and installed extensions cannot load in Node (Babel plus blob-URL imports **[read]**), so the host's seed set is narrower than a tab's. The host uses `staticDataExtensions` without the React `kernelValuePresetsExtension`. When a local seed is missing, the data layer uses the synced definition and a registered preset to reconstruct the property's codec. When that behavior is unavailable, creates and changes to the value are refused in both cell and child-backed storage. Content edits preserve the value and its references. The merged missing-seed tests exercise both paths in `src/plugins/agent-runtime/test/missingSeedWrites.test.ts`. No seed relocation is needed. **[measured]**

**Untouched:** Supabase, the sync rules.

## 11. Slices

Slices 1 and 2 run every boot step with the role forced to read-only, so the gate opens for reads and nothing else.

1. **Read-only host on a scratch encrypted workspace**, and the same boot against a scratch plaintext one, which differs only in step 6. The extractions, device storage with a test that a refreshed session survives a restart, `login`, lock, boot, the gate, the read verbs. Asserts `ps_crud` stays empty throughout: a read-only Repo still passes UI-state, prefs and automation writes, and the served reads make none. A separately injected UI-state write remains queued because the SDK has no uploader. **[read]**
2. **The real graph, still read-only.** Measure cold sync, memory and file size. Compare `health` counts and a sample of `view-*` outputs with a tab's.
3. **Writes on a scratch encrypted workspace.** The shared data layer enforces missing-seed behavior. This slice adds role-following, write access, the upload hold, and a parity test: one command sequence against a tab-shaped and a host-shaped runtime yields identical rows.
4. **The real graph.** First open the workspace once in a browser as the host's account, so the first-open writes are made by the tab path and the host's own open should queue nothing; check `health`'s queue depth after it. Then stop the tab-pointed `agent-dispatch` and point it at the host's profile. Dispatch runs only there, so the claim race it documents does not widen.

   Run 2026-11-22 **[measured]**: the browser first-open step was skipped, since the workspace-level first-open rows already existed from the owner's tab and the host mints no per-user rows. The first writable open still queued 5 uploads, all rewrites of the derived `references` column on 3 blocks, flipping between two orderings eleven times in about 300 ms before settling; content untouched, and tab and host ended byte-identical (#1820). A test block written through the host reached the tab within seconds and its deletion followed. `agent-dispatch` was then pointed at the host's profile (with the dispatch profile's contributor) and restarted through its launchd job; it paired as the host account and registered its watcher. The first real mention was answered through the host in about 2.5 minutes, writing 744 blocks (24 comment threads with their property rows, and the streamed reply); the host's queue drained, nothing was rejected, no owner gained duplicate property rows, and the tab holds the same 744 rows.

   Then reverted, by owner decision the same day: the main mention listener answers through the tab again, because a mention made in a tab is seen there first. Measured from the moment a mention first contained the trigger in the tab's local log to the daemon's claim, two mentions each: 11.5 s and 17.4 s through the tab, 49.1 s and 79.2 s through the host, whose path adds an upload, the server and a download. The host stays for agents with no tab open and for a second listener on its own trigger that shares the main listener's memory (being built).

### Owner verification for slice 1

Use a scratch graph and a dedicated member account. In the deployed browser app, sign in as that member, open the envelope in the workspace header, select the scratch invitation and click **Accept**. The browser calls `accept_invitation` and navigates to that workspace. On macOS, open the app with `open https://stvad.github.io/knowledge-medium/`. On Linux, use `xdg-open https://stvad.github.io/knowledge-medium/`. The headless login command only authenticates the device.

From this checkout, use Node 26 and run `node scripts/ensure-deps.mjs`. Set `config` to the desired absolute path for a new config file. Copy the [example config](../scripts/headless/config.example.json) outside the checkout and set `workspaceId` to the scratch workspace ID. Paths in the config resolve relative to that file. For an encrypted run, either place the exported scratch key in the configured mode-0600 file, or on macOS store it in the login keychain and replace `keyFile` with `keyCommand`. Given `-w` with no value, `security` prompts for the password, so the key stays off the command line and out of shell history:

```sh
security add-generic-password -s knowledge-medium-headless -a '<workspace-id>' -w
```

```json
"keyCommand": ["security", "find-generic-password", "-s", "knowledge-medium-headless", "-a", "<workspace-id>", "-w"]
```

```sh
config=/absolute/path/to/headless.json
install -m 600 scripts/headless/config.example.json "$config"
```

For the plaintext run, set `mode` to `plaintext`, omit `keyFile` (or `keyCommand`) and use a separate state directory and profile. The launcher creates the state directory with mode 0700 and selects Node's persistent Web Storage file. Use a dedicated profile in the same OS user's agent-cli store. Export the deployment's three public client settings in the launching shell. The headless Vite config disables dotenv loading.

```sh
export VITE_SUPABASE_URL='<public project URL>'
export VITE_SUPABASE_ANON_KEY='<public client key>'
export VITE_POWERSYNC_URL='<PowerSync endpoint URL>'
pnpm headless login "$config"
```

Enter the dedicated member's email and emailed code at the prompts. The daemon and login take the same lock, so stop the daemon before repeating login. With the default loopback bridge configuration, the two foreground commands are `pnpm agent:server` and `pnpm headless run "$config"`. Run the following from the checkout to supervise them during a Linux scratch run. The two transient user units use the same OS user's agent-cli settings. Use an existing supervised bridge if it already owns the configured port.

To set a device-local storage key while the daemon is stopped, run `pnpm headless storage set "$config" <key>`. Enter one line at the hidden prompt or supply it on stdin.

Set `TZ` in the host service environment to the owner's IANA time zone. The host uses it to choose the local date for `daily-note today`. Replace the example below with the owner's zone, then check `host.timeZone` in `health` after startup. Health reports the effective zone or the current UTC offset if the process cannot resolve a zone name.

```sh
export TZ=America/Los_Angeles
systemd-run --user --unit=km-scratch-bridge --working-directory="$PWD" \
  --setenv=PATH --property=Restart=on-failure "$(command -v node)" packages/agent-cli/dist/server.js
systemd-run --user --unit=km-scratch-host --working-directory="$PWD" \
  --setenv=PATH --setenv=TZ --setenv=VITE_SUPABASE_URL --setenv=VITE_SUPABASE_ANON_KEY --setenv=VITE_POWERSYNC_URL \
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

For a macOS scratch run, launch the same two foreground programs as temporary user jobs from the checkout. Export the owner's `TZ` as above. For a private scratch bridge, choose an unused loopback port and pass the same port to both jobs and the CLI.

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
  "TZ=$TZ" "VITE_SUPABASE_URL=$VITE_SUPABASE_URL" "VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY" \
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

### Owner verification for slice 3

Use the scratch setup above with a dedicated editor. Open the workspace in the browser first and let it finish syncing. Stop the host, set `"writable": true` in its config, then start it in one terminal:

```sh
pnpm headless run "$config"
```

In another terminal, check for an open gate, a writable Repo, zero queued entries and zero rejections after bootstrap. Set `tab` to the scratch tab’s bridge profile. Reload that tab before the test to start with empty undo history. After the edit arrives, compare its undo depths before and after using the tab command below.

```sh
pnpm agent --profile headless-scratch health
pnpm agent --profile "$tab" --contributor none eval "return repo.undoManager.depths('block-default')"
pnpm agent --profile headless-scratch --contributor none create-block '{"content":"headless scratch verification"}'
# Set block to the returned id.
pnpm agent --profile "$tab" get-block "$block"
pnpm agent --profile "$tab" --contributor none eval "return repo.undoManager.depths('block-default')"
pnpm agent --profile headless-scratch health
```

Demote the dedicated member in the scratch owner's membership UI and repeat the following command. It must refuse and the tab must retain the original content. Promote it and repeat: the tab should receive the edit. Remove and restore membership using the owner's UI and the original invitation procedure. Sample `health` on reconnect and after a warm restart, comparing baseline and last checkpoint with the slice 1 instructions. For reconnect frequency, observe the host's WebSocket connection at the scratch service over an identified interval. Run the same write/read checks on the encrypted and plaintext scratch configurations.

```sh
pnpm agent --profile headless-scratch --contributor none update-block "{\"id\":\"$block\",\"content\":\"scratch role check\"}"
pnpm agent --profile headless-scratch health
pnpm agent --profile "$tab" get-block "$block"
```

For a held scratch queue, stop the host and inspect its on-disk operations. Set `state` to the configured state directory and `db` to the dedicated member’s database listed by the first command. Review the local queue before authorizing replay.

```sh
find "$state" -maxdepth 1 -name 'kmp-v6-*.db'
sqlite3 -readonly "$db" "SELECT entry_id, datetime(first_seen_ms / 1000, 'unixepoch') AS first_seen_utc FROM headless_upload_head"
sqlite3 -readonly "$db" "SELECT id, tx_id, json_extract(data,'$.op'), json_extract(data,'$.id') FROM ps_crud ORDER BY id"
```

To release that queue, run:

```sh
pnpm headless run "$config" --release-stale-queue
# In the other terminal
pnpm agent --profile headless-scratch health
```

Confirm the queue drains, checkpoint application resumes, and the peer sees the intended edits. Production-scale sync time, memory, file size and dispatch cutover belong to slices 2 and 4.

## 12. Later

<a id="media"></a>**Media verbs** (built after slice 4). `read-media` fetches on demand and `add-media` uploads. Nothing replicates every asset down to the host. The host is a second platform for the attachments plugin's lanes. `createMediaLanes` (`src/plugins/attachments/mediaLanes.ts`) assembles the same capture, drain, reconcile and resolver the tab uses, for one bound user, with injected stores. It reads no `repoProvider` state. **[read]**
- *Bytes* are plaintext files under `<stateDir>/media/`, laid out like the tab's OPFS store (`FsByteStore`). Their exposure matches the decrypted database beside them. The resolver serves a stored file as already verified, so each write lands in `media/partial/` and is renamed into place. Only captured bytes and bytes a read fetched are kept. Until its upload lands, a capture's file is its only copy: `media/` is not a cache to clear while `mediaUploads.pending` is above zero.
- *The upload queue* is a local, unsynced table (`media_upload_queue`) in the host's own database (`SqliteByteUploadStore`). It is held to the same contract as the tab's IndexedDB queue and survives a restart. **[measured]** locally: an upload that could not reach Storage is sent by the next process.
- *Encryption* is the tab's code. The drain seals with `encodeBytes` and addresses the object by the keyed content key, using the CEK and K_id that the host's own resolver unlocked at boot. A plaintext upload still needs the server's live mode to say plaintext. **[measured]** locally: the stored object holds neither the plaintext nor its hash, and reads back through the resolver's hash check once the local copy is gone.
- *When uploads run:* after each capture, when the gate first opens (reconcile, then drain), and every five minutes, each only while the gate's `writeRefusal()` is null. A demoted or held host leaves records pending rather than sending a PUT that would fail them. Shutdown waits for the drain pass in flight; the supervisor's stop timeout bounds it, and a killed pass leaves its records pending. The `health` field `mediaUploads` counts staged, pending and failed records.
- *A `failed` record* comes from a permanent Storage refusal, a transient failure on a record older than a week, eight non-transient errors, or its file missing. The host has no retry verb (the tab's Retry is not ported). Recovery: run `add-media` again with the same bytes, which re-arms the record; its file stays in `media/` until then.
- *What the verbs refuse:* `add-media` is `writable` (above). The host serves media with or without the app-runtime Attachments toggle, as it does every other verb: that toggle lives in the tab's app runtime.
- The media type and property seeds moved into `attachmentsDataExtension`, so the data runtime the host runs registers them. **[read]**

**Transient containers.** Two different things get called that.

*A transient agent with a persistent client.* The container runs the agent and reaches the host over the bridge. The bridge server speaks HTTP with `Authorization: Bearer` and has a guarded switch for listening beyond loopback (`AGENT_RUNTIME_ALLOW_NETWORK`). **[read]** Behind a TLS tunnel the agent's credential is a revocable bearer token for one host name, and neither the key nor the database enters the container. This needs its own short design (exposure, token scope, rate limits) and should be tried first.

*A transient client.* The container itself syncs and decrypts, so it starts from a saved database or pays a cold sync. A snapshot is a 6 GB file **[measured]** holding plaintext, whole-file encrypted, stored somewhere never public, refreshed by something and downloaded at each fresh start. It also needs: export only with an empty queue and no open transaction; a schema and app version stamp; a restore that mints a new PowerSync client id and resets device storage; completion defined as "uploaded and acknowledged", because a reclaimed container loses its queue; and a way to deliver the key.

What this design keeps open for it at no cost: the state directory is the whole device, so a snapshot is that directory; boot is "open what is there, then sync", so a restore is the same boot; the host is the only writer of its directory, so it is the only thing that could export it consistently; the gate is already something the host waits on. Slice 2's measurements decide how much of the snapshot path is worth building.

## 13. Still open

| Unverified | Settled in |
|---|---|
| Process supervision (launchd or systemd) for the host; as of the slice 4 cutover it runs in the foreground, so dispatch stops when it does | owner |
| Plaintext mode against the hosted service | owner scratch run |
| The host's `ANALYZE` check on the real graph: it runs when the gate first opens (**[measured]** locally: a host opening a workspace ends with `sqlite_stat1` over the drained rows), but neither its duration there (a manual one took about 7 s) nor `grouped-backlinks` answering afterwards without a manual `ANALYZE` is measured | owner real-graph run |
| The first-open busy window | #1808 |
| `grouped-backlinks` matching a tab on the real graph with `preferencesPage` set (covered locally) | owner run |
| Writable open on the deployed scratch workspace (tab-prepared writable open covered locally) | owner scratch run |
| How often the hosted sync stream reconnects | owner scratch run |
| Upgrading a host's plaintext pin after the workspace is converted (the tab has `upgradeWorkspacePin` for this) | when a plaintext workspace served by a host is first converted |
| A synced agent write never landing on another device's undo stack in the deployment | owner scratch run |
| Resetting PowerSync's client id being sufficient after a restore | the transient-client design |
| A retried transaction accepted by the hosted service once the role is restored | owner scratch run |
