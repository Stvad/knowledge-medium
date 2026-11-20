# Headless client

> **Status:** design draft, nothing built. Last verified against code: 2026-11-19, against master `9c86a3ddc2c`. Code wins where they differ.
> Each claim is tagged **[read]** (seen in the code), **[measured]** (a read-only query against a live client that day) or **[reasoned]** (inferred, to be verified in the slice named beside it).

## 1. Goal

Run the data layer and the agent surface with no browser tab, so `agent-dispatch`, `kmagent` and `km-mcp` work when no device has the app open.

A headless client is a Node process that signs in, syncs, decrypts and materializes like a device, and serves the bridge protocol the tab serves today. It is a new kind of *device*, and the design treats it as one wherever it can: the same Repo, the same data extensions, the same upload connector, the same key flows.

## 2. Scope

**A host that keeps its disk: one long-lived process, one database directory, on a machine that stays up.** Owner decisions, 2026-11-19: persistent hosts first; transient containers are wanted eventually, so this design must not foreclose them ([§12](#12-later)); the host signs in as a dedicated member account.

It protects against: a plaintext upload to an encrypted workspace; a headless write that differs from the same write made in a tab; a workspace backfill run from the host; two processes on one database; an agent reading the key through the agent surface; a host that keeps accepting writes it can no longer upload.

It does not cover hosts that lose their disk. That case needs a database snapshot that can be exported, restored and re-identified, and is where most of the hard requirements in the scoping notes for this design came from.

## 3. What already exists

- **The agent surface already runs under Node.** `scripts/agent-eval/host.ts` opens a `@powersync/node` database, builds a Repo with the data extensions, and serves it through the real `startBridgeLoop` + `executeCommand` to the real relay (`packages/agent-cli/dist/server.js`), so the real `kmagent` and km MCP server drive it. **[read]** It has no `db.connect()`, no sign-in, no key, and a throwaway database built by test factories.
- **The seam is one function**, `BridgeLoopOptions.execute(command)` in `src/plugins/agent-runtime/bridgeLoop.ts`. **[read]**
- **The relay does not care what registers.** A tab is an HTTP client of the relay, and so is the eval host. **[read]**
- **The core data layer touches no browser global** beyond a few guarded reads. The browser-bound files are the OPFS boot (`repoProvider.ts`, `localDbVfs.ts`) and storage-backed device state (mode pins, client id, the Supabase session). **[read]**
- **Workspace backfills refuse without a claim**, on the operator path and the runner alike, and the one production backfill is `trigger: 'operator'`. **[read]**
- **A Repo can be read-only.** `isReadOnly` / `setReadOnly` reject content writes, and the seed scheduler short-circuits on it. **[read]**
- **Rows staged before a Repo exists are not lost**: triggers capture them durably and the observer drains the backlog when it starts. **[read]**

## 4. Measurements

Read-only queries against a live client:

| | |
|---|---|
| Blocks, all workspaces | about 1.18 M **[measured]** |
| Largest workspace | about 99% of them; roughly 65 MB of content and 28 MB of properties as plaintext **[measured]** |
| Local database file | about 6.3 GB, no free pages **[measured]** |
| Data behaviour contributed by installed extensions | property and type seeds only. Every mutator, processor, invalidation rule, query and local-schema contribution in the live runtime comes from the kernel or a plugin already in `staticDataExtensions` **[measured]** |

Not measured, and needed before trusting the host on the real graph (slice 2): cold sync plus materialization time under Node, peak memory, the Node database size.

## 5. Shape

```
agent-dispatch ─┐                         ┌─ PowerSync service
kmagent ────────┼─ relay (server.js) ─ headless host ─┤
km-mcp ─────────┘        127.0.0.1                    └─ Supabase (auth, upload RPCs)
```

One daemon per graph, registered with the existing relay as a client, under its own profile and token. `agent-dispatch`, `kmagent` and `km-mcp` are pointed at that profile and are otherwise unchanged.

A daemon rather than a library each agent embeds, because the database is the unit of identity: PowerSync's client id lives in the file and write checkpoints are requested per client id (`powersync_client_id()`, `/write-checkpoint2.json?client_id=…` in the SDK). **[read]** One process owning one directory makes "two clients with one identity" unrepresentable.

The entry point lives in **`scripts/headless/`**. `scripts/` is already typechecked with Node types, already exempt from the kernel/plugin lint as a consumer above both layers, and already has tests in the gate (`scripts/agent-eval`). **[read]** It runs from a checkout with `vite-node`; a bundled artifact waits for a host without a checkout.

## 6. The app shell's duties

A tab is safe to write from because the app shell around the Repo does several things. The host has no shell, so each duty needs an owner. This table is the design's centre: every row is something a Repo alone does not do.

| Duty | In a tab | In the host |
|---|---|---|
| Persist the session | supabase-js writes `localStorage`, which it uses only when `window` and `document` both exist at client construction **[read]** | The client is given its auth storage explicitly ([§10](#10-code-changes)); without that the session lives in memory and every restart needs a new emailed code |
| Hold device state (mode pins, client id) | `localStorage` | The same file-backed storage, installed as `localStorage` before the app graph loads |
| Gate writes on access | Bootstrap sets `repo.setReadOnly(role === 'viewer')` and an effect re-applies it when the role changes **[read]** | The Repo is **born read-only**. It becomes writable only when the host's own member row says editor or owner, and goes back the moment it does not, including when the row disappears |
| Hold writes until the workspace is usable | The key gate runs before bootstrap's writes | Read-only until unlocked, settled and ready (below) |
| Make writes come out the same | Bootstrap awaits `whenPropertyDefinitionsReady` and resolves the alias-seat and property-child namespaces, which an encrypted workspace needs `K_id` for; a writer that runs first leaves out an alias seat or gives a property row a random id **[read]** | The same steps, from one shared function ([§10](#10-code-changes)), **awaited** before the Repo is made writable |
| Defer catch-up work off startup | `requestIdleCallback` | Absent in Node, where deep-idle work runs at once **[read]**; read-only is what holds it back, not idleness |
| Pick up new code | Tabs reload on deploy | Nothing reloads a daemon. The host is in the drain set ([§9](#9-failure-and-recovery)) |
| Surface rejected uploads | The system-status UI reads `ps_crud_rejected` | `health` reports the rejected count; the host logs it at boot and on change |

## 7. Boot

1. **Lock** the state directory with the pidfile helper `agent-dispatch` already has (stale-pid detection, so a SIGKILL does not block the restart). **[read]**
2. **Device storage.** Install the file-backed storage as `localStorage` and as the auth-storage override, before the app's module graph loads. `window` is provided after loading, as the eval shim does, because the mode-pin module looks for `window.localStorage`. **[read]**
3. **Sign in.** Restore and refresh the session. None, or a refused refresh: exit non-zero naming the `login` subcommand.
4. **Open the database** and run the shared client-schema initialisation.
5. **Refuse a stale queue.** If `ps_crud` is non-empty and the host last ran more than a day ago (a heartbeat it keeps in device storage), exit unless started with an explicit flag. A weeks-old agent patch would overwrite whatever a person wrote since, because server patches are last-write-wins by arrival. **[read]** The flag is the operator's decision; nothing is discarded either way.
6. **Unlock before connecting, whenever the workspace row is already local** (every boot but the first, when the queue is empty by construction). Run the existing `unlockWorkspaceWithKey` flow against the synced `wk_canary`, into the process-wide key store (`getWorkspaceKeyStore()`, which falls back to memory with no IndexedDB). **[read]** A wrong key exits non-zero with the flow's own reason. On the first boot: connect, wait for the row, then unlock.
7. **Connect** with the production connector and resolver.
8. **Build the Repo, read-only**: `new Repo({db, cache, user, syncObserverDeps, isReadOnly: true})` with no backfill claim, the `staticDataExtensions` runtime, and the configured workspace active. Not through `createTestRepo`, which installs a working stand-in claim. **[read]**
9. **Wait until settled**: `onSyncSettled` (`src/data/internals/firstSync.ts`; `onFirstSync` never fires offline) and a materialize backlog of zero.
10. **Become writable** if the role allows: run the shared write-readiness function, then `setReadOnly(false)`. Seed materialization now runs against a fully materialized workspace, where it finds its definitions already present. **[reasoned]**; invariant 4's test pins it.
11. **Register with the relay.** Until this step `whoami` shows no connected client and `agent-dispatch` claims nothing, its documented behaviour with no tab. **[read]**
12. **Shutdown** (SIGTERM): deregister, let in-flight commands finish, `repo.awaitDeferredWork()`, wait a bounded time for the upload queue to empty, close. Queued writes stay in `ps_crud` on disk.

Slices 1 and 2 stop at step 9: a read-only Repo queues nothing, so nothing can leave the device.

## 8. Identity, secrets, invariants

**Account: a dedicated member with the editor role** (owner decision). The credential on an unattended machine is bounded by row-level security to the workspaces it is a member of, cannot change ownership, convert the workspace or flip its `properties_migration` mode, and is revoked by removing the member. **[read]** It can still do everything a writer can, including deleting blocks. Per-user rows are minted only app-side, so the host creates none. **[read]** The account may own a personal workspace if it ever opened the app; that workspace is never pinned, so nothing materializes in it and nothing can be written to it. **[read]** The invitation is accepted once, in a browser or by `login` calling the same RPC (slice 1 settles which).

**Sign-in.** The app offers an emailed code or an anonymous session. **[read]** `headless login` uses the emailed code, once, interactively. A password or service credential would be a new auth surface for one host; not proposed.

**Workspace key.** Read once at start from a file the config names (mode 0600), handed to the unlock flow, which zeroes the bytes. **[read]** No key-delivery endpoint: it would put the key on a server, which is what end-to-end encryption exists to avoid, and the revocable thing is membership.

**Invariants.** Each has its mechanism and the test that fails when the mechanism is deleted.

1. **Writes go through the data layer, and only served verbs run.** The host serves an allowlist ([below](#verbs)). *Test:* every `KnownCommandType` is classified served or refused in `scripts/headless/`, so a verb added to the protocol fails the test until someone decides; each refusal has a named test.
2. **The host never accepts a write it cannot upload.** Read-only tracks the member row. *Test:* with the member row set to viewer, then removed, a write verb is refused; deleting the role subscription makes it succeed locally.
3. **One identity per database.** The pidfile lock. The state directory is never copied to another machine. *Test:* a second boot on a held directory exits before opening the database.
4. **No workspace backfill from the host.** The Repo has no claim, so backfills refuse, and `run-backfill` is not served. Seed materialization is *not* covered by that claim: it creates or restores definition blocks through `repo.tx` on any device that opens a workspace writable, with deterministic ids and insert-or-touch on the server. **[read]** It is allowed, and bounded by step 10. *Test:* a first writable open against an already-seeded workspace leaves `ps_crud` empty.
5. **A plaintext upload to an encrypted workspace is impossible.** The production resolver already decides this from the pin, and review found no path around it. **[read]** Two hardenings, both labelled defence in depth: `createPowerSyncConnector`'s `encryption` option becomes required (today it defaults to plaintext pass-through **[read]**; three call sites), and a create or patch with no `workspace_id` throws instead of passing through unsealed (unreachable today, since the upload trigger always sets it **[read]**). The host adds a clamp typed `'e2ee' | 'hold'` over the resolver's answer; `'hold'` for any other workspace cannot be reached, since nothing materializes there, and a held write at the head of the queue also stops downloads, so `health` names it. *Test:* with the clamp deleted and the pin absent, a queued write reaches the fake sink as plaintext.
6. **Attribution.** Unchanged code: with the contributors processor in the runtime (it is in `staticDataExtensions`), `executeCommand` rebinds `repo.withTxContext({contributorId, contributorSource: 'agent'})` and an unchosen contributor is refused. **[read]** A synced agent write is never on another device's undo stack. **[reasoned]**

<a id="verbs"></a>**Served:** the reads (`sql` when `isReadOnlyAgentCommand` says so, `get-block`, `get-subtree`, `view-*`, `backlinks`, `grouped-backlinks`, `page`, `daily-note`, `search`, `comments`, `recent-changes`, `block-history`, `data-model`, `resolve-block-id`, `list-contributors`, `health`, `ping`, `describe-runtime`, `runtime-summary`), the block writes (`create-block`, `update-block`, `edit-block`, `move-block`, `delete-block`, `restore-block`, `append-markdown`, `reconcile-markdown-subtree`, `create-page`, `add-comment`, `create-contributor`) and `watch-events`. That covers what `agent-dispatch` calls and every `km-mcp` tool except media. **[read]**

**Refused:** `eval` (it runs with the daemon's OS privileges and could read the key file); the extension verbs and `audit-extension` (they compile through the page's importmap and blob URLs); `run-action` / `action`; `run-backfill`, `rematerialize-workspace`, `audit-properties`; `add-media` / `read-media` (the byte lanes are OPFS- and app-effect-driven; a real gap).

An agent with a shell on the same machine as the same OS user can still read the key file; run the daemon as its own user if that matters.

## 9. Failure and recovery

| Failure | What happens | Recovery |
|---|---|---|
| Killed mid-upload | The queue is on disk. Delivery is at-least-once: creates are insert-or-skip, a replayed patch re-applies the same columns **[read]** | Restart |
| Killed between a write and its post-commit processor | Derived columns such as parsed references stay underived until the block is next edited; content is intact. Same as a tab closed at that moment **[read]** | None; accepted |
| Session refresh refused | Boot exits non-zero; the queue stays on disk | `headless login`, restart |
| Wrong or missing key | Boot exits before any command is served | Fix the key file |
| Demoted to viewer, or membership removed | The Repo goes read-only at once; writes already queued are rejected by row-level security into `ps_crud_rejected`, which `health` reports. They exist locally and were never synced | Restore the role. The rows stay quarantined in the host's database; the retry the app's status UI offers is not served by the host yet, and slice 3 decides whether to serve it |
| Non-empty queue after more than a day down | Boot exits (step 5) | Restart with the flag, after looking at what is queued |
| Corrupt or suspect database | Refuse to boot; never auto-wipe a database with a non-empty queue | Inspect the queue, then delete the directory and cold-sync |
| Timers armed at shutdown | `awaitDeferredWork` does not cover them (the orphan-alias cleanup is armed for 4 s **[read]**); the host waits out the longest before closing | — |

**Deploys.** Nothing gates an old client: there is no minimum-version check, and an unknown `properties_migration` mode parses as `'cell'`, so an old daemon would write cell-shaped properties into a workspace that had moved on. **[read]** The host is therefore in the drain set, with no new machinery: before a deploy that changes schema, codecs, seeds or the migration mode, stop the host with an empty queue, update the checkout, start it. `health` reports the checkout's commit so the running version is visible.

## 10. Code changes

**Core (`src/`, no plugin imports), each an extraction or a strictness change:**
- *Client-schema initialisation* (`initializeClientSchema` and the backfill sequence after it) moves out of `repoProvider.ts`, which imports `@powersync/web` at module level, into a platform-neutral module beside `clientSchema.ts`. `createTestDb.ts` re-states the same sequence by hand with a different statement list; converging it is separate work, to be filed.
- *Resolver and connect wiring* (`resolverForUser`, the connect options) moves out of `repoProvider.ts` the same way, so the host connects with the production resolver rather than a copy.
- *Write readiness*: the data-relevant steps of `bootstrapWorkspace` (definitions ready, the two namespace resolves) become one function that the tab bootstrap and the host both call. The tab keeps not awaiting the resolves, for its IndexedDB-hang reason; the host awaits.
- *Auth storage*: `services/supabase.ts` passes `auth.storage` from an override a leaf module holds, unset in browsers, so `createClient` behaves there exactly as today.
- `createPowerSyncConnector`: `encryption` required; a create or patch without `workspace_id` throws.
- `health` reports the rejected-upload count.

**New, in `scripts/headless/`:** entry point, device storage (a small write-temp-then-rename helper; `agent-dispatch`'s `atomicFile.ts` is exclusive-create, not this), boot, `login`, verb classification, the role subscription, the clamp. Shared with the eval host: the shims and a small `serveBridge` helper around `startBridgeLoop`; the eval host itself stays as it is. The host wires `watchEventsRegistry.setTransport`, which today only `bridge.ts` does, so `watcher-settled` events reach `agent-dispatch`. **[read]**

**Config and processes.** One config file: state directory, workspace id, expected encryption mode, key-file path, relay profile. The relay URL and secret come from the same `agent-cli` config the relay itself reads, since both run on one machine. **[reasoned]** The host mints its relay token on first start and keeps it in the state directory. Who supervises the relay beside the daemon (launchd or systemd units for both) is settled in slice 1.

**Seeds.** Eleven static plugins register seeds only on the app side **[measured]**, and installed extensions cannot load in Node (Babel plus blob-URL imports **[read]**), so the host's seed set is narrower than a tab's. Whether that matters is slice 3's first check: a write to a property whose seed the host lacks must be refused or stored under the synced definition, never re-typed. Only if that fails do the static seeds move into data extensions. Whether the host needs `kernelValuePresetsExtension`, which the eval host adds and which lives in a React module, is settled in slice 1.

**Untouched:** `packages/agent-cli`, `packages/agent-dispatch` (a README note on the headless profile), Supabase, the sync rules.

## 11. Slices

1. **Read-only host on a scratch plaintext workspace.** The extractions, device storage with a test that a token refresh rewrites the file, `login`, lock, boot to step 9, the read verbs.
2. **Unlock, then the real graph, still read-only.** Measure cold sync, memory and file size. Compare `health` counts and a sample of `view-*` outputs with a tab's.
3. **Writes on a scratch encrypted workspace.** The missing-seed check first; then steps 10–12, the role subscription, the write verbs, attribution, and a parity test: one command sequence against a tab-shaped and a host-shaped runtime yields identical rows.
4. **The real graph.** Stop the tab-pointed `agent-dispatch` first, then point it at the host's profile. Dispatch runs only there, so the claim race it documents does not widen.

## 12. Later

Two different things get called a transient container.

**A transient agent with a persistent client.** The container runs the agent and reaches the host over the bridge. The relay speaks HTTP with `Authorization: Bearer` and has a guarded switch for listening beyond loopback (`AGENT_RUNTIME_ALLOW_NETWORK`). **[read]** Behind a TLS tunnel the agent's credential is a revocable bearer token for one host name, and neither the key nor the database enters the container. This needs its own short design (exposure, token scope, rate limits) and should be tried first.

**A transient client.** The container itself syncs and decrypts, so it starts from a saved database or pays a cold sync. A snapshot is a 6 GB file **[measured]** holding plaintext, whole-file encrypted, stored somewhere never public, refreshed by something and downloaded at each fresh start. It also needs: export only with an empty queue and no open transaction; a schema and app version stamp; a restore that mints a new PowerSync client id (resetting it being sufficient is **[reasoned]**) and resets device storage; completion defined as "uploaded and acknowledged", because a reclaimed container loses its queue; and a way to deliver the key.

What this design keeps open for it at no cost: the state directory is the whole device, so a snapshot is that directory; boot is "open what is there, then sync", so a restore is the same boot; the host is the only writer of its directory, so it is the only thing that could export it consistently; settled-ness is already something the host waits on. Slice 2's measurements decide how much of the snapshot path is worth building.

## 13. Still open

Each is assigned above: cold sync time, memory and file size under Node (slice 2); the missing-seed write behaviour (slice 3); invitation acceptance, relay supervision and `kernelValuePresetsExtension` (slice 1).
