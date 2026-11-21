# Selective sharing: share a collection of pages or subtrees with a guest

> **Status:** proposal, nothing built. Independent draft, written before reading the earlier
> sharing design. Code claims last verified against code 2026-11-21.

## 1. Goal

Let a workspace owner give another person access to **some** of a workspace: one page, one
subtree, or a named collection of several, without giving them the rest. The baseline is shared
editing. It has to work for end-to-end-encrypted (e2ee) workspaces.

Terms used below:

- **share**: a named collection with its own member list and one or more roots.
- **root**: a block attached to a share. The root and everything under it is shared.
- **region**: the set of blocks whose *nearest* enclosing root belongs to one share. Every block
  is in at most one region. Blocks in no region are the **remainder** of the workspace.
- **guest**: a user who is a member of a share but not of the workspace.
- **member**: a workspace member, as today (`workspace_members`).

Not in scope: public or anonymous links, a guest reading history, presence, API tokens, mounting
a share inside the guest's own workspace (§13).

## 2. What the code does today

| Fact | Where |
|---|---|
| Every authorization decision keys on whole-workspace membership: row-level security, the sync stream, Storage. | `supabase/migrations/20260510222352_consolidated_initial.sql` (`blocks_read`, `blocks_write`), `powersync/sync-config.yaml`, `…20260625000000_add_attachments_storage.sql` |
| The upload RPCs (`apply_block_creates`, `apply_block_patches`) run as the caller and rely on row-level security. Patches are per-column last-writer-wins; there is no compare-and-swap. | `…20260709000000…`, `…20260803000000…` |
| The server has no tree concept. `parent_id` is a deferred foreign key inside one workspace; `workspace_id` is immutable; `id` is a global primary key. | `consolidated_initial.sql` |
| An e2ee workspace has one key (WK), handed to other people out of band (paste). Nothing key-related is stored server-side except a canary. The key is held as a non-extractable `CryptoKey`. | `src/sync/keys/`, `src/sync/crypto/workspaceKey.ts` |
| Three columns are sealed (`content`, `properties_json`, `references_json`); ids, `parent_id`, `order_key` and timestamps are cleartext. The envelope is `enc:v1:` + nonce + ciphertext and names no key. | `src/sync/transform.ts`, `src/sync/crypto/envelope.ts` |
| The local database holds plaintext. Sealing happens on upload and opening happens when a staged row (`blocks_synced`) is materialized into `blocks`; both look the key up by workspace id. | `src/services/powersync.ts`, `src/data/internals/syncObserver/materialize.ts` |
| One local database holds every workspace of the user; a session has exactly one active workspace and one property-definition registry. | `src/data/clientContext.ts`, `src/data/repo.ts` |
| Read-only is one boolean per session. The commit pipeline rejects document writes; UI-state and preference writes still upload and are rejected by the server into the quarantine. | `src/data/internals/commitPipeline.ts`, `src/data/api/changeScope.ts` |
| A property is a child block whose content is `::((fieldId))`; `fieldId` is the id of a definition block under the Properties page. Seeded definitions resolve from code with no row; user-defined ones need the row. | `src/data/propertyChildren.ts`, `src/data/propertyDefinitionRegistry.ts` |
| A media block lives under the Assets page and is embedded by id; its bytes are at `<workspace_id>/<contentKey>`. | `src/plugins/attachments/` |
| Comment threads live under a per-workspace "Comments" page. | `src/plugins/annotations/container.ts` |

## 3. The first decision: where shared content lives

**A. Regions inside the workspace (recommended).** Shared blocks stay where they are. The server
learns which blocks are under a share root and gives guests exactly those rows.

**B. A separate workspace per share.** A share is an ordinary workspace with both people as
members; sharing a page means moving it there.

B needs no new server authorization and no new cryptography, and a guest gets a complete, ordinary
workspace. It is what the app can already do today, minus "move a page to another workspace". But
the page leaves the owner's graph: backlinks, queries, search, typed properties and daily-note
references stop reaching it, and a subtree cannot be shared *in place* (it has to be cut out of
its parent). Putting that back means the client presenting several workspaces as one graph, which
touches every layer that assumes one active workspace (about 175 reads of `activeWorkspaceId`,
transactions pinned to one workspace, one definition registry). A cross-workspace move also has
to re-mint ids, rewrite every reference, remap property definitions and re-encrypt.

A keeps one graph for the owner and concentrates the cost at the sync boundary and in a guest
session. Its risks are real and different: new server code decides who can read what, and a guest
client holds a partial workspace. §6 and §7 are mostly about containing those two.

The rest of this document designs A.

## 4. Model

- A **share is a block**: a `share`-typed block under a lazily created per-workspace "Shares"
  page. Its content is the share's name. Its id is the share id. It is the first root of its own
  share, so anything created *inside* the share that has no better home (a page a guest creates,
  definition stand-ins, a comments container) lives under it and is in the region automatically.
  For the owner it is an ordinary page that also lists the share's other roots.
- Other roots are attached to the share by reference, not by moving them. A root stays where it is
  in the owner's tree.
- **Nearest root wins.** A block's region is decided by the nearest root at or above it. A share
  root inside another share's region carves its own region out of the outer one.
- Access is per region, by role: `editor` or `viewer`. A member's access is unchanged: members see
  and write every region.
- Access follows tree position. Moving a block under a root shares it; moving it out unshares it.

"Share this page" in the UI creates a share named after the page and attaches the page as a root.
"Add to share…" attaches another root to an existing share.

## 5. Server

### 5.1 Tables

```
shares            (id, workspace_id, wrapped_key, key_canary, created_by, create_time)
share_roots       (share_id, block_id UNIQUE, workspace_id, create_time)
share_members     (id, share_id, workspace_id, user_id, role, create_time)   -- role: editor | viewer
share_invitations (id, share_id, workspace_id, email, role, invited_by_user_id, create_time)
blocks.share_id   text NULL          -- the block's region. Server-maintained only.
```

`shares.id` is the share block's id; the share block is an implicit root. `wrapped_key` and
`key_canary` are null for a plaintext workspace (§6). Guests are deliberately **not**
`workspace_members` rows: every existing policy tests that table, so a guest stays locked out of
everything this design does not explicitly open.

All four tables are written only through `SECURITY DEFINER` RPCs callable by the workspace owner
(`create_share`, `delete_share`, `add_share_root`, `remove_share_root`, `invite_to_share`,
`accept_share_invitation`, `remove_share_member`, `set_share_member_role`), mirroring the member
RPCs. `invite_to_share` refuses someone who is already a workspace member.

### 5.2 Keeping `blocks.share_id` right

The rule: `share_id` = the share of the nearest block at or above this one that is in
`share_roots`, else null.

- **Insert, or `parent_id` change** (`BEFORE` trigger): if the block is a root, its own share;
  otherwise the parent's `share_id`, read with `FOR SHARE` on the parent row. The client's value
  is always overwritten, so it cannot be forged.
- **Cascade** (`AFTER`, when the value changed, and from `add_share_root` / `remove_share_root` /
  `delete_share`): update the children that are not roots, level by level, one statement per
  level, until a level changes nothing.
- Region does not look at `deleted`: a tombstone keeps its region, so a restore lands where it was.

Locking the parent and cascading one level per statement closes the race between a move and a
concurrent insert below it: an insert under a row the cascade has not reached waits on that row's
lock and then reads the new region; an insert that got there first is committed before the
cascade's next level reads. The property to hold is **never over-share**: a row must never keep a
region its ancestor chain no longer supports.

The trigger functions are `SECURITY DEFINER` (a guest's write must be able to read its parent's
region and cascade), and `share_id` is excluded from `blocks_history` diffs and from the version
bump, so sharing ten thousand rows writes no history and does not look like ten thousand edits.

### 5.3 Row-level security

```
blocks read:   member(workspace_id)  OR  share_id in my shares
blocks write:  writer(workspace_id)  OR  share_id in my editor shares      (USING and WITH CHECK)
```

`WITH CHECK` runs after the `BEFORE` trigger, so it tests the region the row *ends up* in: a guest
cannot create a block outside their regions, move one out, or move one in. A guest gets no
`DELETE` policy (the client only soft-deletes). `blocks_history` stays member-only.

Three further checks on a write by someone who is not a workspace writer, in the same trigger:

1. A root row's `parent_id`, `order_key` and `deleted` cannot change. A guest can edit a shared
   page's title and contents but cannot delete, move or reorder the page itself; its siblings are
   rows they cannot see.
2. In an e2ee workspace, each content column written must be a v2 envelope naming the row's
   region (§6.2).
3. `share_id` must be non-null after the trigger (already implied by the policy; stated so the
   trigger fails with a readable error).

### 5.4 Sync

Members: the existing `workspace_data` stream gains `blocks_synced.share_id` and three queries
for `shares`, `share_roots`, `share_members` filtered by `workspace_id IN user_workspaces`.

Guests: a second auto-subscribed stream.

```yaml
share_data:
  auto_subscribe: true
  with:
    user_shares: SELECT share_id FROM public.share_members WHERE user_id = auth.user_id()
  queries:
    - SELECT … FROM public.blocks blocks_synced WHERE blocks_synced.share_id IN user_shares
    - SELECT … FROM public.shares        WHERE shares.id IN user_shares
    - SELECT … FROM public.share_roots   WHERE share_roots.share_id IN user_shares
    - SELECT … FROM public.share_members WHERE share_members.share_id IN user_shares
```

plus the guest's `workspaces` row (name, `encryption_mode`, `properties_migration`), keyed on
`share_members.workspace_id`, in this stream or a third one. `IN (subquery on auth.user_id())` is
the documented Sync Streams shape. A guest gets one bucket per share; the limit is 1,000 per user.
Members keep one bucket per workspace, which the create RPC's ordering argument depends on.

To verify in a spike before building on it: a parameter-table change (a new `share_members` row)
adds the bucket to a connected client without a reconnect; a row moving between two of one user's
buckets arrives as one consistent checkpoint; the `workspaces` query can share the stream.

## 6. End-to-end encryption

### 6.1 Share key

Each share in an e2ee workspace has its own random 32-byte key, **SK**. A region's rows are sealed
under its share's SK; the remainder stays under WK.

- `shares.wrapped_key` is SK sealed under WK, with associated data binding the share id and
  workspace id. Any device holding WK reads the synced `shares` row and unwraps SK. Nothing has to
  be handed between the owner's own devices or to other members, and the existing non-extractable
  WK handle is enough (unwrap is an AES-GCM decrypt), so no member device has to re-enter its key.
- `shares.key_canary` is the share id sealed under SK. A guest's client checks a pasted key
  against it, as `wk_canary` does for WK.
- A guest gets SK the way a collaborator gets WK today: the owner copies it (`kmp-sk-1:…`) and
  sends it over a channel of their choosing; the guest pastes it into a key gate after accepting
  the invitation. The server never sees it.
- A **key context** is `{content key, K_id}`: SK plays WK's role for its region, including the
  derived HMAC subkey that names attachment objects and namespaces derived ids. The key store
  gains records keyed by share id with the same shape as today's.

A guest never holds WK. A guest colluding with the server can read exactly what was ever sealed
under an SK they hold.

### 6.2 Envelope v2 names its key

```
enc:v1:<payload>            sealed under WK                 (unchanged; all existing data)
enc:v2:<share_id>:<payload> sealed under that share's SK
```

Associated data for v2 adds the share id. Existing rows need no migration. The server's
`is_enc_v1_envelope` check widens to accept both. Because each column names its key, a row whose
three columns are sealed under different keys (a patch touched one column after the region
changed) is still fully readable by anyone holding both keys, and the mismatch is visible without
decrypting anything.

Key lookup changes from "by workspace" to "by workspace and key id" at its two call sites
(`encryptUploadOps`, `materializeStagingRows`). A staged row a client cannot open yet (no key for
that id) stays staged, per row, as a locked e2ee workspace's rows do today.

### 6.3 Which key a write is sealed under

At upload, the client computes the row's region structurally (walk local ancestors to the nearest
id in `share_roots`) and seals under that region's key. A workspace with no shares skips the walk.

The server does not reject a member's write sealed under the "wrong" key. A device that has not
yet heard about a share, or about a move, will seal under WK; rejecting that would turn a stale
view into a lost edit. Instead:

### 6.4 The re-key pass

**Invariant:** every sealed column of a row names its region's key.

**Drift** is a row that breaks it. It arises from sharing a subtree (rows are WK, region is now
S), unsharing, a move across a region boundary (a move patches `parent_id` only; descendants are
not touched at all), and a stale device's edit. All of them are the same state, detectable from
cleartext alone: `blocks_synced.share_id` against the key id in each envelope.

Any client that can open a drifted row and holds its region's key repairs it: re-seal the three
columns under the region's key and send them through a new RPC, `rekey_blocks`, which updates a
row **only if its `updated_at` still equals the version the client decrypted**, and preserves
`updated_by` / `user_updated_at`. A lost compare-and-swap is skipped and picked up again when the
newer row arrives. The pass is idempotent, has a fixed point (no drifted rows), and two devices
running it at once cannot clobber an edit. It runs over the active workspace only.

Why this is safe to run continuously: the local database is plaintext, so re-keying changes no
local row, creates no undo entry, and is not an edit; it replaces ciphertext with ciphertext of
the same plaintext, guarded by the row version.

"Share this page" is therefore: create the share, attach the root (the server flips N regions in
one transaction), then let the pass re-key N rows, with progress shown. Guests see rows appear as
they are re-keyed. Unsharing is the same pass in the other direction.

What drift means for confidentiality:

| Row | Delivered to guest? | Guest can open? |
|---|---|---|
| in region, sealed under SK | yes | yes |
| in region, still sealed under WK (drift in) | yes | no; appears once re-keyed |
| left the region, still sealed under SK (drift out) | no | (not delivered) |

So in an e2ee workspace a server-side region bug alone cannot disclose plaintext: disclosure needs
a member's client to re-key the row.

### 6.5 Plaintext workspaces

Everything in §5 applies and nothing in §6 does: no keys, no envelopes, no pass. Sharing takes
effect the moment the region flips.

## 7. The guest's client

A guest has, locally, rows of someone else's workspace: the regions they were given and nothing
else. The share roots' parents are absent.

### 7.1 Session

- Access to a workspace becomes `member(role)` or `guest`, derived from local rows
  (`workspace_members`, else `share_members`). Today a missing member row reads as "writable";
  that default must not apply to a guest.
- A guest workspace appears in the switcher under "Shared with me". Opening it lands on a share
  page (the share block), which lists that share's roots. A share root is a top of the tree for
  the guest: breadcrumbs and ancestor walks already stop at a missing parent
  (`src/data/internals/treeQueries.ts`, `src/utils/blockCrumbs.ts`).
- Bootstrap takes the path a workspace `viewer` takes today: kernel pages are get-only, seeds and
  backfills are skipped (`src/data/kernelPage.ts`, `src/data/definitionSeeds.ts`).

### 7.2 Writes

- **One gate, in the commit pipeline.** The session's read-only boolean becomes "which rows may
  this session write": everything (member writer), nothing (viewer), or rows whose region is one
  of my editor shares (guest). The check runs inside the writing transaction over every row the
  transaction touched, on both its before and after position. A document write outside a writable
  region throws before anything is queued. The server enforces the same rule (§5.3); the client
  gate exists so a refused write never becomes a local phantom.
- **UI affordances** ask the same predicate per block (`repo.canEdit(block)`) instead of the
  session boolean, so a viewer share and an editor share in one workspace behave differently.
- **Roots are structurally locked** for a guest: no delete, move, indent or reorder of a root.
- **UI state stays on the device.** A guest's layout, recents and preferences are blocks outside
  every region. The uploader partitions a guest's queue by region before sealing: rows in a held
  share are sealed and sent; the rest go straight to the local rejection quarantine without a
  round trip. This is what already happens to a workspace viewer's UI-state writes, decided
  locally instead of by the server, and it is required in e2ee mode, where a guest has no key to
  seal such a row with and the write would otherwise hold the queue forever.

### 7.3 Processors on a partial workspace

This is the highest-risk part of the design. Post-commit processors read the local index and treat
it as the whole workspace. On a guest that is false, and two kinds of harm follow:

- writes outside a region: caught by the gate (they throw), so a usability problem;
- writes **inside** a region that are wrong because of what the guest cannot see: silent damage to
  the owner's data.

Known members of the second kind, from a read of the processors:

| Processor | What goes wrong on a guest |
|---|---|
| orphan alias / seat reaping (`src/plugins/references/referencesProcessor.ts`) | tombstones a page in the region because no *local* block references it |
| `[[alias]]` resolution and seat minting | mints a duplicate page for a name that exists outside the region |
| property-children projection into `properties_json` (`src/data/internals/propertyChildrenProcessor.ts`) | drops a key whose definition is not local, then uploads the smaller bag |
| type and schema authoring (typeify, definition edits) | creates definitions the owner's registry does not expect |
| contributor attribution | writes references to pages outside the region |

The rule: **a processor runs in a guest session only if it is declared safe for a partial
workspace.** The default is not to run. Each processor is classified once (safe as is, safe with a
guest variant, skipped), and the classification is a property of the registration, not a check
inside each processor. Skipped derivations are not lost: the owner's client derives them when the
guest's edit arrives, as it does for any synced row.

Read-only guests run no document writes at all, so none of this applies to them. That is why the
build order (§11) ships read-only guests first and enables editing behind the audit.

## 8. What a region depends on outside itself

| Dependency | Without it the guest sees | Plan |
|---|---|---|
| seeded property and type definitions | nothing missing; they resolve from code | none needed |
| user-defined property definition | the field row as a raw `::((id))` child | read-only "property not shared" row first; stand-ins later |
| user-defined type definition | an untyped block | same |
| media block and its bytes | a missing-block placeholder | §8.2 |
| a `[[page]]` outside the region | the link text, not navigable | add the page to the share |
| a `((block))` outside the region | "not shared with you" placeholder | add it to the share |
| comment threads | none | §8.3 |
| ancestors, siblings of a root | nothing; the root is the top | intended |

### 8.1 Definition stand-ins

A definition cannot simply be attached as another root: one definition is used by several shares
and a block has one region, and a type definition can be any block, with arbitrary content under
it. Instead a share carries **stand-ins**: one small block per user-defined definition used in the
region, under the share block, holding a copy of what a reader needs (name, codec, options) and
registered in the guest's registry under the **original** definition id, read-only. Field rows are
not rewritten.

Stand-ins are derived data that members' clients write. To keep that from becoming a standing
reconciliation loop, they are written in the same transaction as their cause where there is one
(setting a property inside a region; editing a definition fans out to its stand-ins as
`core.migratePropertyDefinition` fans out to consumers), with a deterministic id per (share,
definition) so two devices converge on one row. The share and re-key operations, which already
scan the region, create the initial set.

### 8.2 Media

A media block is attached to the share as an extra root (it has no subtree beyond its own field
rows). Its bytes follow the key context: an object for region S lives at `<share_id>/<contentKey>`
with the content key derived under S's `K_id` and the bytes sealed under SK; Storage policy keys
on the first path segment being a share the caller belongs to (or a share of a workspace the
caller is a member of). The re-key pass, when it meets a media block in a region whose region
object is missing, uploads the copy. A guest's own uploads go to the same place, under the share
block. An image used in two shares is the uncommon case and is reported, not solved, at first.

### 8.3 Comments, and a comment-only role

Threads live under the workspace "Comments" page, outside every region, so guests neither see nor
write them. Two steps, both later: (1) threads on a block in a region are parented under that
share's block instead; (2) a `commenter` role is a region rule, not a content rule: a commenter
may write only under the share's comments container. That is enforceable on the server in e2ee
mode, where the server cannot tell a comment from an edit by reading it.

**Read-only is cheap; comment-only is not.** A viewer role costs a column and one policy clause
and falls out of the build order. A commenter role needs (1) and (2).

## 9. Owner experience

- "Share…" on any block: pick or create a share, invite by email with a role, copy the share key
  (e2ee). The dialog lists roots, members, pending invitations and re-key progress.
- A root shows a badge; a block inside a region shows who can see it in its breadcrumb.
- Moving or pasting blocks **into** a region from outside asks once ("this shares N blocks with
  …"). It is the one gesture that discloses existing content without the user having opened a
  share dialog. Typing inside a region does not ask.
- Attaching a root inside an existing share's region is refused in the first version: it would
  silently take that subtree away from the outer share's guests. Moving one shared page under
  another is fine and changes nobody's access (nearest root wins, both regions survive).

## 10. Corner cases

| Case | Result |
|---|---|
| Member moves a subtree into a region | server flips regions; rows drift; pass re-keys; guests see them |
| Member moves a subtree out | guests lose the rows on next sync; pass re-keys back to WK |
| Offline member edits a newly shared block, sealing under WK | accepted; that column drifts; guest keeps the previous version until re-keyed |
| Guest's pending edits when access is revoked or the block leaves the region | the patch finds no row it can write and is quarantined on the guest's device, as for a removed member today |
| Owner soft-deletes a root | region and share stay; restore brings it back shared |
| Share deleted | regions revert to the enclosing region or the remainder; pass re-keys; SK is no longer used |
| Guest removed | the server stops delivering; SK is not rotated (they held the plaintext). Rotation is "delete the share and create a new one" until a real rotation exists |
| Guest becomes a workspace member | rows arrive through both buckets; harmless |
| Plaintext-to-e2ee conversion of a workspace with shares | conversion preflight refuses; remove the shares first |
| Guest renames a shared page | references inside the region are rewritten; link text outside it goes stale (the link still resolves by id) |

## 11. Build order

Each step is a PR or a few; each ends in something usable.

0. **Spike.** The three Sync Streams questions in §5.4; a two-session test of the region trigger
   under concurrent move and insert.
1. **Regions on the server, read-only guests, plaintext workspaces.** Tables, triggers, policies,
   streams, share RPCs, the share dialog, guest session as a viewer.
2. **Keys.** SK, envelope v2, key lookup by key id, `rekey_blocks` and the pass, the guest key gate.
   After this step an e2ee workspace can share read-only.
3. **Guest editing.** The per-row write gate, `canEdit`, root locking, the uploader partition, the
   processor classification.
4. **Dependencies.** Definition stand-ins; guest-created pages under the share block.
5. **Media in regions.**
6. Later: comments and the commenter role, invite links that carry the key in the URL fragment,
   key rotation.

Verification that is part of the work, not after it: a pgTAP matrix over {member, guest editor,
guest viewer, stranger} × {read, insert, edit, move in, move out, root structure}; region
recompute cases including insert-before-parent under the deferred foreign key; a property test
that the re-key pass never changes plaintext and never overwrites a concurrent edit; a
partial-workspace fuzz suite that materializes a region into a fresh guest database, runs random
guest edits, and asserts that nothing in the region was written because of a row the guest lacks.

## 12. Rollout

One coordinated window: drain devices, deploy the migration, the sync config and the client
together, reload. Old clients cannot read v2 envelopes, so there is no mixed-version period worth
supporting. Existing data is untouched until the first share is created.

## 13. Decisions for Vlad

1. **Regions in place (A) or a separate workspace per share (B)?** Pick: A. B is a week of work
   and safe; A is the feature as described.
2. **Nested shares:** nearest root wins, and the first version refuses to create a root inside
   another share. Pick: yes.
3. **Who manages shares:** the workspace owner only, as for members. Pick: yes.
4. **Re-keying content that was moved into a region happens automatically on any member device.**
   The alternative is to hold it until someone confirms on a device that sees it. Pick:
   automatic; position in the tree is the access rule, and the move itself asks.
5. **User-defined properties and types** are degraded (visible as "not shared") for guests until
   stand-ins ship. Pick: accept.

## 14. Rejected

- **Guests as `workspace_members` with a `guest` role.** Every existing policy would have to learn
  to exclude it; one miss exposes the workspace.
- **Giving the guest WK.** Access would rest on the server alone.
- **A per-block key for every row, with key grants per share.** No re-sealing on a move, but it
  re-encrypts the whole existing workspace once and derives a key per row on every read.
- **Rejecting a write sealed under the wrong key.** Turns a stale device into a lost edit, and the
  client cannot learn the right key while its upload queue is blocked.
- **A block in several regions at once** (an array of share ids). A row is sealed under one key.
- **A shared "schema region" all guests can read.** Leaks every shared definition's name to every
  guest, and a type definition's subtree is arbitrary content.
