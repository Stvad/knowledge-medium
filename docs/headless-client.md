# Headless client

> **Status:** design draft, nothing built. Last verified against code: 2026-11-19, against master `9c86a3ddc2c`. Code wins where they differ.
> Each claim is tagged **[read]** (seen in the code), **[measured]** (a read-only query against a live client that day) or **[reasoned]** (inferred, to be verified in the slice named beside it).

## 1. Goal

Run the data layer and the agent surface with no browser tab, so `agent-dispatch`, `kmagent` and `km-mcp` work when no device has the app open.

A headless client is a Node process that signs in, syncs, decrypts and materializes like a device, and serves the bridge protocol the tab serves today. It is a new kind of *device*, and the design treats it as one wherever it can: the same Repo, the same data extensions, the same upload connector, the same key flows.

## 2. Scope (the decision that sizes everything else)

**This design is for a host that keeps its disk: one long-lived process, one database directory, on a machine that stays up** (a home server, a small VPS, a Mac that does not sleep).

It protects against: a plaintext upload to an encrypted workspace; a headless write that skips mutators or processors; a data migration run from the host; two processes on one database; an agent reading the key through the agent surface.

It does not cover hosts that lose their disk (a cloud container that is reclaimed). That case needs a database snapshot that can be exported, published, restored and re-identified, and it is the origin of most of the hard invariants in the scoping notes this design started from (not in the repo). [§11](#11-deferred-hosts-that-lose-their-disk) says what was verified about it and why it is not in this design.

Where the *agent* runs stays open and is small: an agent anywhere can use a persistent host through the bridge protocol ([§12](#12-deferred-agents-that-run-somewhere-else)).

## 3. What already exists

- **The agent surface already runs under Node.** `scripts/agent-eval/host.ts` opens a `@powersync/node` database, builds a Repo with `staticDataExtensions`, and serves it through the real `startBridgeLoop` + `executeCommand` to the real relay (`packages/agent-cli/dist/server.js`), so the real `kmagent` and km MCP server drive it. **[read]** What it lacks is everything about being a device: no `db.connect()`, no sign-in, no key, a throwaway database.
- **The seam is one function.** `BridgeLoopOptions.execute(command)` (`src/plugins/agent-runtime/bridgeLoop.ts`); the tab and the eval host differ only in the options they pass. **[read]**
- **The relay does not care what registers.** A tab is an HTTP *client* of the relay; so is the eval host. `agent-dispatch`, `kmagent` and `km-mcp` reach whichever client lists their token. **[read]**
- **The upload connector is platform-neutral** apart from two build-time env reads and a Web Lock that degrades to a direct call where `navigator.locks` is absent (`src/services/powersync.ts`, `src/utils/webLock.ts`). **[read]**
- **The core data layer touches no browser global.** Repo, tx engine, mutators, processors and `internals/` have zero hits; the browser-bound files are the OPFS/VFS boot (`repoProvider.ts`, `localDbVfs.ts`), which a headless boot replaces, and storage-backed device state (mode pins, client id, the Supabase session), which reads `localStorage`. **[read]**
- **Workspace backfills refuse without a claim.** A Repo built with no `backfillCompletionClaim` refuses every backfill (`repo.ts`, "Absent ⇒ backfills refuse"), and the one production backfill is `trigger: 'operator'`. **[read]**

## 4. Measurements

Read-only queries against a live client:

| | |
|---|---|
| Blocks, all workspaces | about 1.18 M **[measured]** |
| Largest workspace | about 99% of them; roughly 65 MB of content and 28 MB of properties as plaintext **[measured]** |
| Local database file | about 6.3 GB, no free pages **[measured]** |
| Data behaviour contributed by installed extensions | property and type seeds only. Every mutator, same-tx processor, post-commit processor, invalidation rule, query and local-schema contribution in the live runtime comes from the kernel or a plugin already in `staticDataExtensions` **[measured]** |

Not measured, and needed before trusting the host on the real graph (slice 2): cold sync plus materialization time under Node; peak memory; the Node database size.

## 5. Shape

```
agent-dispatch ─┐                         ┌─ PowerSync service
kmagent ────────┼─ relay (server.js) ─ headless host ─┤
km-mcp ─────────┘        127.0.0.1                    └─ Supabase (auth, upload RPCs)
```

One daemon per graph, registered with the existing relay as a client, under its own profile and token. Nothing in `packages/agent-cli` or `packages/agent-dispatch` changes; they are pointed at the host's profile.

A daemon rather than a library each agent embeds, because the database is the unit of identity: PowerSync's client id lives in the file and write checkpoints are requested per client id (`powersync_client_id()`, `/write-checkpoint2.json?client_id=…`, in the SDK's `SqliteBucketStorage` and `AbstractStreamingSyncImplementation`). **[read]** One process owning one directory makes "two clients with one identity" unrepresentable, and a lock file on the directory enforces it.

The entry point is a composition root **outside `src/`** (`headless/`, beside `scripts/`), like the eval host: it composes core and plugins, so the kernel/plugin lint is untouched. It runs from a checkout with `vite-node`, as the eval host does; a bundled artifact is deferred until a host without a checkout needs one.

## 6. Boot

1. **Device storage.** Install a file-backed `localStorage` (one JSON file in the state directory, written atomically) before the app's module graph loads. It carries what a browser profile carries: the Supabase session, the mode pins, the app-level client id. A shim rather than injected storage: several modules read `localStorage`, the eval host already runs on an in-memory shim of the same shape, and threading a storage parameter through them buys nothing for a single-process host. `window` is provided once loading is done, as the eval shim does, because the mode-pin module looks for `window.localStorage`. **[read]**
2. **Sign in.** Restore the session from device storage and refresh it. No session, or a refused refresh: exit non-zero naming the `login` subcommand ([§7](#7-identity-and-secrets)).
3. **Open the database** in the state directory with `@powersync/node`, then run the shared client-schema initialisation ([§9](#9-code-changes)).
4. **Connect** with the production connector and the upload-mode clamp ([§8](#8-invariants), invariant 6).
5. **Unlock.** Once the configured workspace's row is local, run the existing `unlockWorkspaceWithKey` flow against its synced `wk_canary`, with the in-memory key store. It validates the key, pins the workspace `e2ee` and holds a non-extractable `CryptoKey`; the raw bytes are zeroed by the flow as they are today. **[read]** A wrong key exits non-zero with the flow's own reason.
6. **Build the Repo** only now, so the sync observer never sees the workspace locked: `new Repo({db, cache, user, syncObserverDeps})` with no backfill claim, the `staticDataExtensions` runtime, and the configured workspace active.
7. **Wait until settled**: first sync complete and the materialize backlog at zero (the numbers the `health` verb already reports). Only then register with the relay. Until then `whoami` shows no connected client and `agent-dispatch` claims nothing, which is its documented behaviour with no tab. **[read]**
8. **Shutdown** (SIGTERM): stop taking commands, let in-flight ones finish, `repo.awaitDeferredWork()`, wait a bounded time for the upload queue to empty, close. Whatever is still queued stays in `ps_crud` on disk and uploads on the next start, as on any device.

## 7. Identity and secrets

**Account. Recommended: a dedicated member account with the editor role, not the owner's session.** The credential on an unattended machine is then bounded by row-level security to one workspace, cannot delete or convert the workspace, and is revoked by removing a member. It also means the host has no second workspace to write to, which removes a class of question from the plaintext-upload invariant. Sync volume is not a reason either way: the other workspaces are about 1% of the blocks. **[measured]** Cost: rows the host writes carry the automation user's id beside the contributor attribution, and whatever per-user rows a member account mints on first open (not yet sized; slice 1 lists them). *Open, the owner's call.*

**Sign-in.** The app signs in by emailed code only (`signInWithOtp` / `verifyOtp` in `Login.tsx`). **[read]** So `headless login` is interactive once: email, typed code, session persisted to device storage. supabase-js refreshes in-process, and the rotated refresh token lands in the same file. **[reasoned]** A password or service credential would be a new auth surface for one host; not proposed.

**Workspace key.** Read once at start from a file the config names (mode 0600), handed to the unlock flow, never written elsewhere. No key-delivery endpoint: an endpoint that returns the key puts the key on a server, which is what end-to-end encryption exists to avoid, and a revocable token in front of it revokes nothing useful, since the host has already held plaintext. What is revocable is membership.

**The agent surface must not reach the secrets.** In a Node host, the `eval` verb runs with the daemon's OS privileges and could read the key file. The host therefore serves an **allowlist** of verbs ([§8](#8-invariants)), and `eval` is not on it. An agent with a shell on the same machine as the same OS user can still read the file; run the daemon as its own user if that matters. The owner has accepted the host holding key and plaintext, so nothing more is built for it.

## 8. Invariants

Each has the mechanism that holds it and the test that fails when the mechanism is deleted.

1. **Writes go through the data layer.** The host exposes only `executeCommand`, which writes through `repo.tx`. The verb allowlist excludes `eval`, and admits `sql` only when the protocol's own `isReadOnlyAgentCommand` says it is a read. *Test:* each refused verb, sent over the in-process bridge client, is refused; deleting its allowlist check makes a named test fail.
2. **Queued writes are durable and visible.** On a host that keeps its disk the upload queue survives a kill, so "a run is not done until uploaded" reduces to: shutdown drains, and `health` reports queue depth. This is deliberately weaker than "completion means acknowledged"; that stronger form belongs to hosts that lose their disk ([§11](#11-deferred-hosts-that-lose-their-disk)). *Test:* SIGTERM with a queued write exits only after the fake sink received it; SIGKILL then restart uploads it once.
3. **One identity per database.** A lock file in the state directory; the second process exits. The state directory is never copied to another machine: a new host does a cold sync. *Test:* a second boot on a held directory fails before opening the database.
4. **Snapshot export and stamping** (two invariants from the scoping notes) do not apply: there is no snapshot. Across code upgrades the database is migrated at open by the same idempotent `ensure*` steps a browser's is, because the initialisation is shared.
5. **No data migration from the host.** Structural: the Repo has no `backfillCompletionClaim`, so backfills refuse, and `run-backfill` is off the allowlist. Per-device derivation passes run as on any device. *Test:* a backfill requested on a Repo built the way the host builds it refuses; `workspaceBackfillRunner.test.ts` is where the absent-claim branch is exercised today, to be confirmed in slice 1.
6. **A plaintext upload to an encrypted workspace is impossible.** Three layers, the first two new:
   - `createPowerSyncConnector`'s `encryption` option becomes **required**. Today it is optional and defaults to plaintext pass-through. **[read]** Tests pass an explicit plaintext constant.
   - The host wraps the resolver's upload mode in a clamp typed `(workspaceId) => Promise<'e2ee' | 'hold'>` for an e2ee-configured host: the configured workspace answers `e2ee` or holds, every other workspace holds. `'none'` is not in the type. The resolver underneath is the production one, reading the same pin.
   - The server's ciphertext trigger stays as the backstop.

   No command is served before boot step 5 pins the workspace, so no write exists before the pin does. *Test:* with the clamp deleted and the pin absent, a queued write reaches the fake sink as plaintext; with it, the pass throws `UploadHeldError`.
7. **Attribution.** Unchanged code: `executeCommand` rebinds `repo.withTxContext({contributorId, contributorSource: 'agent'})` and refuses an unchosen contributor, and the contributors same-tx processor is in `staticDataExtensions`. **[read]** The owner's undo stacks hold only their own devices' local transactions, so a synced agent write is never on them. **[reasoned]**

**Verb allowlist.** The repo-only verbs: the reads (`sql` read modes, `get-block`, `get-subtree`, `view-*`, `backlinks`, `page`, `daily-note`, `search`, `comments`, `recent-changes`, `block-history`, `data-model`, `resolve-block-id`, `list-contributors`, `health`, `ping`, `describe-runtime`), the block writes (`create-block`, `update-block`, `edit-block`, `move-block`, `delete-block`, `restore-block`, `append-markdown`, `reconcile-markdown-subtree`, `create-page`, `add-comment`, `create-contributor`) and `watch-events`. That covers everything `agent-dispatch` calls and every `km-mcp` tool except media. **[read]** An allowlist, so a verb added later is refused until someone decides it is safe here.

**Not served, and why:** `eval` (privileges); the extension install/enable verbs (they compile through the page's importmap and blob URLs); `run-action` (handlers assume UI state); `run-backfill`; `add-media` / `read-media` (the byte lanes are OPFS- and app-effect-driven; a real gap, deferred).

## 9. Code changes

**Core (`src/`, no plugin imports):**
- *One owner for client-schema initialisation.* `initializeClientSchema` and the backfill sequence after it live in `repoProvider.ts`, which imports `@powersync/web` at module level, and `createTestDb.ts` re-states the same sequence by hand. Move both the DDL sequence and the raw-table schema into a platform-neutral module that `repoProvider`, `createTestDb` and the host all call. This deletes a duplicate that can already drift.
- `createPowerSyncConnector`: `encryption` required.
- *Seed completeness.* Eleven static plugins register property or type seeds only on the app side **[measured]**, so a data-only runtime does not know those definitions. Move those seeds into data extensions and pin with a test that the app runtime's seed set equals the data runtime's.

**New, outside `src/`:** `headless/` with the entry point, device storage, boot, `login`, the verb allowlist and the upload clamp. The eval host's shims and bridge-loop wiring move here and the eval host becomes "the headless host over a fixture database with no sync", so Node hosting has one owner. The host also wires `watchEventsRegistry.setTransport`, which today only `bridge.ts` does, so `watcher-settled` events reach `agent-dispatch`. **[read]**

**Untouched:** `packages/agent-cli`, `packages/agent-dispatch` (a README note on the headless profile), Supabase, the sync rules.

**Installed extensions.** They cannot load in Node today (Babel plus blob-URL imports through the page importmap). **[read]** Sized: on the real graph they contribute seeds only. **[measured]** Their definitions are also blocks in the workspace, and the registry already has a status for "this device cannot build the codec" (`behavior-unavailable`). **[read]** Slice 3 verifies that an agent write to such a property is refused or stored under the synced definition, never re-typed. If an installed extension ever ships a processor, the host must refuse writes it would have processed; that check is not built until one exists.

## 10. Failure and recovery

| Failure | What happens | Recovery |
|---|---|---|
| Killed mid-upload | The queue is on disk; the connector's ambiguous-attempt handling is unchanged | Restart |
| Session refresh refused | Boot exits non-zero; queue stays on disk | `headless login`, restart |
| Wrong or missing key | Boot exits before any command is served | Fix the key file |
| Server says e2ee, pin missing | Clamp holds uploads; materialization defers | Unlock runs at next boot |
| Corrupt or suspect database | Refuse to boot; never auto-wipe a database with a non-empty queue | Inspect the queue, then delete the directory and cold-sync |
| Host off for weeks, then started with queued writes | They upload, as from a laptop that was closed | None; the queue holds only what agents wrote just before the stop |
| Membership removed | Sync and uploads fail; queued writes go through the existing rejection path **[reasoned]** | Re-add, or discard the directory |

## 11. Deferred: hosts that lose their disk

Not designed, and recommended against until a persistent host is shown not to be enough. What a snapshot would have to carry is a 6 GB file **[measured]** holding plaintext, whole-file encrypted, stored somewhere never public, refreshed by something, downloaded at each fresh start. On top of that: export only with an empty queue and no open transaction; a stamp of schema and app version; a restore that mints a new PowerSync client id (the id is in the file **[read]**; that resetting it is sufficient is **[reasoned]**); the app-level client id and device storage reset with it; and a way to deliver the key into the container. Each is permanent machinery for one hosting choice.

If it is ever needed, the host in this document is the thing that would produce and consume the snapshot, so nothing here is wasted.

## 12. Deferred: agents that run somewhere else

An agent in a cloud session needs the bridge, not the database. The relay speaks HTTP with `Authorization: Bearer`, and already has a guarded switch for listening beyond loopback (`AGENT_RUNTIME_ALLOW_NETWORK`). **[read]** Behind a TLS tunnel, the agent's credential is a revocable bearer token for one host name, which is exactly the shape a header-injecting secret proxy supports, and neither the workspace key nor the database ever enters the remote machine. This needs its own short design (exposure, token scope, rate limits) and is the natural second step after slice 4.

## 13. Slices

1. **Host skeleton on a scratch plaintext workspace.** The shared schema initialisation, device storage, `login`, connect, the allowlist with reads only, and an upload mode that always holds, so nothing can leave the device. List every row a first boot writes locally.
2. **Unlock, then the real graph, still read-only.** Measure cold sync, memory and file size. Compare `health` counts and a sample of `view-*` outputs with a tab's.
3. **Writes on a scratch e2ee workspace.** The clamp, the write verbs, contributor attribution, shutdown drain, the missing-seed write check, and a parity test: one command sequence against a tab-shaped and a host-shaped runtime yields identical rows.
4. **The real graph, with `agent-dispatch` pointed at the host's profile.** Dispatch runs only there, so the claim race it documents does not widen.

## 14. Open questions

- **Host** ([§2](#2-scope-the-decision-that-sizes-everything-else)): is a machine that stays up acceptable as the first host?
- **Account** ([§7](#7-identity-and-secrets)): dedicated member, or the owner's session?
