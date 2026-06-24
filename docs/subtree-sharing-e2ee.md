# Subtree sharing in the E2EE world — design options

> **Status:** unverified (design exploration, 2026-06-24). Last verified against code: 2026-06-24 (e2ee seams + absence of share tables checked; see §11). This is a *new* doc; it does **not** replace [`subtree-sharing.md`](subtree-sharing.md), which remains the canonical write-up of the **access-control plane** for a non-encrypted world. This doc layers the **key-access plane** on top and revises the parts of the old design that assumed a plaintext-reading server. Where the two disagree, prefer this doc for anything touching encryption and the old doc for the RLS / `effective_share_ids` mechanics it still owns.

---

## 0. TL;DR

- **Sharing splits into two independent planes.** *Access control* — "which ciphertext rows may a recipient fetch and sync" — is crypto-agnostic and the old `subtree-sharing.md` design (`effective_share_ids` + RLS + a `shared_blocks` sync stream) carries over almost unchanged. *Key access* — "can the recipient decrypt those rows" — is the genuinely new problem and the only thing e2ee changes. Keeping these planes separate is the central idea of this doc.
- **The crux is a granularity conflict.** E2EE today is **one symmetric Workspace Key (WK) per workspace** ([`src/sync/transform.ts`](../src/sync/transform.ts), [`src/sync/keys/`](../src/sync/keys/)). Sharing wants **per-subtree** confidentiality. A single key cannot, by itself, express "you may read this subtree but not its siblings." Everything below is a way to resolve that conflict, each with a different cost.
- **Three parts of the old design are dead on an e2ee workspace** because they require the server to read plaintext: the read-only **snapshot RPC** `get_shared_subtree`, the cross-scope **reference-stub label RPC** `resolve_block_link_stubs`, and the anonymous **link-snapshot** render path. They survive only on plaintext workspaces. (§4)
- **A whole-workspace e2ee share already ships.** Per [`src/sync/keys/flows/shareWorkspace.test.ts`](../src/sync/keys/flows/shareWorkspace.test.ts) sharing an encrypted workspace needs *no new flow*: invite (plaintext membership metadata) + send the WK out of band + the collaborator unlocks via the existing key-required gate. The canary is workspace-scoped, so an owner-minted WK validates for a different user. Subtree sharing is the question of going **finer** than that.
- **Recommendation (§7): a phased hybrid.** Ship the crypto-agnostic access-control plane so it fully works on **plaintext** workspaces (the old design). For **e2ee** workspaces, offer two honest, low-complexity paths in v1 — **(B)** a *scoped-sync* share for collaborators you already trust with the workspace key, clearly labelled as *not* confidential at subtree granularity, and **(D)** *export-to-plaintext* for read-only/public/anonymous links. Defer **(C)** cryptographically-isolated subtree sharing (its own key domain) until there is a concrete requirement; it is the natural home for the e2ee §13 key hierarchy and key-in-fragment links.

---

## 1. What changed since `subtree-sharing.md`

`subtree-sharing.md` (2026-04-27) predates three things:

1. **E2EE shipped** (PR #105 phases D/E; lock-and-wipe PR #245). It is real code, not a sketch:
   - The wire seam [`src/sync/transform.ts`](../src/sync/transform.ts) seals three columns — `content`, `properties_json`, `references_json` — independently with AES-256-GCM under a per-workspace key, keyed by a pluggable `getCek(workspaceId)` (`encodeForWire` / `decodeFromWire`).
   - A server-side trigger `blocks_require_ciphertext_for_e2ee` ([`supabase/migrations/20260529120000_add_e2ee_workspace_columns.sql:211`](../supabase/migrations/20260529120000_add_e2ee_workspace_columns.sql)) *rejects* any plaintext write to an e2ee workspace's content columns — so the server provably never holds plaintext for those rows.
   - Authority over a workspace's mode is a durable, locally-immutable **mode pin** ([`src/sync/keys/modePin.ts`](../src/sync/keys/modePin.ts)), not the server's `encryption_mode` flag. The pin is set the moment a pasted WK validates against the workspace-scoped `wk_canary` ([`src/sync/crypto/canary.ts`](../src/sync/crypto/canary.ts)).
   - The whole design is **per-workspace, opt-in, one shared symmetric WK, no asymmetric crypto, no per-recipient wrapping** in v1. A passphrase/CEK/X25519 hierarchy is explicitly deferred to e2ee §13.

2. **Media-attachments design** (branch `claude/media-attachments-design`, `docs/media-attachments/design.html`). It extends the same model to bytes: content is stored content-addressed at `<workspace_id>/HMAC(K_id, sha256(plaintext))` where `K_id = HKDF(WK, "km/asset-content-key/v1")`, sealed with `encb:v1:` (AES-256-GCM under the WK). It **explicitly defers** encrypted subtree sharing as "a non-goal for the foreseeable future," and earmarks public sharing for a later "export-to-plaintext or key-in-fragment" phase. This doc should stay consistent with that stance.

3. **Sharing itself never shipped.** The old design is design-only: there are **no** `block_shares` / `effective_share_ids` / `block_share_members` / `share_links` objects in the migrations (verified §11). So we are free to design the key-access plane *before* committing the access-control plane to schema, and to make the two planes fit each other.

The old doc's own framing — "RLS at Postgres + sync-rule enforcement at PowerSync are the actual security boundary; the client enforces only UX" (G4) — is exactly the assumption e2ee revokes. Under e2ee the server boundary is **not** trusted with confidentiality; that is the whole point. So a design that leans on RLS for confidentiality is fine for plaintext and insufficient for e2ee. This doc is about closing that gap.

---

## 2. The two planes

Keeping these apart is what makes the rest tractable.

### Plane 1 — Access control (which rows reach the recipient)

This is everything `subtree-sharing.md` already designs:

- `blocks.effective_share_ids text[]`, trigger-maintained, the materialized "which shares cover this block."
- RLS on `blocks` unions workspace membership with share membership.
- A `shared_blocks` PowerSync stream ships exactly the covered rows to a recipient.
- `block_shares` / `block_share_members` / `share_links` / `share_link_secrets`, the share definition, audience, link metadata, and isolated token.

**None of this reads block content.** It operates entirely on ids, the tree shape (`parent_id`), and membership tables — all of which are plaintext metadata in *both* plaintext and e2ee workspaces (e2ee encrypts only the three content columns; ids, `workspace_id`, `parent_id`, timestamps stay in clear — see `WireBlockColumns` in [`transform.ts`](../src/sync/transform.ts)). **Plane 1 therefore works identically for e2ee and plaintext workspaces.** A recipient with a share grant receives the ciphertext rows for the covered subtree and nothing else.

This is the load-bearing observation: **e2ee does not break access control. It breaks decryption.** Plane 1 survives wholesale; carry it over from the old doc.

### Plane 2 — Key access (can the recipient decrypt the rows they received)

For a **plaintext** workspace there is no Plane 2; the rows are already readable, and the old design is complete.

For an **e2ee** workspace the recipient now holds ciphertext rows they cannot read. They need *a key*. The only key that exists is the per-workspace WK. The entire design space below is "what key does the recipient get, and how," and each answer trades confidentiality granularity against complexity.

---

## 3. The crux: per-workspace key vs per-subtree share

A single symmetric WK per workspace cannot, on its own, encode "may read subtree T but not its siblings." Whatever key decrypts T's rows decrypts every row sealed under the same key — and today every row in the workspace is sealed under the same WK. So there are only three structural ways out:

1. **Hand over the one key, and rely on a *non-cryptographic* boundary to scope the recipient to the subtree** (RLS decides which rows they ever fetch). → Option B.
2. **Give the shared subtree its own key**, so the key you hand over only opens the subtree. This means a *second encryption domain*. → Option C.
3. **Don't hand over a key at all; produce a plaintext copy of the subtree** at share time and govern it with Plane 1 alone. → Option D (and, trivially, Option A for whole plaintext workspaces).

The sharp question for Option (1) is what "rely on RLS" actually buys under the e2ee threat model. Spell it out, because every reviewer will:

| Adversary | What they can read with the WK |
|---|---|
| Recipient + **honest** server (server enforces RLS / sync rules correctly) | **Only the shared subtree.** RLS never ships them the sibling ciphertext, so the WK has nothing else to open. |
| Recipient + **dishonest / compromised** server (or a server-side bug, or a future RLS regression) | **The entire workspace.** The server holds all ciphertext; the recipient holds the master key; together they reconstruct everything. |

E2EE exists precisely to make the second row impossible. So **handing over the WK silently downgrades the confidentiality of the *whole workspace* to "RLS-enforced," the very trust e2ee was adopted to remove.** That does not make Option B useless — it makes it *not a confidential subtree share*. It is "give someone the workspace key plus a focused, RLS-narrowed sync view." Appropriate when the recipient is someone you'd trust with the whole workspace anyway; wrong as the answer to "share one page with a stranger without exposing my graph." The doc must not blur this. (§6.B)

---

## 4. What the old design loses on an e2ee workspace

Three mechanisms in `subtree-sharing.md` assume the server can read block content. They are fine on plaintext workspaces and **must be disabled or rerouted on e2ee workspaces**:

- **§3.3 / §8.4 read-only snapshot RPC `get_shared_subtree(token)`** returns `{ blocks: [BlockData…] }` as a server-assembled JSON snapshot. On an e2ee workspace the content columns are `enc:v1:` ciphertext, so a `SECURITY DEFINER` server function can only return ciphertext. A recipient can decrypt it *only if they have a key* — which an anonymous link recipient does not. So the snapshot RPC degrades to "ship ciphertext to someone with no key," i.e. nothing. Anonymous read-only e2ee sharing cannot go through this path. (Replacement: §6.D export-to-plaintext, or §6.C key-in-fragment.)
- **§8.6 reference-stub RPC `resolve_block_link_stubs(ids)`** returns `content_label` (leading text, truncated) for blocks the viewer can't fully access, so cross-scope references render as labelled chips. On an e2ee workspace the server cannot produce a label — the content is ciphertext. Cross-scope reference labels must come from the *client*, and only for blocks the client can actually decrypt. For references pointing at rows the recipient never received (and thus can't decrypt), the chip is **id-only / "no access,"** with no human-readable label. This is a real, visible product degradation for e2ee shares; call it out in UI. (§8.2)
- **§3.4 / §9.5 anonymous link-snapshot render** (`SnapshotShareView` fed by `get_shared_subtree`) renders read-only links without an account. It inherits the snapshot RPC's death above for e2ee. Anonymous e2ee links need a fundamentally different mechanism (§6.C/§6.D).

Also inherited from e2ee's standing boundary (e2ee §15): **no server-side features over e2ee shares** — no server-side search across a shared subtree, no AI/embedding/summary, no server-rendered public page, no email-preview of shared content. These were never promised for e2ee workspaces; sharing does not change that.

Two relevant things **survive** e2ee untouched and are worth banking:
- **Read-write write-back works under a shared key.** A recipient editing under the WK writes `enc:v1:` ciphertext, which satisfies `blocks_require_ciphertext_for_e2ee`, and the owner decrypts it with the same WK. No new machinery (true for Option B; Option C needs a bridge — §6.C).
- **The `effective_share_ids` / RLS / stream plumbing** is metadata-only and indifferent to encryption (§2).

---

## 5. Design dimensions

Two orthogonal axes generate the option space. Don't conflate them.

- **Axis 1 — key domain (confidentiality granularity).** *Whole-workspace* (the recipient's key opens the whole workspace; subtree scope is RLS-only) vs *per-share* (a fresh key opens only the shared subtree; subtree scope is cryptographic) vs *none* (plaintext copy; no key).
- **Axis 2 — key delivery (how the recipient obtains whatever key they get).** *Out-of-band* (the user transmits the key over Signal/paper/password-manager; what ships today for whole-workspace shares) vs *wrapped delivery* (server brokers a key wrapped to the recipient's public key; requires the deferred e2ee §13 X25519 hierarchy) vs *key-in-URL-fragment* (the key rides in the `#fragment`, never sent to the server; the classic anonymous-link pattern).

Axis 2 is a pure UX/where-does-the-key-come-from upgrade and applies to whichever key domain you pick. The hard, security-defining choice is Axis 1. The options below are points in (Axis 1 × Axis 2) space.

---

## 6. The options

### Option A — Plaintext-only sharing (capability-gate e2ee out)

**Mechanism.** Ship `subtree-sharing.md` exactly, gated to plaintext workspaces. On an e2ee workspace the "Share…" affordance is disabled (or replaced by "Export…" / "Share whole encrypted workspace," see B/D). The share button reads the local mode pin; e2ee → no subtree share.

**Key domain:** none (plaintext). **Delivery:** n/a.

**Threat model.** Identical to the old doc — RLS is the boundary, which is correct *because the workspace is plaintext and the server already reads it.* No regression, no new promise.

**Enables:** full-fidelity subtree sharing (nested shares, per-user invites, RO/RW links, anonymous snapshot links, server-rendered labels) on every non-encrypted workspace, which is the majority case today.

**Forecloses:** nothing it didn't already; e2ee users simply have no subtree share until a later option lands.

**Complexity:** lowest — it *is* the old design plus a one-line capability gate. Honest and shippable now.

### Option B — Whole-workspace key, RLS-scoped subtree ("scoped-sync share")

**Mechanism.** Plane 1 ships for e2ee workspaces too: the recipient gets a `block_share_members` grant, RLS + the `shared_blocks` stream deliver exactly the covered subtree's ciphertext rows. **Plane 2 is the existing whole-workspace e2ee share**: the recipient is given the workspace WK (out of band today; wrapped delivery once §13 lands) and unlocks via the same key-required gate and workspace-scoped canary that [`shareWorkspace.test.ts`](../src/sync/keys/flows/shareWorkspace.test.ts) already exercises. Their client pins the workspace `e2ee`, holds the WK, and decrypts the rows it received.

Cryptographically this is **indistinguishable from making the recipient a workspace member whose sync view happens to be narrowed to a subtree.** That is its great virtue (almost no new crypto — it's the shipped workspace share plus an RLS row-filter) and its great limitation.

**Key domain:** whole-workspace. **Delivery:** out-of-band (today) → wrapped (§13).

**Threat model.** Per the §3 table: against an honest server the recipient sees only the subtree; against a dishonest/compromised server, or any RLS regression, the recipient-with-WK can reconstruct the *entire* workspace. **This is not a confidential subtree share.** It must be presented as "share with someone you trust with this entire encrypted workspace; the subtree scoping is a convenience, not a cryptographic wall."

**Enables:** read-write collaboration on an e2ee subtree with the full sync/undo/offline machinery, for *trusted* recipients, at near-zero implementation cost over the shipped workspace share. Write-back is free (§4).

**Forecloses:** anonymous/public links (you cannot put the master key in a forwarded URL); genuine "share a page, not my graph" confidentiality; cryptographic revocation (see §8.4 — revoking is meaningless once they hold the WK).

**Complexity:** low. Net delta over what ships: Plane 1's schema/RLS/stream (shared with Option A) + a UI that, on an e2ee workspace, frames the share as whole-workspace-key trust and reuses the existing unlock flow. Arguably so close to "workspace membership with a landing block" that it may not warrant separate billing as a feature — decide in §7.

### Option C — Per-share key domain (cryptographically-isolated subtree)

**Mechanism.** Give the shared subtree its **own** symmetric Share Key `SK`, distinct from the workspace WK, so the key the recipient receives opens *only* the subtree. This is the only option that keeps the e2ee promise — "share a page without exposing the graph" — because the recipient never holds anything that can open a sibling. It is also the only one that admits anonymous links (the fragment carries `SK`, which unlocks only the share). Two sub-variants, differing in where the SK-sealed bytes live:

- **C-in-place (multiple key domains per workspace).** The subtree's blocks stay in the origin workspace but are re-sealed under `SK` instead of the WK. This generalizes the e2ee core from *one key per workspace* to *a key domain per (workspace, key-id)*: `getCek` must resolve per-block-domain, the per-column AAD must bind a `key_id` (today it binds `workspace_id` — [`src/sync/crypto/aad.ts`](../src/sync/crypto/aad.ts)), the `blocks_require_ciphertext_for_e2ee` trigger is still satisfied (still `enc:v1:`), and the owner's client must hold both the WK and every live `SK`. Moderate surgery to the encryption core, but no data duplication. The hierarchy in e2ee §13 (per-workspace CEKs wrapped per member) is the adjacent generalization; this pushes CEK granularity below the workspace.
- **C-projection (a share is a derived workspace).** The subtree is *mirrored* into a new lightweight workspace `W_share` sealed under `SK` (= that workspace's WK), and the recipient is simply a member of `W_share`. This reuses 100% of the existing per-workspace e2ee model with zero core changes — the cost moves to a **re-encryption bridge**: the origin subtree (under WK) and the mirror (under SK) are two ciphertext domains that only a holder of *both* keys (the owner) can reconcile. For editor recipients, their edits land in `W_share` under `SK`; the **owner's client is the relay** that decrypts and re-projects them into the origin under the WK, and vice versa. Live two-way collaboration therefore requires the owner (or some both-keys holder) online; offline, the two domains diverge until a relay runs. This is a genuine CRDT/relay subsystem — the heaviest part of the whole design.

**Key domain:** per-share. **Delivery:** out-of-band, wrapped (§13), or key-in-fragment (anonymous).

**Threat model.** Strong: a recipient (even colluding with a hostile server) can decrypt only the shared subtree, because `SK` was never derivable from anything outside the share and the WK was never handed over. Revocation is *cryptographically meaningful*: rotate `SK`, re-seal the (small) shared subtree, stop the leak going forward — far cheaper than rotating a whole-workspace WK.

**Enables:** the real product promise (confidential subtree sharing on e2ee), anonymous key-in-fragment links, meaningful revocation, and (with §13) server-brokered delivery with no out-of-band step.

**Forecloses:** simplicity. C-in-place perturbs the encryption core (key-id in AAD, per-domain `getCek`, key management for N live SKs and their re-wrapping per member); C-projection adds the owner-relay reconciliation subsystem and duplicate storage (including duplicate media objects re-uploaded under `SK`, defeating the workspace-wide dedup the media design banks on).

**Complexity:** high. This is a project, not a follow-up commit. Defer behind a concrete requirement.

### Option D — Export-to-plaintext snapshot (for read-only / public / anonymous)

**Mechanism.** At share time the **client** decrypts the subtree (it holds the WK) and writes a **plaintext** copy governed by Plane 1 alone — either into a dedicated plaintext "published" workspace, or as an immutable server-side snapshot blob produced by the client. The shared artifact is plaintext from then on; the server can read, render, label, and serve it, and anonymous link recipients need no key. This is the e2ee-world realization of the old `get_shared_subtree` snapshot, with the decrypt moved to the *client* before publication. It matches the media design's own "export-to-plaintext" plan for public media.

**Key domain:** none after export. **Delivery:** n/a (it's plaintext).

**Threat model.** The owner is making a deliberate, explicit decision to **declassify** the subtree: once exported, that copy is plaintext on the server with the old RLS-only boundary, and updates to the encrypted original do *not* propagate (it's a snapshot, or a separate plaintext workspace the user maintains). The UI must make the declassification unmistakable ("This will store a readable copy on the server; future edits won't sync to it"). No live link to ciphertext, so no key-leak surface.

**Enables:** "share this page read-only with the world / with someone with no account," server-rendered previews, labels, and search *of the exported copy* — the things e2ee otherwise forecloses — at the cost of those bytes no longer being end-to-end encrypted.

**Forecloses:** live updates and read-write on the shared artifact; confidentiality of the exported copy.

**Complexity:** low-to-moderate. Client decrypt + a publish target (reuse plaintext-workspace machinery or a snapshot table). No changes to the encryption core.

### The delivery upgrade (Axis 2), applied later

Independently of A–D, the e2ee §13 hierarchy (per-user X25519 keypair, per-workspace CEK wrapped per member, server-brokered delivery) removes the out-of-band step from **B** and **C** without changing their key-domain semantics: the owner wraps whatever key (WK for B, SK for C) to the recipient's published public key, the server stores and relays the wrapped blob, and the recipient unwraps it locally. This is the path to "click invite, recipient just gets access" without ever trusting the server with a usable key. It is additive and out of scope for v1, but B and C should be designed so their key-delivery call site is the same seam `getCek`/key-store already exposes, so the upgrade is a delivery swap, not a redesign.

---

## 7. Recommendation — a phased hybrid

Make the planes explicit in the product, and be honest per workspace mode.

**Phase 1 — ship the access-control plane; full sharing on plaintext workspaces.**
- Implement Plane 1 from `subtree-sharing.md` (schema, recompute, RLS, `shared_blocks` stream, RPCs, routing, share-mode bootstrap, dialog). It is crypto-agnostic, so it lands once and serves every later option.
- On **plaintext** workspaces this delivers the entire old design (Option A): nested shares, invites, RO/RW links, anonymous snapshot links, server labels. This is the bulk of the user value and carries no e2ee risk.
- On **e2ee** workspaces, the "Share…" affordance does **not** offer a confidential subtree share yet. It offers exactly two honestly-labelled things:
  - **(B) "Share with a collaborator you trust with this workspace."** Reuses the shipped whole-workspace e2ee share (`shareWorkspace`) plus an RLS-narrowed sync view onto the subtree. UI states plainly that the recipient holds the workspace key. Best framed as a focused entry point for someone you'd add to the workspace anyway — possibly just a thin wrapper over "add member + landing block," to avoid implying a confidentiality wall that isn't there.
  - **(D) "Publish a read-only copy."** Client decrypts and exports the subtree to a plaintext published surface; works for public/anonymous read-only links; declassification is explicit.

**Phase 2 (deferred, requirement-gated) — confidential subtree sharing on e2ee (Option C).**
- Only build this when there is a real need for "share a page, not my graph" *on encrypted workspaces with live collaboration*. It is a substantial project (new key domain or a re-encryption relay) and should ride in on the e2ee §13 hierarchy so key delivery and revocation come together. Prefer **C-in-place** if the encryption-core change (key-id in AAD, per-domain `getCek`) proves cheaper than **C-projection**'s owner-relay reconciliation; prototype both against the media-dedup and offline-collaboration constraints before committing.

**Why this ordering.** It ships the most value (plaintext sharing) with the least risk first; it never makes a confidentiality promise the crypto doesn't keep (the B/D split is brutally explicit about what's protected); it stays consistent with the media design's deferral of encrypted subtree sharing and its export-to-plaintext plan; and it sequences the hard cryptographic work (C) behind both a concrete requirement and the §13 delivery hierarchy it depends on.

---

## 8. Cross-cutting concerns

### 8.1 Media inside a shared subtree

A shared subtree may embed media. Per the media design, an asset lives at `<workspace_id>/HMAC(K_id, sha256(plaintext))`, sealed `encb:v1:` under the WK, with `K_id = HKDF(WK, …)`.

- **Option B:** free. The recipient holds the WK, so they derive the same `K_id`, compute the same content path, fetch the same ciphertext object (Storage RLS must also grant the recipient `GET` on the covered objects — the media design's per-workspace bucket RLS must be extended to honor share membership, an access-plane addition), and decrypt. Dedup is preserved.
- **Option C:** hard. The subtree is sealed under `SK`, but the asset bytes were uploaded under the WK with a WK-derived path. Either the recipient is somehow given the WK-derived `K_id` (which is a partial WK capability — leaks the content-path oracle for the *whole* workspace, undermining C's isolation), or the media is **re-encrypted and re-uploaded under `SK`** with an `SK`-derived path (clean isolation, but defeats workspace-wide dedup and duplicates bytes per share). C-projection makes this explicit: the mirror workspace re-uploads its media. This is a real cost of cryptographic isolation and a reason C is Phase 2.
- **Option D:** the client decrypts the bytes and re-publishes them as plaintext objects alongside the exported text. Standard declassification.

### 8.2 References crossing the share boundary

The old §8.6 server-label RPC is dead for e2ee (§4). For e2ee shares:
- A reference whose target row the recipient **received and can decrypt** → render normally (client has the plaintext).
- A reference whose target is **outside the share** (recipient never received the row) → an **id-only / "no access" chip with no label**, because neither the server (ciphertext) nor the client (no row, no key) can produce one. This is strictly worse than the plaintext-workspace experience and must be visible in the share UI as a known limitation.
- Presentation-root clipping (old §3.8) is unchanged — it's tree-shape metadata.

### 8.3 Multi-workspace / mode-pin client state

Under Option B the recipient now holds a WK and a mode pin for a workspace they are not a *full* member of (they have only a subtree via the share). The client's workspace resolution ([`src/bootstrap/resolveWorkspace.ts`](../src/bootstrap/resolveWorkspace.ts), [`decideWorkspaceEntry`](../src/sync/keys/workspaceAccess.ts)) must treat "I hold this workspace's WK but only a subtree synced" as a first-class state, not assume key-presence implies full membership. The old doc's share-recipient routing/clipping (`#share/<token>`, `setActiveWorkspaceId`, clip at `root_block_id`) still applies; the addition is that entering an e2ee share must drive the *same* unlock/canary gate a normal e2ee workspace entry does.

### 8.4 Revocation semantics differ sharply by option — say so

- **Plaintext (A) / export (D):** revocation = RLS stops new fetches; the recipient keeps whatever already synced locally (the old doc's existing caveat). Exported plaintext copies stay readable wherever they landed.
- **Option B (whole-WK):** revocation is **cryptographically void**. Once the recipient holds the WK they can decrypt any workspace ciphertext they ever obtained or can still obtain, regardless of the membership row. True revocation requires rotating the workspace WK — i.e., re-encrypting the *entire* workspace and re-distributing the new WK to all legitimate members — which is exactly the expensive operation e2ee otherwise avoids. The B share UI must state that revocation removes *access going forward via an honest server*, not cryptographic capability. This is the strongest argument against treating B as real subtree sharing.
- **Option C (per-share SK):** revocation is **meaningful and cheap**: rotate `SK`, re-seal only the (small) shared subtree, re-wrap to remaining members. The recipient keeps what they already pulled but is cryptographically locked out of everything after rotation. This asymmetry (cheap, scoped re-key) is a principal reason C is the *correct* long-term answer for confidential sharing even though it's deferred.

### 8.5 Threat-model statement to put in the doc/UI

E2EE's invariant is "the server never holds plaintext or a usable key." Each option's effect on that invariant:
- A: unaffected (plaintext workspace; invariant didn't apply).
- B: **the invariant now rests on the recipient's trustworthiness and the server's honesty for the whole workspace** — a deliberate, scoped relaxation, acceptable for trusted collaborators, unacceptable as a general "share with anyone" primitive.
- C: invariant preserved; recipient is cryptographically confined to the subtree.
- D: the **exported copy** is deliberately declassified to plaintext; the original workspace's invariant is untouched.

---

## 9. Open questions

1. **Is confidential subtree sharing on e2ee actually a requirement, or is whole-workspace e2ee sharing + plaintext subtree sharing + export enough?** If the small, coordinatable fleet never needs "share one encrypted page with an untrusted stranger, live," then C may never need to ship, and the recommendation collapses to "A + B + D." This should be answered by product need, not built speculatively.
2. **C-in-place vs C-projection** if C is ever built: which is cheaper given (a) the media-dedup constraint and (b) the offline-collaboration constraint (owner-relay vs always-online)? Prototype before choosing.
3. **Does Option B deserve to exist as a distinct feature**, or is it just "add the recipient to the workspace with a landing block," with the share UI being misleading framing for a workspace membership? If the latter, v1 e2ee sharing is purely A (n/a) + D, and B is replaced by a clearer "add collaborator" affordance.
4. **Storage-object RLS for shared media** (§8.1) — the media bucket's per-workspace RLS must learn about share membership for Option B; scope that work into Plane 1 or the media design, not as an afterthought.
5. **Key-in-fragment hygiene for any future C anonymous link** — fragment handling, history/Referer leakage, copy-paste of the key-bearing URL — is a known hazard class to design carefully when/if C anonymous links happen.

---

## 10. Mapping to existing code seams

| Concern | Existing seam | Change for sharing |
|---|---|---|
| Encrypt/decrypt on the wire | `encodeForWire` / `decodeFromWire`, [`src/sync/transform.ts`](../src/sync/transform.ts) | unchanged for B (same WK via `getCek`); C-in-place needs per-domain `getCek` + key-id AAD |
| Key lookup | `getCek(workspaceId)`, [`resolver.ts`](../src/sync/keys/resolver.ts) | B: unchanged; C-in-place: resolve per (workspace, key-id); §13 delivery: swap source to unwrapped-CEK map |
| Mode authority | mode pin, [`modePin.ts`](../src/sync/keys/modePin.ts); gate [`workspaceAccess.ts`](../src/sync/keys/workspaceAccess.ts) | B: a share-entry must drive the same key-required gate; new "WK held but only subtree synced" state (§8.3) |
| Whole-workspace e2ee share | invite + out-of-band WK + canary, [`shareWorkspace.test.ts`](../src/sync/keys/flows/shareWorkspace.test.ts) | B reuses this verbatim |
| Server ciphertext guard | `blocks_require_ciphertext_for_e2ee`, [`migration`](../supabase/migrations/20260529120000_add_e2ee_workspace_columns.sql) | unchanged — recipient writes (B) and SK writes (C) are still `enc:v1:` |
| Access control (Plane 1) | *none yet* — `subtree-sharing.md` design | implement once, crypto-agnostic; serves A/B/C/D |
| Media content path/seal | `HMAC(K_id,…)`, `encb:v1:`, media design | B: extend Storage RLS to share members; C: re-key/re-upload (§8.1) |
| Read-only snapshot | `get_shared_subtree` (old §8.4) | dead for e2ee; replace with D export (or C key-in-fragment) |
| Reference labels | `resolve_block_link_stubs` (old §8.6) | dead for e2ee; client-only labels, id-only chip otherwise (§8.2) |

---

## 11. Grounding notes (verified 2026-06-24)

- E2EE seam, columns, AAD, ciphertext guard, mode pin, canary, key store, and the existing whole-workspace share flow all confirmed present in code: [`src/sync/transform.ts`](../src/sync/transform.ts), [`src/sync/crypto/aad.ts`](../src/sync/crypto/aad.ts), [`src/sync/crypto/canary.ts`](../src/sync/crypto/canary.ts), [`src/sync/keys/`](../src/sync/keys/) (`resolver.ts`, `modePin.ts`, `workspaceAccess.ts`, `keyStore.ts`, `flows/`), [`supabase/migrations/20260529120000_add_e2ee_workspace_columns.sql`](../supabase/migrations/20260529120000_add_e2ee_workspace_columns.sql).
- The three encrypted columns are exactly `content`, `properties_json`, `references_json` (`CONTENT_COLUMNS` in `transform.ts`); ids, `workspace_id`, `parent_id`, timestamps stay plaintext (`WireBlockColumns`).
- **No sharing schema exists yet** — `block_shares` / `effective_share_ids` / `block_share_members` / `share_links` are absent from all migrations (grep returned nothing). The access-control plane is still design-only, so it can be co-designed with the key plane.
- Media facts (`HMAC(K_id)` content path, `K_id = HKDF(WK,…)`, `encb:v1:`, in-thread decrypt, export-to-plaintext for public, encrypted subtree sharing deferred) are from `docs/media-attachments/design.html` on `claude/media-attachments-design`, design-only.
- E2EE design facts (per-workspace WK, no asymmetric crypto in v1, §13 deferred hierarchy, "no server-side features for e2ee," out-of-band key transfer) are from `docs/e2ee-design.html`; that doc's status banner is "superseded in places," so load-bearing claims here are pinned to code, not the doc.

## 12. References

- [`docs/subtree-sharing.md`](subtree-sharing.md) — the access-control-plane design this layers on (Plane 1).
- [`docs/shares-and-api-tokens.html`](shares-and-api-tokens.html), [`docs/share-aliases-explainer.html`](share-aliases-explainer.html) — related share-surface designs (API tokens, alias collision handling), both design-only/unverified.
- [`docs/e2ee-design.html`](e2ee-design.html), [`docs/e2ee-rejected-alternatives.html`](e2ee-rejected-alternatives.html), [`docs/lock-and-wipe-coarse-recommendation.md`](lock-and-wipe-coarse-recommendation.md) — the encryption model and its deferred hierarchy (§13).
- `docs/media-attachments/design.html` (branch `claude/media-attachments-design`) — encrypted byte storage, content-addressing, and its own deferral of encrypted subtree sharing.
