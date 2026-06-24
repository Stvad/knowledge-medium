# Subtree sharing in the E2EE world — design options

> **Status:** unverified (design exploration, 2026-06-24). E2EE seams, RLS, and grants verified against code (§11); media and §13-hierarchy facts verified against *design-only* docs as noted in §11, not code. This is a *new* doc; it does **not** replace [`subtree-sharing.md`](subtree-sharing.md), which remains the canonical write-up of the **access-control plane** for a non-encrypted world. This doc layers the **key-access plane** on top and revises the parts of the old design that assumed a plaintext-reading server. Where the two disagree, prefer this doc for anything touching encryption and the old doc for the RLS / `effective_share_ids` mechanics it still owns.

---

## 0. TL;DR

- **Sharing splits into two independent planes.** *Access control* — "which ciphertext rows may a recipient fetch" — is crypto-agnostic, and the old `subtree-sharing.md` *schema and sync-stream mechanics* carry over essentially unchanged (its RLS **structure** carries over too, but the `blocks_read` predicate must be *revised* to a membership-OR-share **union** — §3.1). *Key access* — "can the recipient decrypt those rows" — is the genuinely new problem and the only thing e2ee changes. Keeping these planes separate is the central idea of this doc. (Note: the access-control *mechanics* survive, but several server-plaintext *features* built on them — the snapshot RPC, server-rendered reference labels, anonymous read-only links — do **not** survive e2ee; see §4.)
- **The crux is a granularity conflict.** E2EE today is **one symmetric Workspace Key (WK) per workspace** ([`src/sync/transform.ts`](../src/sync/transform.ts), [`src/sync/keys/`](../src/sync/keys/)). Sharing wants **per-subtree** confidentiality. A single key cannot, by itself, express "you may read this subtree but not its siblings." Everything below is a way to resolve that conflict, each with a different cost.
- **The fetch boundary is RLS, not the sync stream.** `public.blocks` is reachable by direct PostgREST `SELECT` (`GRANT ALL ON blocks TO anon, authenticated`, [migration:1106](../supabase/migrations/20260510222352_consolidated_initial.sql)), and the *shipped* `blocks_read` policy is `is_workspace_member(workspace_id, …)` with **no subtree predicate** ([migration:626](../supabase/migrations/20260510222352_consolidated_initial.sql)). So a workspace member can already fetch every block in the workspace; the PowerSync stream only narrows what *auto-syncs*, not what a holder *can* fetch. This single fact determines what handing over a key actually exposes (§3).
- **A whole-workspace e2ee share already ships.** Per [`src/sync/keys/flows/shareWorkspace.test.ts`](../src/sync/keys/flows/shareWorkspace.test.ts), making a *workspace member* share an encrypted workspace needs no new crypto: invite (plaintext membership metadata) + send the WK out of band + the member unlocks via the existing key-required gate (the canary is workspace-scoped, so an owner-minted WK validates for a different user). There is **no `shareWorkspace()` function** — the mechanism is `createEncryptedWorkspace` + `unlockWorkspaceWithKey` + the workspace-scoped canary; `shareWorkspace.test.ts` only *demonstrates* the canary property. Subtree sharing is the question of going **finer** than whole-workspace.
- **Recommendation (§7): a phased hybrid that does not over-promise.** Ship the crypto-agnostic access-control plane so it fully works on **plaintext** workspaces (the old design). For **e2ee** workspaces, v1 offers only honest, low-crypto-risk paths: **(D)** *export-to-plaintext* for read-only/public/anonymous links (a deliberate declassification), and an **add-collaborator** affordance that is simply the *already-shipped whole-workspace share*, with a **manual second e2ee workspace (E)** as the clean path when the collaborator should be confined to a confidential subtree. (Option B's construction — whole WK + RLS-scoped subtree — is documented below but shipped in **no** form, because it implies a confidentiality wall that does not exist.) We explicitly **do not** ship confidential subtree sharing on e2ee (Option C) in v1 — that is the marquee capability and the central product bet (§7) — because it needs a new key domain or a re-encryption relay plus the deferred e2ee §13 hierarchy. There is no anonymous link that keeps bytes encrypted until C ships; the only v1 anonymous e2ee "share" is D, which gives up encryption for that copy.

---

## 1. What changed since `subtree-sharing.md`

`subtree-sharing.md` (2026-04-27) predates three things:

1. **E2EE shipped** (PR attributions in the e2ee doc; treat the *mechanisms*, not the PR numbers, as authoritative). It is real code, not a sketch:
   - The wire seam [`src/sync/transform.ts`](../src/sync/transform.ts) seals three columns — `content`, `properties_json`, `references_json` (`CONTENT_COLUMNS`) — independently with AES-256-GCM under a per-workspace key, keyed by a pluggable `getCek(workspaceId)` (`encodeForWire` / `decodeFromWire`). Ids, `workspace_id`, `parent_id`, and timestamps stay in clear (`WireBlockColumns`).
   - A server-side trigger `blocks_require_ciphertext_for_e2ee` ([`supabase/migrations/20260529120000_add_e2ee_workspace_columns.sql:201`](../supabase/migrations/20260529120000_add_e2ee_workspace_columns.sql)) *rejects* any plaintext write to an e2ee workspace's content columns — so the server provably never holds plaintext for those rows.
   - Per-column AAD already binds `[block_id, workspace_id, column_name, schema_version]` ([`src/sync/crypto/aad.ts`](../src/sync/crypto/aad.ts)) — note it binds the **block id**, not merely the workspace; this matters for Option C (§6.C).
   - Authority over a workspace's mode is a durable, locally-immutable **mode pin** ([`src/sync/keys/modePin.ts`](../src/sync/keys/modePin.ts)), keyed per `(user, workspace)` and set the moment a pasted WK validates against the workspace-scoped `wk_canary` ([`src/sync/crypto/canary.ts`](../src/sync/crypto/canary.ts)).
   - The whole design is **per-workspace, opt-in, one shared symmetric WK, no asymmetric crypto, no per-recipient wrapping** in v1. A passphrase/CEK/X25519 hierarchy is explicitly deferred to e2ee §13.

2. **Media-attachments design** (branch `claude/media-attachments-design`, `docs/media-attachments/design.html`, **off this branch and design-only — confirm before relying**). It extends the same model to bytes: content stored content-addressed at `<workspace_id>/HMAC(K_id, sha256(plaintext))` where `K_id = HKDF(WK, "km/asset-content-key/v1")`, sealed `encb:v1:` (AES-256-GCM under the WK). Storage-bucket RLS gates on the path's first segment (= `workspace_id`). It **explicitly defers** encrypted subtree sharing as "a non-goal for the foreseeable future," already earmarks an `effective_share_ids` storage-RLS branch + a `content_key → block` mapping as the hook "when subtree sharing ships," and plans public sharing as a later "export-to-plaintext or key-in-fragment" phase. This doc stays consistent with that stance.

3. **Sharing itself never shipped.** The old design is design-only: there are **no** `block_shares` / `effective_share_ids` / `block_share_members` / `share_links` objects in the migrations (verified §11). So we are free to design the key-access plane *before* committing the access-control plane to schema, and to make the two planes fit each other.

The old doc's own framing — "RLS at Postgres + sync-rule enforcement at PowerSync are the actual security boundary; the client enforces only UX" (G4) — is exactly the assumption e2ee revokes. Under e2ee the server boundary is **not** trusted with confidentiality; that is the whole point. A design that leans on RLS for confidentiality is fine for plaintext and insufficient for e2ee. This doc is about closing that gap.

---

## 2. The two planes

Keeping these apart is what makes the rest tractable.

### Plane 1 — Access control (which rows a recipient may fetch)

This is the machinery `subtree-sharing.md` designs: `blocks.effective_share_ids text[]` (trigger-maintained, walking `parent_id` only — no content read), RLS on `blocks` unioning workspace membership with share membership, a `shared_blocks` PowerSync stream, and the `block_shares` / `block_share_members` / `share_links` / `share_link_secrets` tables.

**None of this reads block content.** It operates on ids, the tree shape (`parent_id`), and membership tables — all plaintext metadata in *both* plaintext and e2ee workspaces (e2ee seals only the three content columns; see `WireBlockColumns`). So the *mechanics* of access control work identically for e2ee and plaintext.

But "works identically" is a statement about the *plumbing*, not about confidentiality. Two caveats the rest of the doc develops:

- **It is RLS — not the sync stream — that bounds what a key-holder can read.** Because `blocks` is granted to `anon`/`authenticated` and the shipped policy narrows nothing below the workspace, the security boundary is the *policy predicate*, and any "you only get the subtree" claim must hold against a recipient issuing arbitrary PostgREST `SELECT`s, not just against the auto-sync stream (§3).
- **The plumbing ships plaintext metadata** — tree shape, timestamps, author user-ids, and the `effective_share_ids` array — to both the recipient and the server. That metadata leakage is real and Option C does **not** close it (§8.6).

### Plane 2 — Key access (can the recipient decrypt the rows they fetched)

For a **plaintext** workspace there is no Plane 2; the rows are readable, and the old design is complete. For an **e2ee** workspace the recipient holds ciphertext they cannot read and needs *a key*. The only key that exists is the per-workspace WK. The entire design space below is "what key does the recipient get, and how," trading confidentiality granularity against complexity.

A consequence to bank now: **a share token conveys access, not a key.** Under e2ee, redeeming a link grants a `block_share_members` row and syncs ciphertext, but delivers no decryption material — so the old token-credential model is, by itself, inert for e2ee (§4).

---

## 3. The crux: per-workspace key vs per-subtree share

A single symmetric WK per workspace cannot, on its own, encode "may read subtree T but not its siblings." Whatever key decrypts T's rows decrypts every row sealed under the same key — and today every row in the workspace is sealed under the same WK. So there are only three structural ways out:

1. **Hand over the one key, and rely on a *non-cryptographic* boundary (RLS) to scope the recipient to the subtree.** → Option B.
2. **Give the shared subtree its own key**, so the key you hand over only opens the subtree — a *second encryption domain*. → Option C (and, manually, Option E).
3. **Don't hand over a key; produce a plaintext copy** at share time, governed by Plane 1 alone. → Option D (and trivially Option A for whole plaintext workspaces).

### 3.1 What "rely on RLS" actually buys — grounded in the shipped boundary

Every reviewer will probe this, so be exact. The fetch boundary is the `blocks_read` RLS predicate evaluated on direct PostgREST access, **not** the PowerSync stream. Two shipped facts set the stage:

- The recipient role can issue arbitrary `SELECT * FROM blocks` over PostgREST (`GRANT ALL … TO anon, authenticated`).
- The shipped `blocks_read` is **member-only** and narrows nothing to a subtree. The *revised* policy that subtree sharing must install (old §6.1) is a union: `is_workspace_member(...) OR <share covers this row for me>`.

So the guarantee depends entirely on **whether the recipient matches the member disjunct**:

| Adversary | What they can decrypt |
|---|---|
| **Share-member-only** recipient (not a `workspace_members` row) + **honest** server enforcing the *revised, union* `blocks_read` | **Only the shared subtree.** The member disjunct is false for them; the share disjunct matches only covered rows; even a direct `SELECT *` returns just those rows, and the WK opens only those. |
| Recipient who **is** a `workspace_members` row (e.g. B implemented by reusing the workspace-share invite→accept chain) + **honest** server | **The entire workspace.** The member disjunct is true → RLS returns every row → the WK opens all of it. Subtree scoping is *vacuous*. |
| Any WK-holder + **dishonest / compromised** server, or an RLS bug/regression | **The entire workspace.** The server holds all ciphertext; the recipient holds the master key; together they reconstruct everything. |

Three conclusions fall out, and the doc must carry all three loudly:

1. **Option B is only honest if the recipient is a pure share-member, never a workspace member.** It therefore **cannot** reuse the shipped whole-workspace share flow verbatim (that adds a `workspace_members` row → row 2). It needs a share-grant-only membership plus separate WK delivery, and the *revised* union `blocks_read` must be installed first (the shipped member-only policy gives row 2 unconditionally).
2. **Even done correctly, handing over the WK delegates the confidentiality of the *whole workspace* to RLS** — the very server-enforced boundary e2ee was adopted to remove (row 3). That does not make B useless; it makes it **not a confidential subtree share**. It is "give someone the workspace master key plus a row-filter scoping them, in normal operation, to a subtree." Appropriate for a recipient you'd trust with the whole workspace anyway; wrong as "share one page with a stranger without exposing my graph."
3. **"A workspace member whose sync view is narrowed" is the wrong mental model for B** and must not appear: sync-view narrowing is a PowerSync convenience, not an authorization boundary. The authorization boundary is RLS, and a *member* passes it for everything.

---

## 4. What the old design loses on an e2ee workspace

Several mechanisms in `subtree-sharing.md` assume the server can read content, or that a token is a sufficient credential. They are fine on plaintext workspaces and **must be disabled or rerouted on e2ee workspaces**:

- **old §3.3 / old §8.4 read-only snapshot RPC `get_shared_subtree(token)`** returns `{ blocks: [BlockData…] }` server-assembled. On e2ee the content columns are `enc:v1:` ciphertext, so a `SECURITY DEFINER` function returns only ciphertext — and worse, it returns *ciphertext sitting in the plaintext-typed `BlockData` fields*, which a naïve client would render as content. It must therefore be **hard-disabled** on e2ee, not merely "rerouted." Anonymous read-only e2ee sharing cannot go through it (replacement: Option D export, or Option C key-in-fragment).
- **old §8.6 reference-stub RPC `resolve_block_link_stubs(ids)`** returns `content_label` (leading text) for blocks the viewer can't fully access. On e2ee the server cannot produce a label — the content is ciphertext. Cross-scope labels must come from the *client*, and only for blocks the client can decrypt; references to rows the recipient never received render **id-only / "no access," no human-readable label** (§8.2).
- **old §3.3 / old §3.4 link-token credential model is inert for e2ee.** The old RW link path (redeem token → anon sign-in → `block_share_members` row → `shared_blocks` stream) delivers *access* but **no key**. On an e2ee workspace a guest who redeems a link syncs ciphertext and then stalls at the key-required gate with nothing to decrypt and nothing to edit (an editor write must produce a valid `enc:v1:` envelope, which needs the key). **So link tokens are access-plane-only and convey no key; the token-row model is foreclosed for e2ee link sharing.** E2EE links require key-in-fragment (C) or export (D); see §8.8 for the anonymous-user consequence.
- **old §3.4 / old §9.5 anonymous link-snapshot render** (`SnapshotShareView` fed by the snapshot RPC) inherits the snapshot RPC's uselessness above for e2ee.

Also inherited from e2ee's standing boundary (e2ee §15): **no server-side features over e2ee shares** — no server search across a shared subtree, no AI/embedding/summary, no server-rendered public page or email preview. These were never promised for e2ee workspaces; sharing does not change that.

Two things **survive** e2ee untouched and are worth banking:
- **Read-write write-back works under a shared key.** A recipient editing under a key writes `enc:v1:` ciphertext, satisfying `blocks_require_ciphertext_for_e2ee`, which a holder of the same key decrypts. No new crypto (true for B under the WK; C needs a bridge — §6.C). Operational caveats (history, attribution, reprojection) are real — see §8.7.
- **The `effective_share_ids` / RLS / stream *plumbing*** is metadata-only and indifferent to encryption (§2).

---

## 5. Design dimensions

Two orthogonal axes generate the option space. Don't conflate them.

- **Axis 1 — key domain (confidentiality granularity).** *Whole-workspace* (the recipient's key opens the whole workspace; subtree scope is RLS-only) vs *per-share* (a fresh key opens only the shared subtree; subtree scope is cryptographic) vs *none* (plaintext copy; no key).
- **Axis 2 — key delivery (how the recipient obtains whatever key they get).** *Out-of-band* (the user transmits the key over Signal/paper/password-manager; what ships today for whole-workspace shares) vs *wrapped delivery* (server brokers a key wrapped to the recipient's public key; requires the deferred e2ee §13 X25519 hierarchy) vs *key-in-URL-fragment* (the key rides in the `#fragment`, never sent to the server; the anonymous-link pattern, with real hygiene hazards — §9).

Axis 2 is a pure "where does the key come from" upgrade and applies to whichever key domain you pick. The hard, security-defining choice is Axis 1. The options below are points in (Axis 1 × Axis 2) space. A **pure capability-token** (bearer-grant, server validates token → ships rows) is *not* a separate Axis-1 option under e2ee: a token alone ships only ciphertext, so it degenerates into token + key-in-fragment (→C) or token + export (→D). It survives as a distinct mechanism only on plaintext workspaces, where it *is* the old `share_links` design.

---

## 6. The options

### Option A — Plaintext-only sharing (capability-gate e2ee out)

**Mechanism.** Ship `subtree-sharing.md` exactly, gated to plaintext workspaces (the share affordance reads the local mode pin; e2ee → no subtree share, offer Export/Add-collaborator instead).

**Key domain:** none. **Delivery:** n/a. **Threat model:** identical to the old doc — RLS is the boundary, correct *because the workspace is plaintext and the server already reads it.* No regression, no new promise.

**Enables:** full-fidelity subtree sharing (nested shares, invites, RO/RW links, anonymous snapshot links, server labels) on every non-encrypted workspace — the bulk of today's value. **Complexity:** lowest — the old design plus a one-line capability gate.

### Option B — Whole-workspace key, RLS-scoped subtree

**Mechanism.** Plane 1 ships for e2ee too: the recipient gets a `block_share_members` grant (and is **not** added to `workspace_members` — §3.1 conclusion 1), the *revised union* `blocks_read` and the `shared_blocks` stream scope them to the covered subtree, and Plane 2 delivers the **workspace WK** out of band (→ wrapped delivery once §13 lands). The recipient pins the workspace `e2ee`, holds the WK, decrypts the covered rows.

**Key domain:** whole-workspace. **Delivery:** out-of-band → wrapped.

**Threat model (the honest version).** B gives the recipient the workspace **master key** and delegates confidentiality scoping entirely to a row-level authorization filter. Per §3.1: a share-member-only recipient + honest server sees only the subtree; a recipient who is *also* a workspace member, or any recipient facing a dishonest server / RLS regression, reconstructs the whole workspace. **B is not a confidential subtree share** and must never be framed as "a workspace member with a narrowed sync view." Revocation is cryptographically void (§8.4).

**Cost (not "near-zero").** Low *crypto* cost, but B inherits all of Plane 1 *plus* two non-trivial additions: a new client bootstrap state "I hold this WK but only a subtree synced" in the workspace resolver (§8.3), and — for shared media — a Storage-RLS extension that, with path-prefix RLS, can only grant per-*workspace* GET, not per-subtree (§8.1). So B's media is "free" only at workspace granularity, which is consistent with B not being subtree-confidential anyway.

**Verdict on B's existence.** Because B is cryptographically "hand over the master key," it is *barely distinguishable from adding a collaborator to the workspace* with a focused landing block — and Option E (below) gives a trusted collaborator strictly better confidentiality. The recommendation (§7) therefore ships **neither** B's construction (`block_share_members` + union `blocks_read` + subtree-scoped stream, all under the whole WK) **in any form**. On e2ee the only collaborator affordance is the *already-shipped whole-workspace share* (no `block_shares` machinery at all), with Option E as the confidential-subtree steer. B is retained here as a named point in the option space precisely so the reasoning against shipping it is on the record — and to keep it distinct from the shipped whole-workspace share, which is a *different*, simpler thing.

### Option C — Per-share key domain (cryptographically-isolated subtree)

**Mechanism.** Give the shared subtree its **own** symmetric Share Key `SK` (a fresh CSPRNG key, not derived from the WK — so a recipient given `SK` cannot derive the WK or any sibling key), so the key the recipient receives opens *only* the subtree. This is the only option that keeps the e2ee promise — "share a page without exposing the graph" — and the only one that admits anonymous links (the fragment carries `SK`, which unlocks only the share; fragment hygiene is a real hazard class, see §9). It does **not** close metadata leakage (§8.6). Two sub-variants:

- **C-in-place (multiple key domains per workspace).** The subtree's blocks stay in the origin workspace but are re-sealed under `SK`. This generalizes the e2ee core from *one key per workspace* to *a key domain per (workspace, key-id)*, and the ripple is wider than just the seam:
  - `getCek` must resolve per (workspace, key-id). (Resolution is *already* `(user, workspace)` under the seam — the `GetCek` signature is `(workspaceId)` but the resolver reads the active user and the key store keys on `(userId, workspaceId)` — so C-in-place widens it to `(user, workspace, key-id)`.)
  - The per-column AAD must additionally bind a **`key_id`**. This is *not cosmetic*: today the AAD pins `[block_id, workspace_id, column, schema_version]` but **not** which key domain sealed the column. With WK- and SK-sealed ciphertext sharing the same `(block_id, workspace_id, column)` AAD, nothing authenticates *which* domain a column was sealed under, enabling a **cross-domain splice** — a both-keys holder (or a server feeding one) substitutes an SK-sealed column where a WK-sealed one is expected and it still authenticates, because the AAD pins the column but not the key domain. (AES-GCM still fails closed on a *wrong-key* open; the hole is specifically the unauthenticated domain a both-keys holder can confuse.) Binding `key_id` authenticates the domain (and bumps `schema_version`).
  - The **mode pin** ([`modePin.ts`](../src/sync/keys/modePin.ts)) is per `(user, workspace)` and set-once/immutable — it has no slot for a sub-workspace domain, so "is this block's domain e2ee and is its SK loaded?" needs new sub-workspace authority machinery, exactly the authority the §6/§8.3 gate is built on.
  - The **materializability resolver** ([`resolver.ts`](../src/sync/keys/resolver.ts) + the per-`workspace_id` cache in the observer's `materialize`) resolves per workspace; C-in-place forces per-block-domain resolution inside the decrypt loop.
  - The owner's client must hold the WK and every live `SK`; a **recipient holds only the SK(s) they were granted**.

  So this is **encryption-core surgery, not a follow-up commit** — it reaches the seam, the AAD format, the pin authority, and the observer.

- **C-projection (a share is a derived workspace).** The subtree is *mirrored* into a new lightweight workspace `W_share` sealed under `SK` (= that workspace's WK), and the recipient is a member of `W_share`. This reuses 100% of the per-workspace e2ee model with zero core changes — the cost moves to a **re-encryption relay**: origin (under WK) and mirror (under SK) are two ciphertext domains, and the current sync path is strictly single-workspace (upload seals under the payload workspace's key; download decrypts each row under its own workspace's key — there is no path to decrypt from A and re-seal into B). So only a holder of *both* keys (the owner) can reconcile them, on the client, online. Editor recipients' edits land in `W_share` under `SK`; the **owner's client is the relay** that re-projects them into the origin under WK and vice versa — offline, the domains diverge. Worse, the two rows have **independent `updated_at` lineages** (each server-clamped by [`20260612000000`](../supabase/migrations/20260612000000_add_user_updated_at_monotonic_clamp.sql)), so the relay cannot resolve conflicts by column last-write-wins and needs an explicit causal/version scheme. This is a genuine CRDT/relay subsystem — the heaviest part of the whole design.

**Key domain:** per-share. **Delivery:** out-of-band, wrapped (§13), or key-in-fragment (anonymous).

**Threat model.** Strong: a recipient (even colluding with a hostile server) decrypts only the shared subtree. Revocation is *cryptographically meaningful and cheap*: rotate `SK`, re-seal only the (small) shared subtree, re-wrap to remaining members (§8.4). This asymmetry is the principal reason C is the *correct* long-term answer.

**Forecloses:** simplicity. C-in-place perturbs the encryption core (above); C-projection adds the owner-relay subsystem and duplicate storage (including duplicate media re-uploaded under `SK`, defeating workspace-wide dedup — §8.1). **Complexity:** high; defer behind a concrete requirement (§7, §9).

### Option D — Export-to-plaintext snapshot (read-only / public / anonymous)

**Mechanism.** At share time the **client** decrypts the subtree (it holds the WK) and writes a **plaintext** copy governed by Plane 1 alone — into a dedicated plaintext "published" surface (a published workspace or an immutable client-produced snapshot). The artifact is plaintext thereafter; the server can read/render/label/serve it; anonymous recipients need no key. This is the e2ee-world realization of the old snapshot path, with the decrypt moved to the *client* before publication, and matches the media design's "export-to-plaintext" plan.

**Key domain:** none after export. **Delivery:** n/a.

**Threat model.** Deliberate **declassification**: the exported copy is plaintext on the server under the old RLS-only boundary, and updates to the encrypted original do not propagate (it's a snapshot, or a separate plaintext workspace). **Footgun (per AGENTS.md public-table rule):** `blocks` is granted to `anon`, so the publish target's RLS must *positively allow* anon `SELECT` on exactly the published subtree and default-deny everything else, or export silently world-exposes more than intended. The UI must make declassification unmistakable, and it is **irreversible** — there is no un-publish that re-encrypts, and any media re-published as plaintext (§8.1) is a permanent independent artifact (§8.8).

**Enables:** "share read-only with the world / with someone with no account," server previews/labels/search *of the exported copy* — the things e2ee otherwise forecloses — at the cost of those bytes no longer being end-to-end encrypted. **Complexity:** low-to-moderate; client decrypt + a publish target; no encryption-core change.

### Option E — Manual second e2ee workspace (confidential, no relay)

**Mechanism.** The user creates a *second* e2ee workspace with its own WK (= a per-share key, achieved with zero core changes), hands that WK to collaborators out of band (the shipped whole-workspace share — `createEncryptedWorkspace` + `unlockWorkspaceWithKey`), and **moves or copies** the subtree into it, accepting that it is now a separate graph with no live link to the origin.

**Key domain:** per-share (it's a real separate workspace key). **Delivery:** out-of-band → wrapped (§13).

**Threat model.** Full cryptographic isolation — the collaborator's key opens only that second workspace, never the origin. This is **C-projection's confidentiality at A's implementation complexity**, trading away automation: the copy is divergent (no relay keeps it in sync with the origin), and the user maintains it by hand. For the "trusted collaborator on a confidential subtree" case, E is cryptographically *strictly better than B* with **no new code** — though at a real *manual-maintenance* cost (a divergent copy the owner keeps current by hand). That is why it, not B, is the recommended confidential path until C exists.

**Forecloses:** live two-way sync between origin and the shared copy; nested/overlapping shares; anonymous links. **Complexity:** essentially zero new code — it's the shipped workspace-share plus a cross-workspace copy (the existing immutability trigger rejects cross-workspace *moves*, so v1 E is copy-with-divergence, or needs a sanctioned move RPC). The copy mints **fresh block ids** (ids are global primary keys), so intra-subtree references must be id-rewritten to the new ids or they dangle / resolve back into the origin — the same re-id-on-paste concern, and a real footgun given this codebase's dangling-ref history.

### The delivery upgrade (Axis 2), and why §13 is still deferred

The e2ee §13 hierarchy (per-user asymmetric keypair — X25519 *as currently sketched* in that doc, which is "superseded in places" — per-workspace CEK wrapped per member, server-brokered delivery) removes the out-of-band step from **B/C/E** without changing their key-domain semantics: the owner wraps the relevant key (WK or SK) to the recipient's published public key; the server stores/relays the wrapped blob; the recipient unwraps locally. It is the only clean, non-anonymous delivery and revocation story for C, so C depends on it.

Building §13 *now* is itself an option — and the sharing use case is arguably the first concrete thing that justifies it. We still defer it as a deliberate decision, not by inheritance: v1 does not ship confidential e2ee subtree sharing (the only consumer that needs wrapped delivery beyond what out-of-band already covers), so §13's cost isn't yet bought by a shipping feature. B/C/E should keep their key-delivery call site on the existing `getCek`/key-store seam so the upgrade is a delivery swap, not a redesign.

---

## 7. Recommendation — a phased hybrid, with the bet stated

Make the planes explicit in the product, and be honest per workspace mode. This resolves the "does B exist" question (§6.B) rather than leaving it open.

**Phase 1 — ship the access-control plane; full sharing on plaintext; honest-only on e2ee.**
- Implement Plane 1 from `subtree-sharing.md` (schema, recompute, RLS *revised to the union policy*, `shared_blocks` stream, RPCs, routing, share-mode bootstrap, dialog). Crypto-agnostic; lands once and serves every later option.
- On **plaintext** workspaces this delivers the entire old design (Option A): the bulk of user value, no e2ee risk.
- On **e2ee** workspaces, the "Share…" affordance does **not** offer a confidential subtree share, and does **not** ship Option B as a distinct feature. It offers exactly:
  - **Add a collaborator** — surfaced honestly as "shares the whole workspace key with this person." Mechanically this is the shipped whole-workspace share; for a confidential subtree the UI steers the user to **Option E** (a second e2ee workspace), which is cryptographically clean. No `block_shares` machinery is used on the e2ee path here, because at whole-WK granularity it would only imply a confidentiality wall that does not exist.
  - **(D) Publish a read-only copy** — client decrypts and exports to a plaintext surface (declassification, explicit and irreversible); covers public/anonymous read-only links.

**Phase 2 (deferred, requirement-gated) — confidential subtree sharing on e2ee (Option C).**
- Build only when there is a real need for "share a page, not my graph" *on encrypted workspaces with live collaboration*. Ride it in on the e2ee §13 hierarchy so wrapped delivery and meaningful revocation come together. Prefer **C-in-place** only if its encryption-core change (key-id AAD, per-domain `getCek`, sub-workspace pin authority, per-domain materializability) proves cheaper than **C-projection**'s owner-relay reconciliation; prototype both against the media-dedup and offline-collaboration constraints before committing. Note metadata leakage (§8.6) still isn't closed even by C.

**The bet, stated plainly.** v1 deliberately does **not** deliver the marquee capability — confidential subtree sharing on e2ee. We accept that because (a) plaintext workspaces cover most real sharing; (b) for trusted collaborators on confidential material, Option E already gives cryptographic isolation with no new code; (c) the fleet is small and coordinatable, so there is no pressure for anonymous-stranger confidential sharing yet; and (d) C is a substantial project that should be bought by a concrete requirement, not built speculatively. A reader who believes confidential subtree sharing is needed *now* should disagree with this bet directly (§9, Q1) — it is the load-bearing product decision, not an obvious "do the easy thing first."

**Why this ordering.** Most value (plaintext sharing) with least risk first; never a confidentiality promise the crypto doesn't keep (the e2ee path ships only declassification and explicit whole-key trust); consistent with the media design's deferral of encrypted subtree sharing; and the hard cryptographic work (C) sequenced behind both a concrete requirement and the §13 delivery hierarchy it depends on.

---

## 8. Cross-cutting concerns

### 8.1 Media inside a shared subtree

An asset lives at `<workspace_id>/HMAC(K_id, sha256(plaintext))`, sealed `encb:v1:` under the WK, `K_id = HKDF(WK, …)` (media facts off-branch/design-only — §11).

- **Option B / E:** the recipient holds the WK (B) or the second-workspace WK (E), derives the same `K_id`, computes the path, fetches, decrypts. But path-prefix Storage RLS keys on `workspace_id` (the path's first segment), so extending it to share members grants per-*workspace* GET, **not** per-subtree — honoring share membership at subtree granularity requires the media design's deferred `content_key → block` mapping (its earmarked `effective_share_ids` storage-RLS branch). Under B this is consistent (B isn't subtree-confidential anyway); under E it's irrelevant (the second workspace *is* the share boundary).
- **Option C:** hard. Bytes were uploaded under the WK with a WK-derived path/key. `K_id` is a one-way HKDF output — sharing it does **not** yield the WK and does **not** decrypt anything (assets stay sealed under WK), so it is not a "WK capability." What it *is* is a **workspace-wide path/existence oracle**: a holder of `K_id` can recompute any asset's path from a guessed plaintext and test its presence across the whole workspace. So C must **re-seal the asset under `SK`** (so an `SK`-only recipient can open it — it cannot open WK-sealed bytes) and **re-upload at an `SK`-derived path**; the path change specifically buys namespace + dedup-domain separation, not plaintext confidentiality (which `SK`/`WK` key separation already provides). This defeats workspace-wide dedup and duplicates bytes per share. C-projection makes this explicit: the mirror re-uploads its media.
- **Option D:** the client decrypts the bytes and re-publishes them as plaintext objects — standard, irreversible declassification (§8.8).

### 8.2 References crossing the share boundary — and the reprojection hazard

The old §8.6 server-label RPC is dead for e2ee (§4). Two distinct problems:

- **Display.** A reference whose target row the recipient received and can decrypt → render normally. A reference to a row outside the share → an **id-only / "no access" chip, no label** (neither server nor client can produce one). Strictly worse than the plaintext experience; surface it as a known limitation. Presentation-root clipping (old §3.8) is unchanged (tree-shape metadata).
- **Reprojection write-back (a schema-parity gate, *not* a partial-view problem).** `references_json` holds a block's **outgoing** refs, computed from that block's **own** content and ref-typed property values (the `references_json` *column* is declared in [`blockSchema.ts`](../src/data/blockSchema.ts), but *which properties contribute refs* is set by plugin-registered schemas via `propertySchemasFacet`, classified by codec in [`src/data/internals/refProjection.ts`](../src/data/internals/refProjection.ts) — that registry is precisely what "schema parity" means here; reprojected by `reprojectRefTypedProperties` in [`repo.ts`](../src/data/repo.ts) and the per-edit [`referencesProcessor.ts`](../src/plugins/references/referencesProcessor.ts), both routed through the add-only `reconcileDerived` chokepoint in [`derivedData.ts`](../src/data/api/derivedData.ts) — contract [`docs/contracts/derived-data-add-only.md`](contracts/derived-data-add-only.md)). An editor recipient can fully decrypt the block they are editing (it is inside their share), so recomputing *its* `references_json` from *its own* in-view content is **complete, not partial** — a narrowed sync view does not by itself make the recompute lossy. The SRS / daily-note ref-stripping incidents were caused by a **deriver being absent** (a ref-typed schema/plugin toggled off, or `?safeMode`), not by sibling rows being out of sync view. So the residual hazard is **schema/plugin parity**: a recipient whose client lacks a ref-deriving schema (or runs `?safeMode`) and edits a block. The existing add-only / retain-on-absence contract is exactly what protects this; the gate is "confirm the recipient's client loads the same ref-deriving schemas as the owner," and it is **crypto-agnostic** — a *plaintext* Option A editor recipient missing a schema is the identical hazard. So this is a **Plane-1 / Option A acceptance gate**, not a deferred-e2ee-only concern. Backlinks pointing *into* a shared subtree from outside are computed on the owner's full-context client and are simply invisible to the recipient — acceptable, but state it.

### 8.3 Client state: multi-workspace, multi-device, key loss

- **Partial-key state.** Under B a recipient holds a WK and a mode pin for a workspace where only a subtree synced. The resolver ([`src/bootstrap/resolveWorkspace.ts`](../src/bootstrap/resolveWorkspace.ts), [`decideWorkspaceEntry`](../src/sync/keys/workspaceAccess.ts)) keys off membership/RLS access and does **not** model "WK present but only a subtree available"; that must become a first-class state, not "key-presence ⇒ full membership." Entering an e2ee share must drive the same unlock/canary gate a normal e2ee entry does.
- **Multi-device recipient.** A recipient's *second* device obtains the key the same way the first did — out of band again, or via §13 wrapped delivery once it exists. State this; it's the same property the whole-workspace share already relies on (the canary is workspace-scoped, so any device validates the same WK).
- **Key loss.** Recipient loses their device key → for B, re-paste the WK; for C/E, the owner re-shares the `SK`/second-workspace WK. There is no recovery of lost keys (inherited e2ee property). The lock-and-wipe panic delegates to the platform's "clear site data" — a coarse, origin-wide wipe of all local data and keys for the profile (not a per-workspace or per-share operation) — so a recipient who triggers it simply re-enters via this same key-loss path; no share-specific recovery is needed.

### 8.4 Revocation differs sharply by option — say so

- **Plaintext (A) / export (D):** revocation = RLS stops new fetches; the recipient keeps whatever already synced; exported plaintext stays readable wherever it landed.
- **Option B (whole-WK):** revocation is **cryptographically void**. Because `blocks` is reachable by direct PostgREST `SELECT` under RLS, revocation that leaves *any* RLS-passing path open lets the WK-holder keep pulling and decrypting **new** edits, not just re-reading local copies. True revocation requires rotating the workspace WK — re-encrypting the *entire* workspace and redistributing the new WK to all legitimate members — exactly the expensive op e2ee otherwise avoids. The strongest argument against treating B as real subtree sharing.
- **Option C (per-share SK):** revocation is **meaningful and cheap** — rotate `SK`, re-seal only the (small) shared scope, re-wrap to remaining members. The recipient keeps what they already pulled but is cryptographically locked out of everything after rotation.
- **Option E (second workspace):** rotate the second-workspace WK to lock the recipient out of *future* manually-pushed updates; since v1 E is a divergent manual copy there are few such updates, so revocation mainly governs whether the owner keeps re-sharing the new WK — it does not retroactively re-confine what was already copied.

### 8.5 Threat-model statement (one place, aligned with §3.1)

E2EE's invariant is "the server never holds plaintext or a usable key." Per option:
- **A:** unaffected (plaintext workspace; invariant didn't apply).
- **B:** the invariant now rests on the three §3.1 conditions (share-member-only recipient, honest server enforcing the union RLS, no direct-PostgREST escape) — and even then on the recipient's trustworthiness for the whole workspace, since they hold the master key. A deliberate, scoped relaxation; acceptable for fully-trusted collaborators, unacceptable as a general primitive.
- **C / E:** invariant preserved; the recipient is cryptographically confined to the shared scope. (Metadata still leaks — §8.6.)
- **D:** the **exported copy** is deliberately declassified to plaintext; the original workspace's invariant is untouched.

### 8.6 Metadata leakage — what a recipient and the server learn beyond content

Plane 1 ships plaintext metadata to both the recipient and the server, and **no option here closes it — not even C.** For any covered block a recipient receives: the `id`, `workspace_id`, `parent_id` (→ tree *shape* and sibling structure), `create_time`/`update_time` (→ edit cadence), `created_by_user_id`/`updated_by_user_id` (→ co-author identities), and the `effective_share_ids` array. For a "share a page, not my graph" (C) framing this is a real disclosure: structure, timing, and authorship of the shared subtree leak even though content is sealed under `SK`. Two concrete actions:

- **Disclose it.** Any "confidential" framing for C must state that *content* is confidential but *structure/timing/authorship metadata of the shared subtree* is not.
- **Filter `effective_share_ids`.** A covered row's array contains *all* share-ids reaching it, including shares the recipient is not a member of — leaking the existence and ids of sibling/overlapping shares. The `shared_blocks` projection must ship **only the recipient's own reaching share-ids**, or accept this as a disclosed leak. Likewise re-examine `block_shares` / `block_share_members` stream visibility (old §6.3 restricted member enumeration to writers): a scoped recipient must not be able to enumerate the whole workspace's share audience.

### 8.7 Write-back: history, attribution, concurrency

Editor write-back is "free" cryptographically but carries operational tails:
- **History.** Every blocks write fires the server `blocks_history` trigger ([`20260522062437`](../supabase/migrations/20260522062437_add_blocks_history.sql)), stamping `actor` and storing `before_diff`/`after_diff` — which are **ciphertext** for e2ee. A recipient's edits write history rows into the *owner's* workspace history (readable by anyone with workspace history access). For C the live row is under `SK` but its history diffs would be under the WK path — the history-vs-live key-domain split must be resolved (which key seals SK-subtree history?).
- **Attribution.** `created_by`/`updated_by` are client-supplied (`COALESCE(patch->>'created_by', …)` in [`apply_block_patches`](../supabase/migrations/20260527180103_add_apply_block_patches_rpc.sql)), so an editor recipient can spoof authorship. Pre-existing, but sharing widens the trust boundary to non-workspace recipients — if attribution matters for shares, stamp it server-side from `auth.uid()`.
- **Concurrency.** Within one key domain, block-granular LWW is unchanged. Across domains (C-projection) it is meaningless (§6.C — independent `updated_at` lineages).

### 8.8 Lifecycle / GC

- **Anonymous-user GC still rides along.** Plaintext RW links (Option A) still mint anon Supabase users with the old deferred-GC debt — the e2ee work doesn't remove it, it inherits it. For e2ee, RW *anonymous* links are foreclosed entirely (anon users hold no key; B can't forward the WK to a public URL; C key-in-fragment is deferred), so anonymous e2ee sharing is read-only export (D) only.
- **Revoked-share / deleted-subtree cleanup.** For C-in-place, when a share is revoked and `SK` rotated, blocks that *left* the share need re-sealing under the WK — name who runs that and when. For C, the duplicate `SK`-media must be GC'd on revoke or it orphans. Deleting a shared subtree cascades `block_shares` (old §4.2 `on delete cascade`), but a D export snapshot and a C `W_share` mirror survive independently. Spell these out before building C.
- **Declassification is permanent.** D has no recall that re-encrypts; exported plaintext (text and media) is a permanent independent artifact — relevant to any "right to be forgotten" expectation.
- **Share creation is online-only.** Plane-1 share mutations are security-definer RPCs (old §8), so a share initiated offline can't mint a grant/token until reconnect — the established mutation pattern, but worth surfacing in the share UI rather than failing silently.

---

## 9. Open questions

1. **Is confidential subtree sharing on e2ee actually needed now?** This is the §7 bet. If the small, coordinatable fleet never needs "share one encrypted page with an untrusted stranger, live," C may never ship and the design is "A + D + E." Answer by product need.
2. **C-in-place vs C-projection** if C is built: which is cheaper given (a) media-dedup and (b) offline collaboration (owner-relay vs always-online)? Prototype before choosing.
3. **`effective_share_ids` / share-table stream filtering** (§8.6): ship only the recipient's own reaching share-ids and confirm a scoped recipient can't enumerate the workspace's share audience — part of Plane 1, not an afterthought.
4. **Storage-object RLS for shared media** (§8.1): the `content_key → block` mapping the media design defers is the real subtree-granular hook; scope it into Plane 1 or the media design.
5. **Reprojection schema-parity for editor recipients** (§8.2): the recompute is *complete* for in-view blocks, so the gate is confirming a recipient's client loads the same ref-deriving schemas (the add-only / retain-on-absence contract protects the rest). Crypto-agnostic — it gates the *shipping* plaintext Option A editor path, not only deferred e2ee.
6. **Key-in-fragment hygiene** (Referer/history/paste leakage, no forward secrecy once the URL leaks) for any future C anonymous link.

---

## 10. Mapping to existing code seams

| Concern | Existing seam | Change for sharing |
|---|---|---|
| Encrypt/decrypt on the wire | `encodeForWire` / `decodeFromWire`, [`transform.ts`](../src/sync/transform.ts) | unchanged for B/E (same WK via `getCek`); C-in-place needs per-domain `getCek` |
| Per-column AAD | binds `[block_id, workspace_id, column, schema_version]`, [`aad.ts`](../src/sync/crypto/aad.ts) | C-in-place must add `key_id` to authenticate the key domain (§6.C); bumps `schema_version` |
| Key lookup | `getCek(workspaceId)`, [`resolver.ts`](../src/sync/keys/resolver.ts) | B/E: unchanged; C-in-place: per (workspace, key-id); §13 delivery: swap source to unwrapped-CEK map |
| Mode authority | mode pin [`modePin.ts`](../src/sync/keys/modePin.ts); gate [`workspaceAccess.ts`](../src/sync/keys/workspaceAccess.ts) | new "WK held but only a subtree synced" state (§8.3); C-in-place needs sub-workspace domain authority |
| Materializability | per-`workspace_id` resolve, [`resolver.ts`](../src/sync/keys/resolver.ts) + observer | C-in-place: per-block-domain resolution in the decrypt loop |
| Whole-workspace e2ee share | `createEncryptedWorkspace` + `unlockWorkspaceWithKey` + workspace-scoped canary, [`shareWorkspace.test.ts`](../src/sync/keys/flows/shareWorkspace.test.ts) | the mechanism behind E and the e2ee "add collaborator" affordance |
| Server ciphertext guard | `blocks_require_ciphertext_for_e2ee`, [`migration`](../supabase/migrations/20260529120000_add_e2ee_workspace_columns.sql) | unchanged — recipient (B) and SK (C) writes are still `enc:v1:` |
| Fetch boundary | `blocks_read` (member-only) + `GRANT ALL ON blocks TO anon, authenticated`, [`migration`](../supabase/migrations/20260510222352_consolidated_initial.sql) | must become the union policy; B is honest only if the recipient fails the member disjunct (§3.1) |
| Derived `references_json` | reprojected in [`repo.ts`](../src/data/repo.ts) + [`referencesProcessor.ts`](../src/plugins/references/referencesProcessor.ts), via the add-only `reconcileDerived` chokepoint ([`derivedData.ts`](../src/data/api/derivedData.ts)) | schema-parity gate for editor recipients (§8.2); crypto-agnostic, gates Option A too |
| Access control (Plane 1) | *none yet* — `subtree-sharing.md` design | implement once, crypto-agnostic; serves A/B/C/D/E |
| Media content path/seal | `HMAC(K_id,…)`, `encb:v1:`, media design (off-branch) | B/E: per-workspace Storage RLS; subtree-granular needs `content_key → block`; C: re-key/re-upload (§8.1) |
| Read-only snapshot | `get_shared_subtree` (old §8.4) | useless on e2ee; disable/reroute → D export (or C key-in-fragment) |
| Reference labels | `resolve_block_link_stubs` (old §8.6) | dead for e2ee; client-only labels, id-only chip otherwise (§8.2) |

---

## 11. Grounding notes (verified 2026-06-24)

- **Verified against code:** the e2ee seam/columns/AAD/ciphertext-guard/mode-pin/canary/key-store and the whole-workspace share *property* — [`src/sync/transform.ts`](../src/sync/transform.ts), [`src/sync/crypto/aad.ts`](../src/sync/crypto/aad.ts) (AAD binds `[block_id, workspace_id, column, schema_version]`, no `key_id`), [`src/sync/crypto/canary.ts`](../src/sync/crypto/canary.ts), [`src/sync/keys/`](../src/sync/keys/), [`shareWorkspace.test.ts`](../src/sync/keys/flows/shareWorkspace.test.ts) (no `shareWorkspace()` function — it composes `createEncryptedWorkspace` + `unlockWorkspaceWithKey`). The three encrypted columns are exactly `content`, `properties_json`, `references_json`; `id`/`workspace_id`/`parent_id`/timestamps stay plaintext.
- **The fetch boundary facts** are verified: `blocks_read` is member-only ([migration:626](../supabase/migrations/20260510222352_consolidated_initial.sql)); `GRANT ALL ON blocks TO anon, authenticated` ([migration:1106-1107](../supabase/migrations/20260510222352_consolidated_initial.sql)); `blocks_history` stores `actor`/`before_diff`/`after_diff` ([20260522062437](../supabase/migrations/20260522062437_add_blocks_history.sql)); `created_by`/`updated_by` are client-supplied in `apply_block_patches` ([20260527180103](../supabase/migrations/20260527180103_add_apply_block_patches_rpc.sql)); `updated_at` is server-clamped monotonic ([20260612000000](../supabase/migrations/20260612000000_add_user_updated_at_monotonic_clamp.sql)).
- **No sharing schema exists yet** — `block_shares` / `effective_share_ids` / `block_share_members` / `share_links` are absent from all migrations. The access-control plane is still design-only, so it can be co-designed with the key plane.
- **Off-branch / design-only (NOT verified against code here):** media facts (`HMAC(K_id)` path, `K_id = HKDF(WK,…)`, `encb:v1:`, per-workspace Storage RLS, dedup, export-to-plaintext, deferred `content_key → block` mapping) are from `docs/media-attachments/design.html` on `claude/media-attachments-design`. E2EE design facts (per-workspace WK, no asymmetric crypto in v1, §13 deferred hierarchy, "no server-side features for e2ee," out-of-band key transfer) are from `docs/e2ee-design.html`, whose status banner reads "superseded in places" — so load-bearing claims here are pinned to code, not that doc.

## 12. References

- [`docs/subtree-sharing.md`](subtree-sharing.md) — the access-control-plane design this layers on (Plane 1).
- [`docs/shares-and-api-tokens.html`](shares-and-api-tokens.html), [`docs/share-aliases-explainer.html`](share-aliases-explainer.html) — related share-surface designs (API tokens, alias collision handling), both design-only/unverified.
- [`docs/e2ee-design.html`](e2ee-design.html), [`docs/e2ee-rejected-alternatives.html`](e2ee-rejected-alternatives.html), [`docs/lock-and-wipe-coarse-recommendation.md`](lock-and-wipe-coarse-recommendation.md) — the encryption model and its deferred §13 hierarchy.
- `docs/media-attachments/design.html` (branch `claude/media-attachments-design`) — encrypted byte storage, content-addressing, and its own deferral of encrypted subtree sharing.
