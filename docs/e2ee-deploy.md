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

## If the queue jams anyway

If an e2ee workspace gets created before the uploader exists and a client's
upload queue stalls on the ciphertext trigger: no real e2ee data can exist yet,
so the recovery is to delete that workspace server-side (and any rejected
pending rows). Don't relax the trigger to drain the queue — that would defeat
its purpose.
