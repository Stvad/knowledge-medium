# Selective sharing: share a collection of pages or subtrees with a guest

> **Status:** proposal, nothing built. Code claims last verified against code 2026-11-21.
> Synthesis of an independent design (first commit of this file) with the earlier sharing designs,
> then revised after one adversarial review round. §14 records where it departs from the earlier
> documents. If accepted it replaces the recommendation in `subtree-sharing-e2ee.md` (PR #259) and
> the access-control mechanics of [`subtree-sharing.md`](subtree-sharing.md) and
> [`shares-and-api-tokens.html`](shares-and-api-tokens.html); the API-token half of the latter is
> untouched.

## 1. Goal

Let a workspace owner give another person access to **some** of a workspace: one page, one
subtree, or a named collection of several, without giving them the rest. The baseline is shared
editing. It has to work for end-to-end-encrypted (e2ee) workspaces.

Terms:

- **share**: a named collection with its own member list and one or more roots.
- **root**: a block attached to a share. The root and everything live under it is shared.
- **region**: the set of blocks whose *nearest* enclosing root belongs to one share. Every block
  is in at most one region.
- **guest**: a user who is a member of a share but not of the workspace (the earlier documents
  say "share recipient").
- **member**: a workspace member, as today (`workspace_members`).

Two planes, a split taken from the PR #259 document: **access** (which rows reach a guest; §5)
reads only ids, tree shape and membership, so it is the same for plaintext and e2ee workspaces;
**keys** (can the guest open them; §6) exists only for e2ee.

Not in scope: public or anonymous links (§14), a guest reading history, presence, mounting a share
inside the guest's own workspace.

## 2. What the code does today

| Fact | Where |
|---|---|
| Every authorization decision keys on whole-workspace membership: row-level security on `blocks`, `workspaces`, `workspace_members`; the sync stream; Storage. `blocks` is granted to `anon` and `authenticated`, so row-level security, not the sync stream, is the boundary, and any column a policy or trigger does not protect is writable directly. | `supabase/migrations/20260510222352_consolidated_initial.sql`, `powersync/sync-config.yaml`, `…20260625000000_add_attachments_storage.sql` |
| The upload RPCs run as the caller and rely on row-level security. Patches are per-column last-writer-wins with no compare-and-swap, and they accept client values for `created_by`, `created_at`, `updated_by`. A refused upload quarantines its whole local transaction. | `…20260709000000…`, `…20260803000000…`, `src/services/uploadErrorClassifier.ts` |
| The server has no tree concept. `parent_id` is a deferred foreign key inside one workspace; `workspace_id` is immutable; `id` is a global primary key. Deleting is a flag: a tombstone keeps its content and its place in the tree. | `consolidated_initial.sql`, `src/data/internals/txEngine.ts` |
| An e2ee workspace has one key (WK), handed to other people out of band (paste). Nothing key-related is stored server-side except a canary. There is no rotation and no asymmetric cryptography. | `src/sync/keys/`, `src/sync/crypto/workspaceKey.ts` |
| Three columns are sealed (`content`, `properties_json`, `references_json`); ids, `parent_id`, `order_key`, authors and timestamps are cleartext and unauthenticated. The envelope is `enc:v1:` + nonce + ciphertext and names no key. | `src/sync/transform.ts`, `src/sync/crypto/envelope.ts`, `src/sync/crypto/aad.ts` |
| The local database holds plaintext. Sealing happens on upload; opening happens when a staged row (`blocks_synced`) is materialized into `blocks`. Entry, materialization, the key-loss signal and about twenty other readers all resolve the key **per workspace**: without a workspace key record an e2ee workspace is locked as a whole. | `src/sync/keys/resolver.ts`, `resolveWorkspaceEntry.ts`, `openWorkspaceKeys.ts`, `src/data/internals/syncObserver/materialize.ts` |
| Rows that arrive by sync are not run through processors. Arrival trusts `references_json` as written and derives only two device-local columns; the rename rewriter has no arrival counterpart, deliberately. | `materialize.ts`, `src/plugins/references/renameProcessor.ts` |
| One local database holds every workspace of the user; a session has one active workspace and one property-definition registry. | `src/data/clientContext.ts`, `src/data/repo.ts` |
| Read-only is one boolean per session, and bootstrap, kernel pages, seeds and backfills all branch on it. The commit pipeline rejects document writes; UI-state and preference writes still upload, the server rejects them, and each rejection is counted in a "changes couldn't sync" warning. | `src/data/internals/commitPipeline.ts`, `src/data/api/changeScope.ts`, `src/plugins/system-status/` |
| Definitions (property schemas, block types) and extensions are discovered by type tag anywhere in the workspace. A property is a child block whose content is `::((fieldId))`; built-in seeded definitions resolve from code with no row. | `src/data/projectorRuntime.ts`, `src/data/userSchemasService.ts`, `src/data/propertyChildren.ts`, `src/extensions/extensionLookup.ts` |
| A media block lives under the Assets page and is embedded by id. Its id, its object path `<workspace_id>/<contentKey>` and the byte seal are all derived from the workspace and its key. | `src/plugins/attachments/` |
| Cross-workspace copy is markdown text only: property values and media do not survive it. | `src/paste/operations.ts`, `src/utils/copy.ts` |

## 3. The first decision: where shared content lives

**A. Regions inside the workspace (recommended).** Shared blocks stay where they are. The server
learns which blocks are under a share root and gives guests exactly those rows; in an e2ee
workspace those rows are sealed under a key of their own.

**B. A separate workspace per share.** A share is an ordinary workspace with both people as
members; sharing a page means moving it there. (PR #259 calls this option E and recommends it for
e2ee.)

| | A: regions | B: separate workspace |
|---|---|---|
| To build | §11: access plane, key plane, guest session, then dependencies and media | one feature: a structural cross-workspace move that carries properties (remapped to the other workspace's definitions), references and media, and re-seals |
| New authorization or cryptography | yes: the server decides per row, and a second key domain | none |
| Guest gets | their regions; user-defined properties, media, comments and new pages arrive in later steps | a complete workspace on day one |
| Owner keeps | one graph: links, backlinks, search, queries and types keep reaching shared content; a subtree is shared where it sits | two graphs: after moving page P, `[[P]]` in daily notes no longer resolves to it, P leaves search and typed views, a subtree must be cut out of its parent, and the two schemas drift |
| Standing cost | every processor, backfill and plugin must behave on a guest's partial workspace (§7) | none |
| Isolation if the server is hostile | weaker: the server controls tree shape, so it can present private rows as shared (§6.5) | full |

B is roughly one build step where A is five. B is the right answer when the shared material is
self-contained (a document for someone else); A is the right answer when it is part of the graph,
which is what "share a subtree without sharing the rest" describes. This document recommends A and
designs it. If A is chosen, the partial-workspace risk is tested first (§11 step 0), before any
server work, because it is the assumption most likely to change that recommendation.

PR #259 deferred A for e2ee as "encryption-core surgery". Three choices here reduce that: a block
has exactly one region, so one row never needs two keys (§4); the share key is stored wrapped
under WK, so members need no key delivery (§6.1); and a write sealed under the wrong key is
accepted and repaired instead of rejected (§6.4).

## 4. Model

- A **share is a block**: a `share`-typed block under a per-workspace "Shares" page
  (`getOrCreateKernelPage`, `createTypedChild`). Its content is the share's name, so the name is
  sealed like any content; it claims no alias, so it can be named after the page it shares. Its id
  is the share id. It is a root of its own share, so things created *inside* the share that have
  no better home live under it.
- Other roots are attached by reference, not by moving them. The server's `share_roots` table is
  the only list of roots; the share page renders it.
- **Nearest root wins.** A block's region is decided by the nearest root at or above it. A root
  inside another share's region carves its own region out. The earlier designs made nesting
  additive; that cannot work once a region has a key, because a row is sealed once.
- **A tombstone never gains a region.** Sharing covers what is live. A block deleted while shared
  stays in its region, so a guest's delete and its undo work; a block deleted before its subtree
  was shared is never delivered.
- Access is per region, by role: `editor` or `viewer`. Members are unaffected: they see and write
  every region under their workspace role, and share membership grants nothing to a member.
- Access follows tree position. Moving a block under a root shares it; moving it out unshares it.
- **A row a guest has written never defines schema or loads code for the workspace.** The server
  marks such a row (`blocks.guest_written`, §5.3) and the mark is permanent: it survives
  unsharing, moves and later edits by a member. Member clients skip marked rows when discovering
  property definitions, block types and extensions, so trust follows who wrote the row, not where
  it currently sits. Only the owner can clear a mark, by an explicit gesture on that block. To
  keep a guest from knocking out a real definition by editing it, the share gesture refuses a
  subtree that contains one, and schema-authoring gestures are refused inside a region for
  everyone.

## 5. Access plane (server)

### 5.1 Tables

```
shares            (id, workspace_id, wrapped_key, key_canary, created_by, create_time, revoked_at)
share_roots       (share_id, block_id UNIQUE, workspace_id, root_auth, create_time)
share_members     (id, share_id, workspace_id, user_id, role, create_time)   -- role: editor | viewer
share_invitations (id, share_id, workspace_id, email, role, invited_by_user_id, create_time)
blocks.share_id       text NULL      -- the block's region. Server-maintained only.
blocks.guest_written  boolean        -- set once by the server, cleared only by the owner (§5.3).
```

- `shares.id` is the share block's id, and the share block has its own `share_roots` row like any
  other root. There is no foreign key from `shares` to the block: deleting the block must not
  delete the key.
- A share is **never hard-deleted**. Revoking sets `revoked_at` and removes its roots; the row
  and its `wrapped_key` stay, because rows and history sealed under that key must stay readable.
- Guests are deliberately **not** `workspace_members` rows: every existing policy tests that
  table, so a guest stays locked out of everything this design does not explicitly open.
  `accept_invitation` (becoming a member) deletes that user's share memberships in the workspace.
- Every new table is created with row-level security enabled and `anon` / `authenticated` grants
  revoked in the same migration. All four are written only through owner-only `SECURITY DEFINER`
  RPCs mirroring the member RPCs. `invite_to_share` refuses a workspace member; accepting never
  lowers an existing role.
- `share_members` is generic on purpose: an API or agent principal can later join a share the
  same way (the service-user idea in `shares-and-api-tokens.html`).

### 5.2 One rule for `blocks.share_id`

A `BEFORE INSERT OR UPDATE` trigger computes the column on **every** write and ignores whatever
the client sent, so there is no second writer and a direct `UPDATE … SET share_id` changes nothing:

```
share_id :=  the row's own share            if the row is in share_roots
             the value it already had        if the row is a tombstone (null on insert)
             its parent's share_id           otherwise
```

When a row's value changes, or a live row is inserted, the change cascades to its children that
are not roots: live children take the new value, tombstones lose theirs. `add_share_root` runs the
same cascade from the new root.

Removing access is a **sweep by label, not a walk from the removed root**: `remove_share_root` and
`revoke_share` find what the share's remaining roots still reach and recompute every other row
labelled with that share, through the `share_id` index. A downward walk alone would miss a
component that a `parent_id` cycle has disconnected from its root, and those rows would keep their
label after the owner unshared them. The server does not prevent cycles today, and two devices
moving concurrently can produce one, so the sweep cannot assume there are none.

**Serialization.** One advisory lock per workspace: taken exclusively by anything that can change
a region (the share RPCs, a `parent_id` change, a restore) and shared by plain inserts. Region
changes are rare gestures and short transactions, so the contention is negligible, and it makes
the rule correct by construction instead of by a row-lock interleaving argument. Creates and
patches upload in separate RPC calls, so one transaction never needs both modes.

The property to hold is **never over-share**: no row keeps a region its ancestor chain does not
support. Under-sharing is a bug; over-sharing is a leak. §11 tests it against an oracle.

`share_id` is a staging-only column on the client (it is not a `blocks` storage column), so a
region flip does not re-materialize every row on every device. It is excluded from the version
bump (already true: the bump enumerates columns) and must be excluded from the history trigger's
diff, which today covers all columns.

### 5.3 Row-level security

```
blocks read:      member(workspace_id)  OR  (not member  AND  share_id in my shares)
blocks write:     writer(workspace_id)  OR  (not member  AND  share_id in my editor shares)
workspaces read:  member(id)            OR  I am on a share of this workspace
```

`WITH CHECK` runs after the `BEFORE` trigger, so it tests the region the row *ends up* in: a guest
cannot create a block outside their regions, move one out, or move one in. `blocks_history` and
`workspace_members` stay member-only. A guest reads only their own `share_members` row; the owner
lists a share's audience through an RPC.

**A guest's write is an allowlist**, enforced in the same trigger: they may change `content`,
`properties_json`, `references_json`, `parent_id`, `order_key`, `deleted` and the two edit
timestamps. `id`, `workspace_id`, `created_at` and `created_by` are frozen on update and
`created_by` is `auth.uid()` on insert; `updated_by` is `auth.uid()` whenever a content column
changed. The same trigger sets `guest_written` on every row a guest inserts or changes a content
column of, in the same write, so the mark arrives with the content it describes. No client can
write the column; an owner-only RPC clears it for one block. This is what §4's schema rule reads,
and it is enforced here because refusing a gesture in the UI does not constrain a direct write. On
a root row, `parent_id`, `order_key` and `deleted` are frozen too: a guest can edit a
shared page's title and contents but not delete, move or reorder the page among siblings they
cannot see. A guest's `parent_id` change is also walked upward from the new parent and refused if
it reaches the row itself: a guest must not be able to detach the owner's blocks from the tree
into a cycle. In an e2ee workspace each content column a guest *changes* must be a v2 envelope
naming a share they edit (§6.2). No `DELETE` policy on `blocks`, and Storage gets read and insert
only.

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

plus the guest's `workspaces` row, keyed on `share_members.workspace_id`. The entry path reads the
encryption mode off the synced workspace row, so without it a guest cannot reach a key prompt.

`IN (subquery on auth.user_id())` over a plain column is the documented Sync Streams shape, so the
scalar region needs neither the `= ANY(array)` join nor the coverage junction table the earlier
designs planned around. A guest gets one bucket per share (limit 1,000 per user). Members keep one
bucket per workspace, which the create RPC's ordering argument depends on.

Unverified, for the spike: a new `share_members` row adds the bucket to a connected client without
a reconnect; a row moving between two of one user's buckets arrives as one consistent checkpoint;
the `workspaces` query can share the stream.

### 5.5 What a guest learns besides content

- For every row in their region: ids, tree shape, `order_key`, timestamps, author ids, the row
  count, and in e2ee mode the length of each sealed column. Also the workspace's name and owner id.
- **Whether a block id exists anywhere in the workspace.** Inserting a chosen id either succeeds
  or fails, and no policy can hide which. Where ids are derived from guessable names under a
  public namespace, that tests names: every derived id in a plaintext workspace (page names, file
  hashes), and in an e2ee workspace daily-note dates and alias seats minted before seat ids were
  keyed. Keyed namespaces close it; until then the share dialog says so.
- Not: other shares' ids, the member roster, history, tombstones from before the share.

## 6. Key plane (e2ee workspaces only)

### 6.1 Share key and authenticated roots

Each share in an e2ee workspace has its own random 32-byte key, **SK**, not derived from WK. A
region's rows are sealed under its share's SK; everything else stays under WK.

- `shares.wrapped_key` is SK sealed under WK, bound to the share id and workspace id. Any device
  holding WK reads the synced `shares` row and unwraps SK with the WK handle it already has
  (unwrap is an AES-GCM decrypt), so nothing is handed between the owner's devices or to other
  members, and the owner can show SK again on any device. This is the "workspace members need the
  share key too" cost PR #259 expected to need a per-member key hierarchy.
- `share_roots.root_auth` is (share id, block id) sealed under WK by the device that attached the
  root. A member client treats a root as real only if that opens. The server cannot mint a root,
  and neither can a guest.
- `shares.key_canary` is the share id sealed under SK; a guest's client checks a pasted key
  against it. A guest gets SK the way a collaborator gets WK today: the owner copies it
  (`kmp-sk-1:…`) and sends it over a channel of their choosing, once per share per device.
- SK plays WK's whole role for its region, including the derived HMAC subkey (`K_id`) that names
  attachment objects and namespaces derived ids.

### 6.2 Envelope v2 names its key

```
enc:v1:<payload>            sealed under WK                 (unchanged; all existing data)
enc:v2:<share_id>:<payload> sealed under that share's SK
```

Associated data for v2 adds the share id. Existing rows need no migration. Because each column
names its key, a row whose columns are sealed under different keys is still readable by anyone
holding both, the mismatch is visible without decrypting, and no reader trial-decrypts.

Everything that pattern-matches `enc:v1:` has to learn v2: the server's block check (a new
predicate beside `is_enc_v1_envelope`, which also guards `wk_canary` and must not widen),
`envelope.ts`, the divergence scan and ciphertext audit in `src/plugins/data-integrity/`, and the
rejected-write helper in `src/plugins/system-status/`.

### 6.3 Key resolution becomes per key, not per workspace

This is the larger part of the key plane. Today "is this workspace unlocked" is one answer per
workspace (§2). It becomes a resolver over (workspace, key id) that replaces, for every reader:
key presence at entry, the materializability decision, the key-loss signal that closes a
workspace, and the "rows I cannot open yet" accounting behind first sync. A member resolves v2 ids
by unwrapping; a guest resolves only the shares they hold, and holds no WK record at all. A staged
row whose key the device is not meant to hold is not a gap: a guest must not sit on the syncing
screen because a row in their region is still sealed under WK.

The mode pin stays per workspace. A guest's pin is set to e2ee when their first SK validates; a
server claiming an e2ee workspace is plaintext lands in the quarantine branch a new member's
device lands in, and a pasted SK defeats the claim.

### 6.4 Sealing, and repairing the wrong key

At upload a client computes the row's region itself, by walking local ancestors to the nearest
root, and seals under that region's key. That walk is the single client-side owner of "which
region is this row in"; the commit gate (§7.2) uses the same function. The server's `share_id`
stamp is used for one thing only: noticing a disagreement.

What counts as a root depends on who is asking, and the function takes the root set as its input:

- **A member's** root set is the `share_roots` rows whose `root_auth` opens under WK. This is the
  set every disclosure decision uses.
- **A guest's** root set is the `share_roots` rows delivered for shares whose key they hold. A
  guest has no WK and cannot check `root_auth`, and does not need to: a guest can seal only under
  a share key they already hold, and the server accepts their write only inside their regions. A
  forged root can at worst misdirect a guest's own new text between two shares that guest is in.

The server does not reject a member's write sealed under the "wrong" key. A device that has not
heard about a share or a move seals under WK, and rejecting that would turn a stale view into a
lost edit. So a row can **drift**: its envelope names one key and its region is another's. Drift
comes from sharing, unsharing, moves across a region boundary (a move patches `parent_id` only;
descendants are not touched) and stale devices. It is repaired by re-sealing the three columns
and sending them through `rekey_blocks`, a strict form of the patch path: it writes only if the
row's `updated_at` still equals the version the client decrypted **and** the row's current
`share_id` is the one the new envelope names, and it leaves `updated_by` / `user_updated_at`
alone. Plaintext and version both come from the staged row, never from local `blocks` (a local
stamp is not a version). A lost compare-and-swap is skipped and retried when the newer row
arrives. Sealing and batching reuse the conversion code (`sealAndSend` in
`src/sync/conversion/sealing.ts`).

The two directions are not symmetric:

- **Out of a share (back to WK): automatic**, on any member device. It only reduces exposure.
- **Into a share: only by intent, on a device that holds both keys.** The device that performs
  the gesture (share, attach a root, move in, restore) re-keys the live rows it acted on, as part
  of the gesture. Rows that drift in any other way (a stale device's edit or new child under a shared
  block) are *offered*: "3 blocks under ‹page› are not visible to guests yet", with the list, and
  re-keyed on confirmation. Nothing is sealed under SK because the server said so.

A re-key changes no local row, creates no undo entry and is not an edit; it writes one history row
per block.

### 6.5 What the keys guarantee

| Row | Delivered to guest? | Guest can open? |
|---|---|---|
| in region, sealed under SK | yes | yes |
| in region, still sealed under WK | yes | no, until a member re-keys it |
| left the region, still sealed under SK | no | (not delivered) |

- Against an honest server, a guest reads exactly their regions.
- A guest never holds WK. A bug in §5.2, or a server that forges `share_id` or a root, delivers
  ciphertext the guest cannot open.
- The limit: tree shape is cleartext the server controls. A hostile server working with someone
  who holds an SK can move private rows under a real root. Existing content is still not re-keyed
  without a member confirming a list that would look wrong, but anything a member then *types*
  there is sealed under SK, behind a "shared" badge that is true as far as the client can tell.
  Alternative B does not have this limit. Closing it needs authenticated tree structure, which
  nothing in the current encryption design provides.
- A revoked share keeps its `wrapped_key`, so rows and history still sealed under it stay readable
  to members. No share key is ever discarded.

### 6.6 Plaintext workspaces

Everything in §5 applies and nothing in §6 does. Sharing takes effect the moment the region flips,
and the server is the only boundary, as it already is for the whole workspace.

## 7. The guest's client

A guest has, locally, rows of someone else's workspace: the regions they were given and nothing
else. No kernel pages, no definitions beyond built-in seeds, no ancestors of a root.

### 7.1 Session

- Access to a workspace becomes a first-class fact, `member(role)` or `guest`, derived from local
  rows. **Every gate that today branches on the read-only boolean or on a member row is re-keyed
  on it**: kernel-page creation, seed materialization, backfills and their claims, schema-change
  reprojection, the reference-target derive pass, the first-sync wait. The read-only boolean
  cannot carry this: it is false for an editor guest, who must still never create a kernel page.
  Those passes' "sync has settled" preconditions measure quiescence, not coverage, so a drained
  share stream would otherwise look like a drained workspace.
- A guest workspace appears in the switcher under "Shared with me" and lands on a share page that
  lists that share's roots. It needs its own landing resolver (the daily-note landing has nothing
  to show). A root is the top of the tree; ancestor walks already stop at a missing parent.
- Dynamic-extension seeds and extensions live in workspace blocks a guest lacks, so a guest runs
  the built-in set only.

### 7.2 Writes

- **Document writes: one gate in the commit pipeline.** Every row a document-scope transaction
  touched, at both its before and after position, must be in a region the session may write
  (§6.4's function). A write outside throws before anything is queued, so a refusal never becomes
  a local phantom. The server enforces the same rule. The session's read-only boolean remains the
  UI's coarse answer (a guest is read-only unless they hold an editor share in that workspace);
  per-block edit affordances are deferred.
- **Everything else stays on the device.** A guest's layout, recents and preferences are blocks
  outside every region. In a guest session those scopes commit under a write source the upload
  trigger skips. That is the `local-ephemeral` route the code used to have, removed when the
  rejection quarantine made it redundant; for a guest it is not redundant, because every such
  write would be counted in the "couldn't sync" warning forever, and in e2ee mode could not be
  sealed at all and would hold the queue.
- **Roots are structurally locked** for a guest: no delete, move, indent or reorder.
  `structuralEditPolicy.ts` covers indent and outdent at a scope root; delete and reorder are new.
- **A refused upload drops the whole local transaction** (§2). For a guest this is reachable in
  ordinary use: a member moves a block out of the region while the guest has an offline
  transaction touching it and three other blocks, and all four edits are quarantined. The payload
  is kept in the rejection table and shown; it is not silently lost, but it is not applied. A row
  leaving the guest's buckets is also removed locally without checking for pending edits.
  Splitting a transaction on refusal is not proposed; this is accepted and stated in the UI.

### 7.3 Derivations on a partial workspace

This is the highest-risk part of the design, and the part the first draft got wrong. Processors
(most run in the writing transaction) read the local index as if it were the whole workspace, and
**nothing re-derives a row when it arrives on another device** (§2). So a processor cannot simply
be skipped on a guest: what it would have derived stays missing in the owner's graph. And it
cannot run unchanged: it acts on absence it cannot judge.

What goes wrong unchanged, reasoned from the code and not reproduced:

| Processor | On a guest |
|---|---|
| reference parsing (`src/plugins/references/referencesProcessor.ts`) | looks `[[name]]` up in a partial alias index and mints a page at the workspace root on a miss; the gate then rolls back the whole write. In e2ee it drops the reference to an out-of-region page and uploads that |
| alias sync on rename (`src/plugins/alias/syncProcessor.ts`) | replaces the old name; blocks outside the region still say `[[Old]]`, and the owner's next edit of one mints a fresh empty "Old" page, silently re-pointing the link |
| property projection (`src/data/internals/propertyChildrenProcessor.ts`) | in `full` mode, deletes a seeded reference property whose value names a page outside the region |
| rename backlinks, inline deleted refs, merge retarget, annotation split retarget | rewrite only the referrers the guest can see |
| typeify, type initial values, definition edits | author schema from inside a region (§4 forbids it) |

The rule that replaces "skip unless safe":

1. **On a guest, a derivation only adds.** It never removes or replaces derived data on the
   strength of what is absent locally: references the guest cannot resolve are retained, a rename
   keeps the old alias as well as the new one, projection runs in its existing `additive` mode,
   pristine-seat reaping does not run.
2. **A gesture whose derivation needs the whole workspace is refused for a guest**: merge,
   typeify, definition edits.
3. Declared per processor at registration (processors register through keyed facets): runs for
   guests or not. The default is not.

That leaves one known gap: a guest typing `[[name]]` for a page outside the region records no
reference, so the page shows no backlink until a member next edits that block. The candidate fix
is a member-side step that re-runs the normal processors over a row last written by a non-member
when it arrives. It is one mechanism instead of a variant per processor, and it is the only place
derivation would upload from an arrival, so it is decided in step 3 with the fuzz results in hand,
not here.

Read-only guests run no document writes, so none of this applies to them.

## 8. What a region depends on outside itself

| Dependency | Without it the guest sees | Plan |
|---|---|---|
| built-in seeded property and type definitions | nothing missing | none needed |
| user-defined or extension-seeded definition | the field row as a raw `::((id))` child; an untyped block | read-only "not shared" row; stand-ins later |
| media block and its bytes | a missing-block placeholder | later; constraints below |
| a `[[page]]` or `((block))` outside the region | link text or a "not shared with you" placeholder, no label | add it to the share |
| comment threads (under the workspace Comments page) | none | later |
| ancestors and siblings of a root | nothing; the root is the top | intended |

The earlier design had the server supply labels for references a recipient cannot open. A label is
content and the server cannot read content in e2ee mode, so there are none in either mode.

The rest are later steps. Each gets a design of its own when it is built; what is fixed now is the
constraint it has to meet.

- **Definition stand-ins.** A definition cannot be attached as a root (several shares use it, a
  block has one region, and its subtree can be arbitrary content), and sharing the Properties and
  Types pages would disclose every schema name. So a share carries per-definition copies under the
  share block that a *guest's* registry reads under the original definition id. Constraint: a
  stand-in has its own type and its own guest-only projector. A second `property-schema` block
  with the same name would shadow the real definition in the owner's registry, workspace-wide.
- **Media.** A media block can be attached as an extra root, and its bytes re-sealed under SK at
  `<share_id>/<contentKey>`, with Storage policy on the first path segment. Constraints: today the
  media block id, the object path, the byte seal's associated data, the byte store and the upload
  queue are all keyed by workspace, so the resolver must try the region object and then the
  workspace object; the copy must happen in **both** directions (a guest's upload exists only
  under the share prefix, and must be copied to the workspace prefix when its block leaves the
  region); and a share's objects are never collected while any media block could still need them,
  which at first means never. Plaintext-to-e2ee conversion lists only `<workspace_id>/`, so it
  must refuse, **on the server**, while any share exists or any object remains under a share
  prefix.
- **Comments and a comment-only role.** Threads on a block in a region would be parented under
  the share block; a `commenter` may write only under that container. That is a region rule, so
  the server can enforce it in e2ee mode, where it cannot tell a comment from an edit by reading.
  **Read-only is cheap; comment-only is not**: a viewer role is one column and one policy clause.
- **Pages a guest creates** go under the share block, with ids from a share-scoped namespace in
  both modes, so they cannot collide with a row the guest cannot see. If the name already exists
  outside the region the workspace has two pages with one name; the owner's client shows its
  existing duplicate-name banner and offers the merge. (The earlier alias design had the server
  detect this through a unique index on aliases, which it cannot read in e2ee mode.)

## 9. Owner experience

- "Share…" on any block: pick or create a share, invite by email with a role, copy the share key
  (e2ee). The dialog lists roots, members, pending invitations, how many deleted blocks under the
  root are *not* being shared, what guests can see besides content (§5.5), and rows awaiting
  confirmation (§6.4). Share actions are online-only, as member management is.
- A root shows a badge; a block inside a region shows who can see it in its breadcrumb.
- Moving or pasting blocks **into** a region asks once ("this shares N blocks with …"); in e2ee
  mode that confirmation is what authorizes the re-key. Typing inside a region does not ask.
- Attaching a root inside another share's region is refused at first: it would silently take that
  subtree away from the outer share's guests. Moving one shared page under another is fine and
  changes nobody's access.

## 10. Corner cases

| Case | Result |
|---|---|
| Offline member edits a shared block, or adds a child, sealing under WK | accepted; guests keep the previous version; a member device offers the re-key |
| Member moves a subtree out | guests lose the rows on next sync; any member device re-keys back to WK |
| Share revoked | roots removed, regions revert, rows re-keyed back; the share row and its key are kept |
| Guest removed | the server stops delivering; they keep what they pulled. SK is not rotated: "revoke the share, create a new one" re-keys under a fresh key until a real rotation exists |
| Guest becomes a workspace member | their share memberships in that workspace are deleted; the workspace role governs |
| Owner deletes a shared page | the page and its blocks stay in the region as tombstones, so guests see it deleted and the owner's restore brings it back shared |
| Member restores a block deleted before sharing | it joins its parent's region on restore; the restore is the intent that re-keys it |
| Guest deletes a block that has a nested share's root below it | the guest tombstones only what they can see; the owner is left with live blocks under a deleted parent, recoverable by restoring it |
| History of a region's rows | member-only. Ciphertext under whichever key was current at each write; readable because no share key is discarded |

## 11. Build order

0. **Spike, no server work.** (a) The partial-workspace fuzz harness: copy a subtree into a fresh
   database as a guest would hold it, run random edits through today's processors, and record
   every write outside the subtree and every write inside it that depended on a missing row. This
   turns §7.3's table into evidence and sizes step 3. (b) The three Sync Streams questions in
   §5.4. (c) The region rule against its oracle under concurrent sessions.
1. **Access plane, read-only guests, plaintext workspaces.** Tables, the trigger, policies,
   streams, share RPCs, the member-or-guest fact and every gate re-keyed on it, the local-only
   write source, a minimal share dialog. An internal milestone: not useful to an e2ee owner.
2. **Key plane.** SK and authenticated roots, envelope v2 and its matchers, the per-key resolver
   (§6.3), `rekey_blocks`, the gesture and confirmation flows, the guest key prompt (reusing
   `openCanaryWithPastedKey` and the key UI; `WorkspaceKeyGate` itself gates a whole workspace and
   does not fit). After this step an e2ee workspace can share read-only.
3. **Guest editing.** The commit gate, root locking, the server allowlist, the derivation rules of
   §7.3 and the decision on member-side completion. This is the first point the stated baseline
   (shared editing) exists, and it exists without user-defined properties, media, comments or
   guest-created pages.
4. Definition stand-ins; guest-created pages.
5. Media in regions.
6. Later: comments and the commenter role, per-block edit affordances, an invite link carrying the
   key in the URL fragment (delivery only; access still needs the membership row), key rotation.

Verification that is part of the work. The first attempt at sharing in this codebase was abandoned
for lack of it, according to the earlier design's test plan.

- A property test of the region rule: random sequences of add root, remove root, revoke, insert
  (including child before parent), move, delete, restore and a `parent_id` cycle, comparing every
  row's `share_id` with an oracle that walks up `parent_id`. The cycle case must include removing
  the root afterwards: nothing in the disconnected component may keep the label.
- A pgTAP matrix over {member, workspace viewer who was a guest, guest editor, guest viewer,
  stranger} × {read, insert, edit, move in, move out, move under own descendant, root structure,
  frozen columns, direct `share_id` or `guest_written` write, tombstones}; and that a block a guest
  typed as a definition stays out of a member's registry after its share is revoked.
- A property test that a re-key never changes plaintext and never overwrites a concurrent edit,
  including a peer write landing on a stamp the device already holds, and a move out racing a
  re-key in.
- The fuzz harness from step 0, kept as a suite.

## 12. Rollout

One coordinated window: drain devices, deploy the migration, the sync config and the client
together, reload. Old clients cannot read v2 envelopes, so there is no mixed-version period worth
supporting. Existing data is untouched until the first share is created.

## 13. Decisions for Vlad

1. **Regions in place (A) or a separate workspace per share (B)?** §3 has both build lists and
   what each costs the owner. Pick: A, with step 0 run first because it can change the answer.
2. **Re-keying into a share needs intent on a member device** (§6.4). The cost: a block that a
   stale device added under a shared page stays invisible to guests until someone confirms it.
   The alternative, re-keying automatically wherever the server says a row is shared, is simpler
   and lets a hostile server choose what gets sealed under a share key. Pick: intent.
3. **When is editing shippable?** At step 3 a guest can edit text, structure and built-in
   properties, but sees user-defined properties as "not shared", sees no images, cannot comment
   and cannot create pages. Pick: ship at step 3, say so in the dialog.
4. **Key handling is manual and keys are not rotated.** One paste per share per device; removing a
   guest stops delivery but does not re-key. Pick: accept, as the workspace key works today.
5. **What guests can see besides content** (§5.5): structure, timing, authors, and whether a given
   block id exists. Pick: accept and disclose.

Defaults, not forks: nearest root wins and a root inside another share is refused at first; the
workspace owner alone manages shares; tombstones from before a share are never shared.

## 14. Rejected, deferred, and changed from the earlier designs

| Earlier design or alternative | Here | Why |
|---|---|---|
| Confidential subtree sharing on e2ee deferred; e2ee users get a second workspace or a plaintext export (PR #259) | built, as regions with a per-share key | the requirement changed, and §3's three choices remove much of the cost counted there |
| A block carries every share above it; nesting is additive (`effective_share_ids text[]`) | one region per block, nearest root wins | one row, one key; also a plain-column sync filter |
| Members need the share key delivered per member, or a key hierarchy | SK wrapped under WK in the share row | members already hold WK |
| Rows sealed under the old key after a transition were an open hazard | accepted as drift; re-keyed out automatically, in by intent | a stale device must not lose an edit, and the server must not choose what is disclosed |
| A session is entered by a share URL and scoped to one share | a guest session is the workspace, limited to the guest's regions | a share is a collection; the gate is per row |
| Read-only sessions route writes to a local-only source (since removed from the code) | reintroduced for a guest's non-document writes only | quarantine does not fit a write that can never be accepted |
| The server detects alias collisions and labels unreachable references | neither | the server cannot read content in e2ee mode |
| Recompute serialized by an advisory lock on the recomputed root | one advisory lock per workspace | the root lock does not serialize a move below a root against a share above it |
| Sharing a subtree includes its tombstones | a tombstone never gains a region | the owner cannot see what would be disclosed |
| Guests as `workspace_members` with a `guest` role | separate table | every existing policy would have to exclude it; one miss exposes the workspace |
| Giving the guest WK and scoping by row-level security (PR #259 option B) | rejected | access to everything rests on the server alone |
| A mirrored workspace per share, relayed by the owner's client (PR #259 C-projection) | rejected | two ciphertext domains with independent row versions need a reconciliation protocol |
| A per-block key for every row, with key grants per share | rejected | re-encrypts the whole workspace once and derives a key per row on every read |
| Rejecting a write sealed under the wrong key | rejected | a stale device's edit is lost |
| A shared "schema region" all guests read | rejected | leaks every schema name; a type definition's subtree is arbitrary content |
| Public and anonymous links | deferred | in e2ee mode a link can only be a client-side plaintext export (PR #259 option D), a deliberate and irreversible declassification; in a plaintext workspace the link design in `subtree-sharing.md` can sit on this access plane later |

Taken unchanged from the earlier documents: the access/key split, row-level security as the read
boundary, the workspace row reaching the guest, a key id on the wire and in the associated data,
never discarding a key that history depends on, server-set authorship for guests, gating
graph-scoped passes on membership (PR #259); the child-before-parent case, role-monotonic accepts,
a guest reading only their own membership row, one coarse role per session, the oracle test and
the two-user policy matrix (`subtree-sharing.md`); several roots per share, soft revocation, O(1)
access checks at 300k rows (`shares-and-api-tokens.html`).

Stale statements in those documents, for whoever reads them next: PR #259 says e2ee workspaces are
pinned to cell-backed properties, which
`…20260821120000_allow_e2ee_properties_migration_flip.sql` lifted; `subtree-sharing.md` describes a
`child_ids_json` column that is not in the current schema.
