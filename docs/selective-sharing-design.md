# Selective sharing: share a collection of pages or subtrees with a guest

> **Status:** proposal, nothing built. Code claims last verified against code 2026-11-21.
> This is a synthesis: an independent design (first commit of this file) merged with the earlier
> sharing designs. §15 says what came from where and where this document disagrees with them.
> If accepted it replaces the recommendation in `subtree-sharing-e2ee.md` (PR #259) and the
> access-control mechanics of [`subtree-sharing.md`](subtree-sharing.md) and
> [`shares-and-api-tokens.html`](shares-and-api-tokens.html); the API-token half of the latter is
> untouched.

## 1. Goal

Let a workspace owner give another person access to **some** of a workspace: one page, one
subtree, or a named collection of several, without giving them the rest. The baseline is shared
editing. It has to work for end-to-end-encrypted (e2ee) workspaces.

Terms:

- **share**: a named collection with its own member list and one or more roots.
- **root**: a block attached to a share. The root and everything under it is shared.
- **region**: the set of blocks whose *nearest* enclosing root belongs to one share. Every block
  is in at most one region. Blocks in no region are the **remainder** of the workspace.
- **guest**: a user who is a member of a share but not of the workspace (the earlier docs say
  "share recipient").
- **member**: a workspace member, as today (`workspace_members`).

The design has two planes, a split taken from the PR #259 document because it keeps the rest
tractable: **access** (which rows reach a guest; §5) reads only ids, tree shape and membership, so
it is the same for plaintext and e2ee workspaces; **keys** (can the guest open them; §6) exists
only for e2ee.

Not in scope: public or anonymous links (§14), a guest reading history, presence, mounting a share
inside the guest's own workspace.

## 2. What the code does today

| Fact | Where |
|---|---|
| Every authorization decision keys on whole-workspace membership: row-level security on `blocks`, `workspaces`, `workspace_members`; the sync stream; Storage. `blocks` is granted to `anon` and `authenticated`, so row-level security, not the sync stream, is the read boundary. | `supabase/migrations/20260510222352_consolidated_initial.sql`, `powersync/sync-config.yaml`, `…20260625000000_add_attachments_storage.sql` |
| The upload RPCs (`apply_block_creates`, `apply_block_patches`) run as the caller and rely on row-level security. Patches are per-column last-writer-wins; there is no compare-and-swap. `created_by` / `updated_by` are client-supplied. | `…20260709000000…`, `…20260803000000…` |
| The server has no tree concept. `parent_id` is a deferred foreign key inside one workspace; `workspace_id` is immutable; `id` is a global primary key. | `consolidated_initial.sql` |
| An e2ee workspace has one key (WK), handed to other people out of band (paste). Nothing key-related is stored server-side except a canary. The key is held as a non-extractable `CryptoKey`. There is no rotation and no asymmetric cryptography. | `src/sync/keys/`, `src/sync/crypto/workspaceKey.ts` |
| Three columns are sealed (`content`, `properties_json`, `references_json`); ids, `parent_id`, `order_key`, authors and timestamps are cleartext. The envelope is `enc:v1:` + nonce + ciphertext and names no key; the associated data binds block, workspace, column and version. | `src/sync/transform.ts`, `src/sync/crypto/envelope.ts`, `src/sync/crypto/aad.ts` |
| The local database holds plaintext. Sealing happens on upload and opening happens when a staged row (`blocks_synced`) is materialized into `blocks`; both look the key up by workspace id. | `src/services/powersync.ts`, `src/data/internals/syncObserver/materialize.ts` |
| One local database holds every workspace of the user; a session has one active workspace and one property-definition registry. | `src/data/clientContext.ts`, `src/data/repo.ts` |
| Read-only is one boolean per session. The commit pipeline rejects document writes; UI-state and preference writes still upload and the server rejects them into the quarantine. | `src/data/internals/commitPipeline.ts`, `src/data/api/changeScope.ts` |
| A property is a child block whose content is `::((fieldId))`; `fieldId` is a definition block under the Properties page. Seeded definitions resolve from code with no row; user-defined ones need the row. E2ee workspaces can be child-backed too. | `src/data/propertyChildren.ts`, `src/data/propertyDefinitionRegistry.ts`, `…20260821120000_allow_e2ee_properties_migration_flip.sql` |
| A media block lives under the Assets page and is embedded by id; its bytes are at `<workspace_id>/<contentKey>`, sealed under WK in e2ee mode. | `src/plugins/attachments/` |
| Comment threads live under a per-workspace "Comments" page. | `src/plugins/annotations/container.ts` |
| Cross-workspace copy is markdown text only: property values and media do not survive it. | `src/paste/operations.ts`, `src/utils/copy.ts` |

## 3. The first decision: where shared content lives

**A. Regions inside the workspace (recommended).** Shared blocks stay where they are. The server
learns which blocks are under a share root and gives guests exactly those rows; in an e2ee
workspace those rows are sealed under a key of their own.

**B. A separate workspace per share.** A share is an ordinary workspace with both people as
members; sharing a page means moving it there. (PR #259 calls this option E and recommends it for
e2ee.)

B needs no new server authorization and no new cryptography, and the guest gets a complete,
ordinary workspace. But the page leaves the owner's graph: backlinks, queries, search, typed
properties and daily-note references stop reaching it, and a subtree cannot be shared *in place*.
Putting that back means the client presenting several workspaces as one graph, which touches
every layer that assumes one active workspace (about 175 reads of `activeWorkspaceId`,
transactions pinned to one workspace, one definition registry). B is also not free today: there is
no structural cross-workspace move, and the copy that exists drops properties and media.

A keeps one graph for the owner and concentrates the cost at the sync boundary and in the guest's
session. Its two risks are different in kind: new server code decides who can read what, and a
guest client holds a partial workspace. §6.4 and §7.3 are about containing them.

PR #259 recommended deferring A for e2ee as "encryption-core surgery". The requirement has since
changed (e2ee must work), and three choices below make it smaller than that estimate: a block has
exactly one region, so one row never needs two keys (§4); the share key is stored wrapped under
WK, so workspace members need no key delivery (§6.1); and writes sealed under the wrong key are
accepted and repaired instead of made atomic (§6.3, §6.4).

The rest of this document designs A.

## 4. Model

- A **share is a block**: a `share`-typed block under a lazily created per-workspace "Shares"
  page. Its content is the share's name (so the name is sealed like any content). Its id is the
  share id. It is the first root of its own share, so anything created *inside* the share that has
  no better home (a page a guest creates, definition stand-ins, a comments container) lives under
  it and is in the region automatically. For the owner it is an ordinary page that also lists the
  share's other roots.
- Other roots are attached to the share by reference, not by moving them. A root stays where it is
  in the owner's tree.
- **Nearest root wins.** A block's region is decided by the nearest root at or above it. A share
  root inside another share's region carves its own region out of the outer one. The earlier
  designs made nesting additive (a block carries every share above it); that cannot work once a
  region has a key, because a row is sealed once.
- Access is per region, by role: `editor` or `viewer`. A member's access is unchanged: members see
  and write every region, and a member who is also on a share uses their workspace role.
- Access follows tree position. Moving a block under a root shares it; moving it out unshares it.

"Share this page" in the UI creates a share named after the page and attaches the page as a root.
"Add to share…" attaches another root to an existing share.

## 5. Access plane (server)

### 5.1 Tables

```
shares            (id, workspace_id, wrapped_key, key_canary, created_by, create_time, revoked_at)
share_roots       (share_id, block_id UNIQUE, workspace_id, create_time)
share_members     (id, share_id, workspace_id, user_id, role, create_time)   -- role: editor | viewer
share_invitations (id, share_id, workspace_id, email, role, invited_by_user_id, create_time)
blocks.share_id   text NULL          -- the block's region. Server-maintained only.
```

- `shares.id` is the share block's id; the share block is an implicit root.
- A share is **never hard-deleted**. Revoking sets `revoked_at`, which removes its roots and stops
  delivery; the row and its `wrapped_key` stay, because rows and history sealed under that key
  must remain readable (§6.4, §10).
- Guests are deliberately **not** `workspace_members` rows: every existing policy tests that
  table, so a guest stays locked out of everything this design does not explicitly open.
- Every new table is created with row-level security enabled and `anon` / `authenticated` grants
  revoked in the same migration.
- All four tables are written only through `SECURITY DEFINER` RPCs callable by the workspace owner
  (`create_share`, `revoke_share`, `add_share_root`, `remove_share_root`, `invite_to_share`,
  `accept_share_invitation`, `remove_share_member`, `set_share_member_role`), mirroring the member
  RPCs. `invite_to_share` refuses a workspace member. Accepting never lowers an existing role; only
  `set_share_member_role` can.
- `share_members` is deliberately generic: an API or agent principal can later join a share the
  same way (the service-user idea in `shares-and-api-tokens.html`) without touching this plane.

### 5.2 Keeping `blocks.share_id` right

The rule: `share_id` = the share of the nearest block at or above this one that is in
`share_roots`, else null. One scalar column, so read checks are O(1) per row and nothing walks
parents at read time.

- **Insert, or `parent_id` change** (`BEFORE` trigger): if the block is a root, its own share;
  otherwise the parent's `share_id`, read with `FOR SHARE` on the parent row. The client's value
  is always overwritten, so it cannot be forged.
- **Cascade** (`AFTER`, when the value changed or the row was just inserted, and from
  `add_share_root` / `remove_share_root` / `revoke_share`): update the children that are not
  roots, level by level, one statement per level, until a level changes nothing. Cascading from an
  insert covers a child that reached the server before its parent (the foreign key is deferred).
- Region does not look at `deleted`: a tombstone keeps its region, so a restore lands where it was.

Locking the parent and cascading one level per statement is meant to close the race between a move
and a concurrent insert below it: an insert under a row the cascade has not reached waits on that
row's lock and then reads the new region; an insert that got there first is committed before the
cascade's next level reads. This is reasoned, not tested; the spike (§11) decides between it and
the blunter alternative, a per-workspace advisory lock taken shared by inserts and exclusive by
anything that changes a region. The property either must hold is **never over-share**: a row must
never keep a region its ancestor chain no longer supports. Under-sharing is a bug; over-sharing is
a leak.

The trigger functions are `SECURITY DEFINER` (a guest's write must be able to read its parent's
region and cascade). `share_id` is excluded from `blocks_history` diffs and from the version bump,
so sharing ten thousand rows writes no history and does not look like ten thousand edits.

### 5.3 Row-level security

```
blocks read:      member(workspace_id)  OR  share_id in my shares
blocks write:     writer(workspace_id)  OR  share_id in my editor shares     (USING and WITH CHECK)
workspaces read:  member(id)            OR  I am on a share of this workspace
```

`WITH CHECK` runs after the `BEFORE` trigger, so it tests the region the row *ends up* in: a guest
cannot create a block outside their regions, move one out, or move one in. A guest gets no
`DELETE` policy (the client only soft-deletes). `blocks_history` and `workspace_members` stay
member-only. A guest reads their own `share_members` row and nobody else's; the owner lists a
share's audience through an RPC.

Further checks on a write by someone who is not a workspace writer, in the same trigger:

1. A root row's `parent_id`, `order_key` and `deleted` cannot change. A guest can edit a shared
   page's title and contents but cannot delete, move or reorder the page itself; its siblings are
   rows they cannot see.
2. In an e2ee workspace, each content column written must be a v2 envelope naming the row's
   region (§6.2).
3. `created_by` (on insert) and `updated_by` are set from `auth.uid()`. They are client-supplied
   today; that is tolerable among members and not for guests.

### 5.4 Sync

Members: the existing `workspace_data` stream gains `blocks_synced.share_id` and queries for
`shares`, `share_roots`, `share_members` filtered by `workspace_id IN user_workspaces`.

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
    - SELECT … FROM public.share_members WHERE share_members.user_id = auth.user_id()
```

plus the guest's `workspaces` row (name, `encryption_mode`, `properties_migration`), keyed on
`share_members.workspace_id`, in this stream or a third one. The entry path reads the mode off the
synced workspace row, so without it a guest cannot even reach a key prompt.

`IN (subquery on auth.user_id())` over a plain column is the documented Sync Streams shape, so the
scalar region needs neither the `= ANY(array)` join nor the coverage junction table the earlier
designs planned around. A guest gets one bucket per share; the limit is 1,000 per user. Members
keep one bucket per workspace, which the create RPC's ordering argument depends on.

To verify in the spike before building on it: a new `share_members` row adds the bucket to a
connected client without a reconnect; a row moving between two of one user's buckets arrives as
one consistent checkpoint; the `workspaces` query can share the stream.

### 5.5 What a guest learns besides content

For every row in their region: ids, tree shape, `order_key`, timestamps, author ids, tombstones,
the row count, and in e2ee mode the length of each sealed column. Keys do not hide any of that.
A guest does not learn other shares' ids (the region is a scalar, not a list) or the workspace
roster. The share dialog should say that structure and timing are visible to the server and to
guests even when content is sealed.

## 6. Key plane (e2ee workspaces only)

### 6.1 Share key

Each share in an e2ee workspace has its own random 32-byte key, **SK**, not derived from WK. A
region's rows are sealed under its share's SK; the remainder stays under WK.

- `shares.wrapped_key` is SK sealed under WK, with associated data binding the share id and
  workspace id. Any device holding WK reads the synced `shares` row and unwraps SK. Nothing is
  handed between the owner's own devices or to other members, and the existing non-extractable WK
  handle is enough (unwrap is an AES-GCM decrypt), so no member device re-enters its key. This is
  the "workspace members need the share key too" cost PR #259 expected to need a per-member key
  hierarchy; one symmetric wrap covers it.
- `shares.key_canary` is the share id sealed under SK. A guest's client checks a pasted key
  against it, as `wk_canary` does for WK.
- A guest gets SK the way a collaborator gets WK today: the owner copies it (`kmp-sk-1:…`) and
  sends it over a channel of their choosing; the guest pastes it into a key gate after accepting
  the invitation. The server never sees it. A guest's second device pastes it again.
- A **key context** is `{content key, K_id}`: SK plays WK's role for its region, including the
  derived HMAC subkey that names attachment objects and namespaces derived ids. The key store
  gains records keyed by share id with the same shape as today's workspace records.
- The mode pin stays per workspace. A guest's pin is set to e2ee when their first SK validates;
  a server claiming an e2ee workspace is plaintext lands in the same quarantine branch a new
  member's device does, and a pasted SK defeats the claim.

A guest never holds WK. A guest colluding with the server can read exactly what was ever sealed
under an SK they hold.

### 6.2 Envelope v2 names its key

```
enc:v1:<payload>            sealed under WK                 (unchanged; all existing data)
enc:v2:<share_id>:<payload> sealed under that share's SK
```

Associated data for v2 adds the share id, which authenticates the key domain. Existing rows need
no migration. The server's `is_enc_v1_envelope` check widens to accept both. Because each column
names its key, a row whose three columns are sealed under different keys (a patch touched one
column after the region changed) is still fully readable by anyone holding both keys, the mismatch
is visible without decrypting anything, and no reader ever trial-decrypts.

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
row **only if its `updated_at` still equals the version the client decrypted**, and leaves
`updated_by` / `user_updated_at` alone. A lost compare-and-swap is skipped and picked up again
when the newer row arrives; a row with local writes still queued is skipped until they land. The
pass is idempotent, has a fixed point (no drifted rows), and two devices running it at once cannot
clobber an edit. It runs over the active workspace only.

Why this is safe to run continuously: the local database is plaintext, so re-keying changes no
local row, creates no undo entry, and is not an edit; it replaces ciphertext with ciphertext of
the same plaintext, guarded by the row version. Each re-keyed row does write one history row.

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
a member's client to re-key the row. And because a revoked share keeps its `wrapped_key`, rows
still sealed under a revoked share's key, and history written while they were, stay readable to
members.

### 6.5 Plaintext workspaces

Everything in §5 applies and nothing in §6 does: no keys, no envelopes, no pass. Sharing takes
effect the moment the region flips, and the server is the only boundary, as it already is for the
whole workspace.

## 7. The guest's client

A guest has, locally, rows of someone else's workspace: the regions they were given and nothing
else. The share roots' parents are absent.

### 7.1 Session

- Access to a workspace becomes `member(role)` or `guest`, derived from local rows
  (`workspace_members`, else `share_members`), as a first-class fact other code can ask. Today a
  missing member row reads as "writable" in one place and is waited on indefinitely in another
  (`awaitLocalMemberRole`); neither may apply to a guest.
- A guest workspace appears in the switcher under "Shared with me". Opening it lands on a share
  page (the share block), which lists that share's roots. A share root is a top of the tree for
  the guest: ancestor walks and breadcrumbs already stop at a missing parent
  (`src/data/internals/treeQueries.ts`, `src/utils/blockCrumbs.ts`).
- Bootstrap takes the path a workspace `viewer` takes today: kernel pages are get-only, seeds and
  backfills are skipped (`src/data/kernelPage.ts`, `src/data/definitionSeeds.ts`).
- **Graph-scoped passes refuse guests.** Backfills, migration claims, audits and seed
  materialization assume the device sees the whole graph, and their "sync has settled" gates
  measure quiescence, not coverage: a drained share stream looks exactly like a drained workspace.
  Each such pass gates on access being `member`, not on settledness.

### 7.2 Writes

- **One gate, in the commit pipeline.** The session's read-only boolean stays as the UI's answer
  (a guest session is read-only unless the guest holds an editor share in that workspace), and the
  pipeline adds the authoritative check: every row a document-scope transaction touched, on both
  its before and after position, must be in a region the session may write. A write outside throws
  before anything is queued. The server enforces the same rule (§5.3); the client gate exists so a
  refused write never becomes a local phantom. Resolving edit affordances per block (a viewer share
  and an editor share in the same workspace) is deferred; until then the gate is what stops the
  write.
- **Roots are structurally locked** for a guest: no delete, move, indent or reorder of a root.
- **UI state stays on the device.** A guest's layout, recents and preferences are blocks outside
  every region. The uploader partitions a guest's queue by region before sealing: rows in a held
  share are sealed and sent; the rest go straight to the local rejection quarantine without a
  round trip. This is what already happens to a workspace viewer's UI-state writes, decided
  locally instead of by the server, and it is required in e2ee mode, where a guest has no key to
  seal such a row with and the write would otherwise hold the queue forever. That those rows stay
  usable locally after quarantine is how viewers work today; confirm it in the spike.

### 7.3 Processors on a partial workspace

This is the highest-risk part of the design. Post-commit processors read the local index and treat
it as the whole workspace. On a guest that is false, and two kinds of harm follow:

- writes outside a region: caught by the gate (they throw), so a usability problem;
- writes **inside** a region that are wrong because of what the guest cannot see: silent damage to
  the owner's data.

Known members of the second kind. These are reasoned from reading the processors, not
reproduced; the fuzz suite in §11 is what turns the list into evidence:

| Processor | What goes wrong on a guest |
|---|---|
| orphan alias / seat reaping (`src/plugins/references/referencesProcessor.ts`) | tombstones a page in the region because no *local* block references it |
| `[[alias]]` resolution and seat minting | mints a duplicate page for a name that exists outside the region |
| property-children projection into `properties_json` (`src/data/internals/propertyChildrenProcessor.ts`) | drops a key whose definition is not local, then uploads the smaller bag |
| type and schema authoring (typeify, definition edits) | creates definitions the owner's registry does not expect |
| contributor attribution | writes references to pages outside the region |

Recomputing a block's own outgoing references is not on the list: it reads only that block's
content, and the add-only reconcile contract (`docs/contracts/derived-data-add-only.md`) keeps
stored references it cannot re-derive.

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
| a `((block))` outside the region | "not shared with you" placeholder, no label | add it to the share |
| comment threads | none | §8.3 |
| ancestors, siblings of a root | nothing; the root is the top | intended |

The earlier design had the server supply labels for references a recipient cannot open. The server
cannot read content in e2ee mode, and a label is content, so there are none in either mode.

### 8.1 Definition stand-ins

A definition cannot simply be attached as another root: one definition is used by several shares
and a block has one region, and a type definition can be any block, with arbitrary content under
it. Sharing the Properties and Types pages with every guest would disclose every schema name in
the workspace. Instead a share carries **stand-ins**: one small block per user-defined definition
used in the region, under the share block, holding a copy of what a reader needs (name, codec,
options) and registered in the guest's registry under the **original** definition id, read-only.
Field rows are not rewritten.

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
on the first path segment being a share the caller belongs to, or a share of a workspace the
caller is a member of. Keying on the path keeps Storage policy per-share without the
content-key-to-block mapping the media design deferred. The re-key pass, when it meets a media
block in a region whose region object is missing, uploads the copy. A guest's own uploads go to
the same place, under the share block.

Costs to accept: bytes are duplicated per share, so workspace-wide dedup stops at a region
boundary, and a revoked share's objects need collecting. An image used in two shares is the
uncommon case and is reported, not solved, at first.

### 8.3 Comments, and a comment-only role

Threads live under the workspace "Comments" page, outside every region, so guests neither see nor
write them. Two steps, both later: (1) threads on a block in a region are parented under that
share's block instead; (2) a `commenter` role is a region rule, not a content rule: a commenter
may write only under the share's comments container. That is enforceable on the server in e2ee
mode, where the server cannot tell a comment from an edit by reading it.

**Read-only is cheap; comment-only is not.** A viewer role costs a column and one policy clause
and falls out of the build order. A commenter role needs (1) and (2).

### 8.4 Pages a guest creates

A guest typing `[[New page]]` cannot create a page at the workspace root. Later (§11 step 4) the
page is created under the share block, with its id derived under the region's `K_id`. If that name
already exists outside the region, the workspace now has two pages with one name; the owner's
client shows its existing duplicate-name banner and offers the merge. The earlier alias design had
the server detect the collision through a unique index on aliases; in e2ee mode the server cannot
see an alias, so detection has to be on a client that sees both.

## 9. Owner experience

- "Share…" on any block: pick or create a share, invite by email with a role, copy the share key
  (e2ee). The dialog lists roots, members, pending invitations and re-key progress. Share actions
  are online-only, as member management is.
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
| Share revoked | its roots are removed, regions revert to the enclosing region or the remainder, the pass re-keys; the share row and its key are kept |
| Guest removed | the server stops delivering. They keep what they already pulled. SK is not rotated; "revoke the share and create a new one" re-keys the region under a fresh key until a real rotation exists |
| History of a region's rows | member-only, as today. It holds ciphertext under whichever key was current at each write, which members can always open because no share key is discarded |
| Guest becomes a workspace member | rows arrive through both buckets; harmless |
| Plaintext-to-e2ee conversion of a workspace with shares | conversion preflight refuses; revoke the shares first |
| Guest renames a shared page | references inside the region are rewritten; link text outside it goes stale (the link still resolves by id) |

## 11. Build order

Each step is a PR or a few; each ends in something usable.

0. **Spike.** The three Sync Streams questions in §5.4; the region trigger under concurrent move
   and insert (§5.2); a quarantined UI-state row staying usable (§7.2).
1. **Access plane, read-only guests, plaintext workspaces.** Tables, triggers, policies, streams,
   share RPCs, the share dialog, the guest session as a viewer, the member-or-guest fact and the
   graph-scoped gates.
2. **Key plane.** SK, envelope v2, key lookup by key id, `rekey_blocks` and the pass, the guest
   key gate. After this step an e2ee workspace can share read-only.
3. **Guest editing.** The per-row write gate, root locking, the uploader partition, the processor
   classification.
4. **Dependencies.** Definition stand-ins; guest-created pages under the share block.
5. **Media in regions.**
6. Later: comments and the commenter role, per-block edit affordances, an invite link that carries
   the key in the URL fragment (delivery only; access still needs the membership row, so removing
   a member still works), key rotation.

Verification that is part of the work, not after it. The first attempt at sharing in this
codebase was abandoned for lack of exactly this, according to the earlier design's test plan.

- A property test of region maintenance: random sequences of add root, remove root, revoke, insert
  (including child before parent), move and delete, comparing every row's `share_id` with an
  oracle that walks up `parent_id`.
- A pgTAP matrix over {member, guest editor, guest viewer, stranger} × {read, insert, edit, move
  in, move out, root structure, author stamp}.
- A property test that the re-key pass never changes plaintext and never overwrites a concurrent
  edit.
- A partial-workspace fuzz suite: materialize a region into a fresh guest database, run random
  guest edits, and assert that nothing in the region was written because of a row the guest lacks.

## 12. Rollout

One coordinated window: drain devices, deploy the migration, the sync config and the client
together, reload. Old clients cannot read v2 envelopes, so there is no mixed-version period worth
supporting. Existing data is untouched until the first share is created.

## 13. Decisions for Vlad

1. **Regions in place (A) or a separate workspace per share (B)?** Pick: A. B avoids all new
   authorization and cryptography but takes the content out of the graph.
2. **Nested shares:** nearest root wins, and the first version refuses to create a root inside
   another share. Pick: yes.
3. **Who manages shares:** the workspace owner only, as for members. Pick: yes.
4. **Re-keying content that was moved into a region happens automatically on any member device.**
   The alternative is to hold it until someone confirms on a device that sees it. Pick:
   automatic; position in the tree is the access rule, and the move itself asks.
5. **User-defined properties and types** are degraded (visible as "not shared") for guests until
   stand-ins ship. Pick: accept.

## 14. Rejected, and deferred

- **Guests as `workspace_members` with a `guest` role.** Every existing policy would have to learn
  to exclude it; one miss exposes the workspace.
- **Giving the guest WK and scoping them by row-level security** (PR #259's option B). Access to
  the whole workspace would rest on the server alone, and revoking would mean re-keying everything.
- **Additive nested shares** (an array of share ids per block). A row is sealed under one key.
- **A mirrored workspace per share with the owner's client relaying edits** (PR #259's
  C-projection). Two ciphertext domains with independent row versions need a reconciliation
  protocol, and nothing syncs while the owner is offline.
- **A per-block key for every row, with key grants per share.** No re-sealing on a move, but it
  re-encrypts the whole existing workspace once and derives a key per row on every read.
- **Rejecting a write sealed under the wrong key.** Turns a stale device into a lost edit, and the
  client cannot learn the right key while its upload queue is blocked.
- **A shared "schema region" all guests can read.** Leaks every shared definition's name to every
  guest, and a type definition's subtree is arbitrary content.
- **Deferred: public and anonymous links.** In e2ee mode a link can only be a client-side export
  of a plaintext copy (PR #259's option D), which is a deliberate, irreversible declassification
  and a separate feature. In a plaintext workspace the link and snapshot design in
  `subtree-sharing.md` can sit on this access plane later.

## 15. Relation to the earlier designs

Read after the independent draft was written.

**Taken from them.**

| From | What |
|---|---|
| PR #259 | the access/key split as the organizing idea; row-level security, not the sync stream, is the read boundary; the workspace row has to reach a guest; a key id on the wire and in the associated data; history is ciphertext under the key current at each write and cannot be re-sealed, so share keys are never discarded; author stamps must be server-set for guests; the metadata a guest still learns; graph-scoped passes must gate on membership, not settledness; media bytes must be re-sealed and re-addressed per share |
| `subtree-sharing.md` | the child-before-parent fix-up on insert; role-monotonic accepts; a guest reads only their own membership row; one uniform role per session, with per-block resolution deferred; a member who is also on a share uses the workspace role; the oracle property test and the two-user policy matrix |
| `shares-and-api-tokens.html` | a share has several roots; shares are soft-revoked; O(1) per-row access checks at 300k rows; share membership as the future home of API principals |
| `share-aliases-explainer.html` | the duplicate-page problem when a guest names something that exists out of view |

**Where this document differs.**

| Earlier position | Here | Why |
|---|---|---|
| Confidential subtree sharing on e2ee is deferred; e2ee users get a second workspace or a plaintext export (PR #259) | built, as regions with a per-share key | the requirement changed; and the three choices in §3 remove most of the cost that estimate counted |
| A block carries every share above it; nested access is additive (`effective_share_ids text[]`) | one region per block, nearest root wins | one row, one key; also gives a plain-column sync filter |
| Workspace members need the share key delivered per member, or a key hierarchy | SK wrapped under WK in the share row | members already hold WK |
| Region transitions were an open hazard (rows sealed under the old key) | accepted as drift, repaired by a compare-and-swap pass | one mechanism for sharing, unsharing, moves and stale devices |
| A session is entered by a share URL and scoped to one share | a guest session is the workspace, limited to the guest's regions | a share is a collection; the gate is per row |
| Read-only sessions route writes to a local-only source | UI-state writes are quarantined by the uploader | the local-only source no longer exists in `changeScope.ts` |
| The server detects alias collisions and labels unreachable references | neither | the server cannot read content in e2ee mode |
| Recompute is serialized by an advisory lock on the recomputed root | parent row lock plus level-by-level cascade, pending the spike | the root lock does not serialize a move below the root against a share above it |

**Stale statements in the earlier documents, for whoever reads them next.** PR #259 says e2ee
workspaces are pinned to cell-backed properties; `…20260821120000_allow_e2ee_properties_migration_flip.sql`
lifted that. `subtree-sharing.md` describes a `local-ephemeral` write source and a
`child_ids_json` column; neither is in the current schema or change-scope table.
