# E2EE rollout — deploy notes

Deployment ordering for the per-workspace E2EE groundwork (see
[`e2ee-design.html`](./e2ee-design.html); landed in PR #56). Read this before
applying the migration to a shared environment.

## The one hard rule

**Do not enable E2EE-workspace *creation* in an environment before BOTH the
Phase D encrypt-on-upload transform AND the Layout B cutover (blocks stream
retargeted to `blocks_synced` + the observer) ship there.**

Creating an e2ee workspace before either side is ready breaks in two distinct
ways:

- **Upload side.** `blocks_require_ciphertext_for_e2ee` (in
  `supabase/migrations/20260529120000_add_e2ee_workspace_columns.sql`) rejects
  any block write to an `encryption_mode = 'e2ee'` workspace whose content
  columns aren't well-formed `enc:v1:` ciphertext. Until the client encrypts on
  upload, writes go up as plaintext, get rejected, and the PowerSync upload
  queue **jams** for that client. The trigger failing closed is the point —
  better a stuck queue than plaintext on the server.

- **Download side.** Until the cutover, the generated sync rule still selects
  `FROM public.blocks`, so PowerSync applies downloaded rows to the live
  `blocks` raw table. For an e2ee row the content columns are `enc:v1:` strings,
  so `properties_json` / `references_json` are no longer JSON — and the existing
  `blocks` row-event / snapshot triggers call `json(NEW.properties_json)`, which
  raises *malformed JSON* and **fails the sync apply** before the row even
  lands. Layout B is precisely what fixes this: ciphertext lands in
  `blocks_synced` (which carries no such triggers), and the observer decrypts
  into `blocks`. So the cutover is a prerequisite for e2ee creation, not just
  the uploader.

This is why we coordinate the deploy instead of adding a temporary "`'none'`
only" gate to the `create_workspace` RPC (we're in alpha; coordination is
cheaper than code we'd rip out — see the resolved review threads on PR #56).

## Why this is safe to land now anyway

- The schema is backward-compatible on its own: `encryption_mode` defaults to
  `'none'` and `wk_canary` is nullable, so existing plaintext writes are
  unaffected. The ciphertext trigger only fires for e2ee workspaces, of which
  there are **none** until one is deliberately created.
- No shipping client path creates an e2ee workspace: `create_workspace`'s e2ee
  params default to `'none'`, and the create/paste UX is a later phase. The only
  way to make one today is a hand-crafted RPC call.

So the safe window is automatic — but the rule above must hold until Phase D.

## Deploy order

1. **Apply the Supabase migration**
   (`20260529120000_add_e2ee_workspace_columns.sql`). Safe in isolation;
   existing plaintext workflows keep working.
2. **Deploy the PowerSync sync rules** so clients receive the new `workspaces`
   columns (`encryption_mode`, `wk_canary`). `powersync/sync-config.yaml` is a
   generated file — regenerate with `yarn gen:sync-config` (sourced from the TS
   column lists in `src/data/blockSchema.ts` + `src/data/workspaceSchema.ts`)
   and deploy the result to the PowerSync instance. Must come **after** step 1,
   since the rules reference columns that have to exist first. (Schema change
   without the sync-rule deploy = clients never see the new columns.) The Layout
   B cutover later adds its own sync-rule change — retargeting the blocks stream
   to `blocks_synced` — which is a separate, coordinated deploy.
3. **Deploy the client.** Only once BOTH the Phase D encrypt-on-upload transform
   and the Layout B cutover are present in the deployed client (and the
   retargeted sync rules are live) should any path create an e2ee workspace.

## Cutover hygiene: pre-existing `blocks` rows aren't reconciled

The Layout B cutover takes `blocks` out of the client's `withRawTables`
(`repoProvider.ts`) — PowerSync stops managing `blocks` and starts managing the
new `blocks_synced` staging table, which the observer materializes into `blocks`.
The local DB filename is unchanged (`kmp-v6`), so an upgrading client keeps the
`blocks` rows PowerSync wrote under the old mapping.

That swap does **not** reconcile the pre-existing `blocks`. The fresh
`blocks_synced` hydration upserts the *current* sync set into `blocks` (so
everything you still have access to refreshes correctly), but the observer only
*deletes* a `blocks` row when `blocks_synced` emits a DELETE — which can't happen
for an id that was never staged. So a row lingers as a local "ghost" iff **all**
of:

- it was in `blocks` before the upgrade, **and**
- it left the user's sync set — `workspace_id IN user_workspaces`, i.e.
  `delete_workspace` / `remove_workspace_member`, **not** a soft-delete (those
  sync fine as `deleted=1` rows), **and**
- the client's first sync carrying that removal landed on the **new** build,
  never the old one (offline/closed across the removal+upgrade, or upgraded
  before reconnecting). If the old build synced the removal first, PowerSync
  scrubbed `blocks` normally — no ghost.

Steady-state revocation on the new build is already handled (the row drops from
`blocks_synced` → DELETE trigger → observer removes it; see `materialize.ts`).
**The hole is only the upgrade boundary.**

Impact is local-only and bounded. The ghost is a `deleted=0` row, so it stays in
the derived indexes (`blocks_fts` search, `block_aliases`, `block_types`) and is
visible/editable; edits to it are **rejected** server-side and quarantined in
`ps_crud_rejected` (they never sync). No corruption, no data loss, no effect on
other clients. For a revoked shared workspace it's a local-retention wart — you
keep readable copies past the point steady-state sync would have scrubbed them.

We handle this with migration hygiene, **not code** — a robust reconciliation
would have to wait for full `blocks_synced` hydration *and* exclude un-uploaded
local rows (pending `ps_crud`, or it deletes the user's offline edits), which is
more failure surface than this narrow corner warrants (Codex P2 on PR #56, on
the `repoProvider.ts` raw-table swap):

1. **Don't delete workspaces or remove members during the cutover rollout
   window.** The bug requires a set-shrink; if none happens while clients are
   straddling the swap, no ghosts can form. Trivially controllable at alpha
   scale.
2. **Clean-slate escape hatch (deliberate, not the default).** If a
   guaranteed-clean local state is required, bump the DB filename version in
   `repoProvider.ts` (`kmp-v6` → `kmp-v7`) to force a fresh local DB + full
   re-sync. This **orphans local-only state — including the `row_events` change
   history** — so take it consciously, not as a free reset.
3. **Manual recovery if a ghost is seen post-cutover.** Clear that user's local
   PowerSync storage (or bump the version per #2) to force a clean re-sync. A
   one-time reconciliation (`DELETE FROM blocks` for ids absent from
   `blocks_synced` after first full sync, excluding pending-upload ids) could
   automate this later if it ever shows up in practice.

This only bites at the **full cutover** (all clients on the observer, old
`blocks` stream dropped). The dual-run validation phase doesn't hit it — it runs
on the maintainer's own account with no membership changes.

## If the queue jams anyway

If an e2ee workspace gets created before the uploader exists and a client's
upload queue stalls on the ciphertext trigger: no real e2ee data can exist yet,
so the recovery is to delete that workspace server-side (and any rejected
pending rows). Don't relax the trigger to drain the queue — that would defeat
its purpose.
