# Task: Block-subtree sharing on top of workspaces

Owner role: implementer subagent (editor + backend + data-layer researcher)
Type: feature + additive schema change
Estimated scope: large; touches `supabase/migrations/*`, `powersync/sync-config.yaml`, `src/data/*`, `src/components/*`, routing, and a couple of renderers.

> **Migration posture.** Workspaces are live in production data; do **not** drop or recreate `public.blocks`, `public.workspaces`, `public.workspace_members`, or `public.workspace_invitations`. All schema changes here are additive (new tables, one new column on `blocks`, two replaced policies). The PowerSync `dbFilename` does **not** need to be bumped — new columns/tables hydrate cleanly into the existing local DB.

---

## 1. Background

### 1.1 Today's model (already shipped)

- Every block has an immutable `workspace_id` (`supabase/migrations/20260421130000_create_blocks.sql:84`).
- RLS on `blocks` keys off workspace membership: `blocks_read` = `is_workspace_member`, `blocks_write` = `is_workspace_writer` (owner|editor). Viewer role is the workspace-scoped read-only role.
- PowerSync ships exactly the blocks for workspaces the user belongs to (`powersync/sync-config.yaml:49`).
- Client routes are `#<workspaceId>/<blockId>` (`src/utils/routing.ts:17`); workspace bootstrap is idempotent server-side via `ensure_personal_workspace` (`src/data/workspaces.ts:199`).
- Read-only enforcement is a **session-level** flag on `Repo` (`src/data/repo.ts:49-61`): when set, writes are routed to a `local-ephemeral` source so they never enter PowerSync's `ps_oplog`. Set at bootstrap from the workspace member role and reactively updated mid-session via `useMyWorkspaceRoles` (`src/App.tsx:258-263`).
- References across blocks resolve within the workspace via `getRootBlock` → `library` (`src/data/block.ts:367-380`).

### 1.2 What this task adds

Inside a workspace, the user can share any subtree of a block they can write to:

1. **Per-user invite share** — by email, via the existing invitation pattern, scoped to a subtree.
2. **Link share** — generate a token URL; recipients open it without an account being created up-front.
   - **Read-only links** are served by a snapshot RPC; no anonymous user is created.
   - **Read-write links** redeem into anonymous Supabase auth, attaching a per-user grant for that share.

Shares can be **nested**: a deeper descendant of an already-shared subtree can be shared independently with a different audience and/or role. Effective access is the union of all reaching grants; effective role is `max(role)` across them (`viewer < editor`).

### 1.3 What this task explicitly defers

- **Mixed-mode read-only resolution.** A given user-session always sees a single uniform role: either their workspace member role, or the role of the share-link they entered through. We do not compute per-block permissions at runtime. A workspace viewer who's been given write access to a sub-share must open the share URL to use the higher role. (See §3.6.)
- **Cross-workspace references** still resolve as today (workspace-local). A reference inside a shared subtree pointing at a block outside the shared subtree renders as a label-only stub for share recipients who lack workspace membership.
- **Intra-block character-level concurrency.** Same as today — block-granular last-write-wins.
- **Cross-workspace block moves.** Still rejected by the existing immutability trigger.
- **Audit log** for share grants/revocations.
- **Ownership transfer of a share** (the creator owns it; workspace owners can revoke).
- **Anonymous user GC.** First implementation may grow `auth.users` over time; a TTL job comes later (see §10.6).

---

## 2. Goals

- G1. A user can share any subtree they can write to, at `viewer` or `editor` role, via either explicit per-user invite (email) or a link token.
- G2. Link-share recipients can open and use a share without first creating an account.
- G3. Shares can be nested. A user with multiple overlapping grants gets the union of access; their effective role is the max across them.
- G4. RLS at Postgres + sync-rule enforcement at PowerSync are the actual security boundary. The client enforces only UX.
- G5. Within any single user-session, the read-only flag is uniform (workspace role OR share-link role). Per-block permission resolution is out of scope.
- G6. Existing data is preserved. No drop-and-recreate. New tables and columns are additive.

### Non-goals

See §1.3.

---

## 3. Locked design decisions

### 3.1 `blocks.effective_share_ids text[]` is the access materialization

Each block carries the set of share ids whose `root_block_id` is an ancestor of (or equal to) it. RLS and the new sync stream join on this column.

- **Why an array, not a scalar.** Nested shares with different audiences both need to reach descendants. A scalar nearest-ancestor would silently drop the outer share's audience.
- **Why a column on `blocks` and not a per-user closure.** Storage and write amplification on link-share fan-out. A popular link with N redeemers does **not** write any rows on `blocks` per redeemer; the closure-table alternative would write `subtree_size × redeemers` rows per redemption.
- **Trigger-maintained.** Source of truth is the recompute function (§5). The application must never write to this column directly; the client schema marks it server-managed.

### 3.2 Two-tier audience model

`block_shares` is the share *definition* (root block, role, link metadata). `block_share_members` is the audience list `(share_id, user_id, role)`. Per-user invites and link redemptions both insert into `block_share_members`. RLS predicate on `blocks` joins through `block_share_members` keyed on `auth.uid()`.

### 3.3 Read-only links are a snapshot RPC, not a sync stream

`get_shared_subtree(token)` returns a flat snapshot for read-only link tokens. No anonymous user is created, no `block_share_members` row, no PowerSync subscription. Live updates via Realtime channel are out of scope for v1; viewers reload to refresh. This keeps the cost of "share a page with the world" close to zero.

Read-write links go through `redeem_share_link(token)` — anonymous Supabase sign-in (already supported) → upsert `block_share_members` row → PowerSync streams the subtree via the new `shared_blocks` stream.

### 3.4 Single-mode per session, derived from URL

URL determines the mode:

- `#<workspaceId>/<blockId>` → workspace mode. `_isReadOnly = (member.role === 'viewer')`. Already implemented.
- `#share/<token>` or `#share/<token>/<blockId>` → share-recipient mode.
  - For read-only links: render from snapshot (no `Repo` writes).
  - For read-write links: redeem, then `_isReadOnly = (share.role === 'viewer')`, `setActiveWorkspaceId(<actual workspace id>)`, root the view at the share's `root_block_id`.

No per-block `AccessService`, no `useCanWrite` hook. The existing `repo.isReadOnly` flag is the only client-side gate.

### 3.5 Role monotonicity is a hard invariant

Every write to `block_share_members` from a server-defined RPC uses `GREATEST(existing.role, new.role)` semantics (with `editor > viewer` ordering). Demotion only happens through an explicit `update_share_member_role` RPC. This is the v1 fix for the redeem-then-redeem-with-lower-role downgrade footgun.

### 3.6 Workspace member with overlapping share = use workspace role

A user who is both a workspace member and a share recipient on a subtree of that workspace is treated as a workspace member only (their share grant is ignored while in workspace mode). To use the share's role they open the share URL, which puts them in share-recipient mode. This sidesteps the entire mixed-mode problem in v1.

### 3.7 `link_token` is a credential

The token never appears in any sync stream. It is stored in a separate row (or column-grant-isolated) so workspace members cannot read it just by virtue of seeing the share. The full-token round-trip is: returned once from `create_share_link`, surfaced in the share dialog, then never readable again. To re-share, regenerate.

### 3.8 Presentation root clipping

When the user's session is share-recipient mode, all upward traversals (`getRootBlock`, breadcrumbs, parent walks) clip at the share's `root_block_id`. Code paths that walk parents (`src/data/blockTraversal.ts:100`, `src/components/Breadcrumbs.tsx:8`) must respect this clip.

### 3.9 Single write chokepoint

Every local block mutation goes through `Repo.create` or `Repo.applyBlockChange` (already true). Both already gate on `_isReadOnly`. No new code path may construct a `BlockData` and INSERT into local SQLite directly. Import, paste, and agent-runtime paths already route through `Repo` — the rule is to keep it that way and add a client-side guard against mutating `effective_share_ids` (analogous to the `workspace_id` immutability guard at `src/data/repo.ts:271`).

---

## 4. Schema additions

### 4.1 Column on `blocks`

```sql
alter table public.blocks
  add column effective_share_ids text[] not null default '{}';

create index idx_blocks_effective_share_ids
  on public.blocks using gin (effective_share_ids);
```

Backfill: `update public.blocks set effective_share_ids = '{}'` (default already covers it; explicit is harmless).

### 4.2 New tables

All ids `text` (UUIDs). All "membership" tables get a single-column synthetic `id` so PowerSync raw tables work without composite-key string munging.

```sql
-- Share definition. workspace_id is denormalized from the root block at insert
-- time and immutable thereafter (root_block_id is also immutable).
create table public.block_shares (
  id text primary key,
  root_block_id text not null references public.blocks(id) on delete cascade,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  default_role text not null check (default_role in ('viewer', 'editor')),
  created_by_user_id text not null,
  create_time bigint not null,
  revoked_at bigint
);
create index idx_block_shares_root_block_id on public.block_shares(root_block_id);
create index idx_block_shares_workspace_id on public.block_shares(workspace_id);

-- Audience for a share. Per-user invites and link redemptions both insert here.
create table public.block_share_members (
  id text primary key,
  share_id text not null references public.block_shares(id) on delete cascade,
  user_id text not null,
  role text not null check (role in ('viewer', 'editor')),
  source text not null check (source in ('invite', 'link')),
  source_link_id text,        -- references share_links(id) when source='link'
  granted_by_user_id text,    -- inviter for source='invite', null for 'link'
  create_time bigint not null,
  unique (share_id, user_id)
);
create index idx_block_share_members_user_id on public.block_share_members(user_id);
create index idx_block_share_members_share_id on public.block_share_members(share_id);

-- Pending email-keyed invitations to a share. Mirrors workspace_invitations.
-- Not synced; queried on demand at sign-in via list_my_pending_share_invitations.
create table public.block_share_invitations (
  id text primary key,
  share_id text not null references public.block_shares(id) on delete cascade,
  email text not null,
  role text not null check (role in ('viewer', 'editor')),
  invited_by_user_id text not null,
  create_time bigint not null,
  unique (share_id, email)
);
create index idx_block_share_invitations_email on public.block_share_invitations(email);

-- Link share metadata. The token itself lives in block_share_link_secrets so
-- it never appears in any sync stream or in a row a workspace viewer can read.
create table public.share_links (
  id text primary key,
  share_id text not null references public.block_shares(id) on delete cascade,
  role text not null check (role in ('viewer', 'editor')),
  created_by_user_id text not null,
  create_time bigint not null,
  expires_at bigint,
  max_redemptions integer,
  redemption_count integer not null default 0,
  revoked_at bigint
);
create index idx_share_links_share_id on public.share_links(share_id);

-- Token storage isolated from share_links so RLS on share_links can be relaxed
-- (workspace writers see their own links' metadata) without leaking tokens.
-- Only the creator can SELECT this row.
create table public.share_link_secrets (
  link_id text primary key references public.share_links(id) on delete cascade,
  token text not null unique,
  created_by_user_id text not null
);
create index idx_share_link_secrets_token on public.share_link_secrets(token);
```

### 4.3 Invariants

- `block_shares.workspace_id` equals `(select workspace_id from blocks where id = root_block_id)`. Stamped on insert; rejected on update.
- `block_shares.root_block_id` is immutable.
- `blocks.effective_share_ids` always contains exactly the set of non-revoked `block_shares.id` whose `root_block_id` is `blocks.id` or an ancestor of it. This invariant is the responsibility of the recompute function (§5) and the four triggers calling it.
- `block_share_members(share_id, user_id)` is unique. Inserts use `GREATEST(existing.role, new.role)` semantics (§3.5).
- `share_links.share_id` is immutable. A token redeemed against a revoked link errors.

### 4.4 Triggers

```sql
-- Stamp + immutability for block_shares.
create trigger block_shares_stamp_workspace_id
  before insert on public.block_shares
  for each row execute function public.block_shares_stamp_workspace_id();

create trigger block_shares_immutable_keys
  before update on public.block_shares
  for each row execute function public.block_shares_reject_key_changes();
```

The workspace-stamp + immutability pair mirrors the existing `blocks_prevent_workspace_change_trg` pattern.

### 4.5 PowerSync publication

Append to the existing publication:

```sql
alter publication powersync add table
  public.block_shares,
  public.block_share_members,
  public.share_links;
```

`share_link_secrets` and `block_share_invitations` are intentionally **not** published (queried on demand via RPC).

---

## 5. `effective_share_ids` recompute

### 5.1 Function shape

```sql
create or replace function public.recompute_share_ids_subtree(p_root_block_id text)
returns void
language plpgsql
volatile
as $$
declare
  v_lock_key bigint := hashtext('subtree:' || p_root_block_id);
begin
  -- Serialize concurrent recomputes touching this root. The lock is
  -- transaction-scoped; released on commit/rollback.
  perform pg_advisory_xact_lock(v_lock_key);

  -- Seed: the share ids that cover p_root_block_id.
  -- Walk: every descendant inherits the parent's array unioned with any
  -- shares anchored at the descendant itself.
  with recursive
    parent_share_ids as (
      select coalesce(parent.effective_share_ids, '{}'::text[]) as ids
      from public.blocks self
      left join public.blocks parent on parent.id = self.parent_id
      where self.id = p_root_block_id
    ),
    walk(block_id, share_ids) as (
      select
        p_root_block_id,
        (select ids from parent_share_ids)
        || coalesce((
          select array_agg(s.id)
          from public.block_shares s
          where s.root_block_id = p_root_block_id
            and s.revoked_at is null
        ), '{}'::text[])
      union all
      select
        child.id,
        walk.share_ids
        || coalesce((
          select array_agg(s.id)
          from public.block_shares s
          where s.root_block_id = child.id
            and s.revoked_at is null
        ), '{}'::text[])
      from walk
      join public.blocks child on child.parent_id = walk.block_id
    )
  update public.blocks
  set effective_share_ids = (
    select array(select distinct unnest(walk.share_ids) order by 1)
    from walk
    where walk.block_id = blocks.id
  )
  from walk
  where blocks.id = walk.block_id;
end $$;
```

### 5.2 Triggers calling it

Four callers, each scoping the recompute to the smallest correct subtree:

1. **`blocks` AFTER INSERT** — set `effective_share_ids` to the parent's array (or `'{}'` if no parent). One-row update, no recursion.
2. **`blocks` AFTER UPDATE OF parent_id** — call `recompute_share_ids_subtree(NEW.id)`. The whole moved subtree is reconsidered against its new ancestor chain.
3. **`block_shares` AFTER INSERT** — call `recompute_share_ids_subtree(NEW.root_block_id)`.
4. **`block_shares` AFTER UPDATE OF revoked_at** (or AFTER DELETE) — call `recompute_share_ids_subtree(NEW.root_block_id)` (or `OLD` for delete). A revoked share is treated as if absent.

The advisory lock in `recompute_share_ids_subtree` protects against (2) racing (3)/(4) on overlapping subtrees.

### 5.3 Cross-row insert ordering robustness

Local writes can flush parent + child together; if PowerSync uploads child first, the on-insert trigger sees no parent and would set `effective_share_ids = '{}'`. Two protections:

- The `blocks` AFTER INSERT trigger also fires a one-row `UPDATE blocks SET effective_share_ids = ... WHERE parent_id = NEW.id` for any pre-existing children whose `effective_share_ids` is empty and whose parent (`NEW`) carries shares. (Self-correcting: if parent arrives later than child, parent's insert fixes the child.)
- The `blocks` AFTER UPDATE OF parent_id trigger covers the eventual reparent case when the child gets its `parent_id` set after creation.

### 5.4 Verification

`recompute_share_ids_subtree` is the source of truth, but its correctness is verified against an inline oracle CTE that walks each block up to the root and collects ancestor shares. See §11 for the property test.

---

## 6. RLS

### 6.1 `blocks` — replace `blocks_read` and `blocks_write`

```sql
drop policy if exists blocks_read on public.blocks;
drop policy if exists blocks_write on public.blocks;

create policy blocks_read on public.blocks
  for select
  using (
    public.is_workspace_member(workspace_id, auth.uid()::text)
    or exists (
      select 1
      from public.block_share_members sm
      join public.block_shares s on s.id = sm.share_id
      where sm.user_id = auth.uid()::text
        and sm.share_id = any (blocks.effective_share_ids)
        and s.revoked_at is null
    )
  );

create policy blocks_write on public.blocks
  for all
  using (
    public.is_workspace_writer(workspace_id, auth.uid()::text)
    or exists (
      select 1
      from public.block_share_members sm
      join public.block_shares s on s.id = sm.share_id
      where sm.user_id = auth.uid()::text
        and sm.role = 'editor'
        and sm.share_id = any (blocks.effective_share_ids)
        and s.revoked_at is null
    )
  )
  with check (
    public.is_workspace_writer(workspace_id, auth.uid()::text)
    or exists (
      select 1
      from public.block_share_members sm
      join public.block_shares s on s.id = sm.share_id
      where sm.user_id = auth.uid()::text
        and sm.role = 'editor'
        and sm.share_id = any (blocks.effective_share_ids)
        and s.revoked_at is null
    )
  );
```

`with check` mirrors `using` so a write cannot escape into a different access state.

### 6.2 `block_shares`

Readable by:
- the share creator,
- workspace members of the share's workspace (so the share dialog can list existing shares),
- the share's audience (members can see their own grant context).

```sql
alter table public.block_shares enable row level security;

create policy block_shares_read on public.block_shares
  for select
  using (
    created_by_user_id = auth.uid()::text
    or public.is_workspace_member(workspace_id, auth.uid()::text)
    or exists (
      select 1 from public.block_share_members sm
      where sm.share_id = block_shares.id
        and sm.user_id = auth.uid()::text
    )
  );

-- All mutations via security-definer RPCs.
```

### 6.3 `block_share_members`

Readable by:
- the member themselves,
- the share creator,
- **workspace writers** (NOT plain members — workspace viewers do not get to enumerate per-user invites across the workspace).

```sql
alter table public.block_share_members enable row level security;

create policy block_share_members_read on public.block_share_members
  for select
  using (
    user_id = auth.uid()::text
    or exists (
      select 1 from public.block_shares s
      where s.id = block_share_members.share_id
        and (
          s.created_by_user_id = auth.uid()::text
          or public.is_workspace_writer(s.workspace_id, auth.uid()::text)
        )
    )
  );
```

### 6.4 `share_links`

Readable by share creator + workspace writers (so the share dialog can list links). The token lives elsewhere.

```sql
alter table public.share_links enable row level security;

create policy share_links_read on public.share_links
  for select
  using (
    created_by_user_id = auth.uid()::text
    or exists (
      select 1 from public.block_shares s
      where s.id = share_links.share_id
        and public.is_workspace_writer(s.workspace_id, auth.uid()::text)
    )
  );
```

### 6.5 `share_link_secrets`

Tightest predicate. Readable only by the link creator. The redeem RPC is `security definer` so it can join through this table without granting client read.

```sql
alter table public.share_link_secrets enable row level security;

create policy share_link_secrets_read on public.share_link_secrets
  for select
  using (created_by_user_id = auth.uid()::text);
```

### 6.6 `block_share_invitations`

Same shape as `workspace_invitations` (`supabase/migrations/20260421130000_create_blocks.sql:208-217`): readable by invitee (matched on `auth.email()`) and by share creator / workspace writers. Mutations via RPC.

---

## 7. PowerSync sync streams

Append to `powersync/sync-config.yaml`:

```yaml
  block_shares:
    auto_subscribe: true
    query: |
      SELECT
        block_shares.id,
        block_shares.root_block_id,
        block_shares.workspace_id,
        block_shares.default_role,
        block_shares.created_by_user_id,
        block_shares.create_time,
        block_shares.revoked_at
      FROM public.block_shares
      JOIN public.workspace_members
        ON workspace_members.workspace_id = block_shares.workspace_id
       AND workspace_members.user_id = auth.user_id()

  block_share_members:
    auto_subscribe: true
    query: |
      SELECT
        block_share_members.id,
        block_share_members.share_id,
        block_share_members.user_id,
        block_share_members.role,
        block_share_members.source,
        block_share_members.source_link_id,
        block_share_members.granted_by_user_id,
        block_share_members.create_time
      FROM public.block_share_members
      WHERE block_share_members.user_id = auth.user_id()

  share_links:
    auto_subscribe: true
    query: |
      SELECT
        share_links.id,
        share_links.share_id,
        share_links.role,
        share_links.created_by_user_id,
        share_links.create_time,
        share_links.expires_at,
        share_links.max_redemptions,
        share_links.redemption_count,
        share_links.revoked_at
      FROM public.share_links
      JOIN public.block_shares
        ON block_shares.id = share_links.share_id
      JOIN public.workspace_members
        ON workspace_members.workspace_id = block_shares.workspace_id
       AND workspace_members.user_id = auth.user_id()

  shared_blocks:
    auto_subscribe: true
    query: |
      SELECT
        blocks.id,
        blocks.workspace_id,
        blocks.content,
        blocks.properties_json,
        blocks.child_ids_json,
        blocks.parent_id,
        blocks.create_time,
        blocks.update_time,
        blocks.created_by_user_id,
        blocks.updated_by_user_id,
        blocks.references_json,
        blocks.effective_share_ids
      FROM public.blocks
      JOIN public.block_share_members
        ON block_share_members.share_id = ANY (blocks.effective_share_ids)
       AND block_share_members.user_id = auth.user_id()
      JOIN public.block_shares
        ON block_shares.id = block_share_members.share_id
      WHERE block_shares.revoked_at IS NULL
```

The existing `blocks` stream should also include `effective_share_ids` in its SELECT so workspace members see it (used for "this subtree has a share" UI badges).

`share_link_secrets` and `block_share_invitations` are **not** synced.

> **PowerSync `ANY(array)` support — verify before deploy.** If the sync engine doesn't accept `share_id = ANY(blocks.effective_share_ids)` in a stream query, fall back to a junction table `block_share_coverage(block_id, share_id)` maintained by the same triggers. The `shared_blocks` stream then joins through the junction. The trigger logic is the same; only the storage shape changes.

---

## 8. RPCs

All `language plpgsql security definer set search_path = public`. All grants `to authenticated`.

### 8.1 Share lifecycle

```sql
-- Asserts caller has write on root_block_id (workspace writer or share-editor).
-- Stamps workspace_id from the block. Returns the new share.
create_block_share(p_root_block_id text, p_default_role text)
  returns public.block_shares;

revoke_block_share(p_share_id text)
  returns void;
  -- Asserts caller is share creator OR workspace writer.
  -- Sets revoked_at = now(); recompute fires via the trigger.
```

### 8.2 Per-user invites

Mirrors `invite_member_by_email`:

```sql
invite_share_member_by_email(p_share_id text, p_email text, p_role text)
  returns public.block_share_invitations;

accept_share_invitation(p_invitation_id text)
  returns public.block_share_members;
  -- GREATEST(existing.role, invitation.role) on conflict.

decline_share_invitation(p_invitation_id text)
  returns void;
```

```sql
remove_share_member(p_share_id text, p_user_id text)
  returns void;
  -- Caller is share creator, workspace writer, OR target user.

update_share_member_role(p_share_id text, p_user_id text, p_role text)
  returns public.block_share_members;
  -- The ONE place that can lower a role. Caller is share creator or workspace writer.
```

### 8.3 Link shares

```sql
create_share_link(
  p_share_id text,
  p_role text,
  p_expires_at bigint default null,
  p_max_redemptions integer default null
) returns table (link public.share_links, token text);
  -- Generates token = encode(gen_random_bytes(24), 'base64url').
  -- Inserts share_links + share_link_secrets rows in one txn.
  -- Returns the token to the caller exactly once.

revoke_share_link(p_link_id text) returns void;

redeem_share_link(p_token text) returns public.block_shares;
  -- Looks up token in share_link_secrets.
  -- Validates: link not revoked, not expired, redemption_count < max_redemptions.
  -- Upserts block_share_members with GREATEST(existing.role, link.role).
  -- Sets source='link', source_link_id=link.id.
  -- Increments redemption_count.
  -- Returns the share row so the client can navigate.
  -- Idempotent: re-redeeming by the same uid does not re-increment count
  --   if the membership row already exists for this link.
```

### 8.4 Read-only snapshot path

```sql
get_shared_subtree(p_token text) returns jsonb;
  -- For RO links only. No anonymous user is created.
  -- Validates token, link.role = 'viewer', not revoked/expired/exhausted.
  -- Returns { share: {...}, blocks: [BlockData...] } as a flat snapshot
  -- of the subtree under share.root_block_id at call time.
  -- Marked SECURITY DEFINER so it bypasses RLS for the snapshot read,
  -- after token validation.
  -- Increments redemption_count? — NO, snapshots are not redemptions.
```

### 8.5 Listing helpers

```sql
list_shares_in_workspace(p_workspace_id text)
  returns table (...)
  -- Caller must be a workspace member.

list_share_members_with_emails(p_share_id text)
  returns table (...);

list_my_pending_share_invitations() returns table (...);
  -- Mirrors list_my_pending_invitations.
```

### 8.6 Reference resolution (cross-share / outside-share)

```sql
resolve_block_link_stubs(p_block_ids text[])
  returns table (id text, content_label text, accessible boolean);
  -- For each id: if the caller can access the block (workspace member or share
  -- recipient), accessible=true and content_label is the leading text (truncated).
  -- Otherwise accessible=false and content_label is null.
  -- Used by the renderer to show stubs for references pointing outside the
  -- viewer's accessible scope.
```

---

## 9. Client changes

### 9.1 Types (`src/types.ts`)

```ts
export interface BlockShare {
  id: string
  rootBlockId: string
  workspaceId: string
  defaultRole: 'viewer' | 'editor'
  createdByUserId: string
  createTime: number
  revokedAt: number | null
}

export interface BlockShareMembership {
  id: string
  shareId: string
  userId: string
  role: 'viewer' | 'editor'
  source: 'invite' | 'link'
  sourceLinkId: string | null
  grantedByUserId: string | null
  createTime: number
}

export interface ShareLink {
  id: string
  shareId: string
  role: 'viewer' | 'editor'
  createdByUserId: string
  createTime: number
  expiresAt: number | null
  maxRedemptions: number | null
  redemptionCount: number
  revokedAt: number | null
}

export interface BlockShareInvitation {
  id: string
  shareId: string
  email: string
  role: 'viewer' | 'editor'
  invitedByUserId: string
  createTime: number
}

// BlockData gains effectiveShareIds. The field is server-managed; the client
// must NEVER mutate it through Repo.applyBlockChange (see §9.3).
export interface BlockData {
  // ... existing fields
  effectiveShareIds: string[]
}
```

### 9.2 Schema (`src/data/blockSchema.ts`, new `src/data/shareSchema.ts`)

- Add `effective_share_ids` column to `BLOCK_STORAGE_COLUMNS`. Stored locally as JSON-array text (consistent with `child_ids_json`); `parseBlockRow` parses it.
- Add raw-table definitions for `block_shares`, `block_share_members`, `share_links`. **No** raw table for `share_link_secrets` (not synced) or `block_share_invitations` (RPC-only).
- Register new raw tables on `appSchema.withRawTables` in `src/data/repoInstance.ts`.
- Add CREATE TABLE statements during `initializePowerSyncDb`.
- **No CRUD-forwarding triggers** for the new tables — all mutations from the client go through Supabase RPCs, not local CRUD.

### 9.3 `Repo` (`src/data/repo.ts`)

- `applyBlockChange` already enforces `workspaceId` immutability ([repo.ts:271](src/data/repo.ts:271)). Add the same guard for `effectiveShareIds`: if the new snapshot's array differs from the old, throw — surfaces escape paths loudly.
- `Repo.create` does not stamp `effectiveShareIds` (it's server-computed). Local insert sets it to `[]`; the inbound sync replaces it with the trigger output.
- No new public methods; no `AccessService`.

### 9.4 Routing (`src/utils/routing.ts`)

Extend the route shape:

```ts
export type AppRoute =
  | { kind: 'workspace', workspaceId?: string, blockId?: string }
  | { kind: 'share', token: string, blockId?: string }
```

Hash forms:
- `#<workspaceId>/<blockId>` (existing)
- `#share/<token>` or `#share/<token>/<blockId>` (new)

Parser disambiguates on the `share/` prefix. `buildAppHash` gets a share variant. `writeAppHash` accepts either.

### 9.5 Bootstrap (`src/App.tsx`)

The current `getInitialBlock` resolves a workspace-mode session. Add a share-mode branch that runs **before** workspace resolution when `parseAppHash` returns `kind: 'share'`:

1. Call a small RPC `peek_share_link(token)` that returns `{role, share_id, root_block_id, workspace_id, requires_redemption: boolean}` without side effects (and without exposing the token to anyone else). For role=`viewer`, `requires_redemption=false`; for role=`editor`, `requires_redemption=true`.
2. If `role=viewer` and the user is anonymous: render a `SnapshotShareView` that calls `get_shared_subtree(token)` and feeds the snapshot into a stripped-down render path (no `Repo` writes; no PowerSync subscribe). This is its own component tree.
3. If `role=editor` (or `role=viewer` and the user is signed in and prefers a synced view, future): ensure a Supabase session exists (anonymous sign-in if needed) → call `redeem_share_link(token)` → `repo.setActiveWorkspaceId(workspace_id)` → `repo.setReadOnly(role === 'viewer')` → wait for the share's `root_block_id` to land via `shared_blocks` (re-use `awaitLocalRootBlock` shape) → render the existing `BlockComponent` rooted at `root_block_id`.

Existing workspace-mode branch is unchanged.

### 9.6 Presentation root clipping

`getRootBlock` (`src/data/blockTraversal.ts:100`) takes an optional `clipAt: string` parameter; when set, returns whichever is reached first — the natural root or the clip block. Same parameter threaded through `Block.parents()` and `Breadcrumbs`. Share-mode bootstrap passes `clipAt = share.root_block_id`.

In workspace mode the parameter is unset and behavior is unchanged.

### 9.7 UI

- **Share dialog** (`src/components/share/ShareDialog.tsx`, new). Reachable from:
  - Block bullet context menu in `DefaultBlockRenderer` (add "Share…" above "Show/Hide Properties").
  - Command palette `share_block` action.
  - Per share, two tabs:
    - **People**: list members (via `list_share_members_with_emails`); invite by email (mirrors workspace invite UI); remove / update role.
    - **Link**: existing links (with `redemption_count`, `expires_at`, `max_redemptions`, role); copy URL (token is shown once on creation, then "regenerate to copy again"); revoke; create new link with role + expiry + max-redemptions.
- **Share badge** on shared blocks. The bullet for a block whose `id` is a `block_shares.root_block_id` shows a small share indicator. Read from local `block_shares` table.
- **Pending share invitation accept** in the existing `PendingInvitations` notification, alongside workspace invitations. New RPC `list_my_pending_share_invitations` is a parallel of the workspace one.
- **Share-mode chrome.** When in share-recipient mode, the workspace switcher is hidden; the header shows "Shared with you · <share root content snippet>" + an "Open in workspace" link if the user is also a workspace member.
- **Reference stubs.** `MarkdownContentRenderer` calls `resolve_block_link_stubs` for any reference whose target is not in the local cache, and renders `accessible=false` results as a label-only chip rather than a navigable link.

### 9.8 Read-only enforcement (existing machinery)

No new code path. The existing `_isReadOnly` flag + `local-ephemeral` source routing in `Repo` handles all of it. Bootstrap sets the flag from either the workspace member role (existing) or the share role (new). UI gating that today consults `repo.isReadOnly` (e.g. property dialog) automatically picks up share-recipient mode.

The **paste / import / agent-runtime** paths must be audited to confirm they do not synthesize blocks outside `Repo` (current code already routes through `Repo`; the audit is to make sure it stays that way and to add an assertion).

---

## 10. Phased plan

Each phase is an independent commit; each leaves `yarn tsc -b` and `yarn vitest run` green.

### Phase 1 — Schema + recompute + RLS

**Files:** new `supabase/migrations/<ts>_block_shares.sql`.

- Add `blocks.effective_share_ids` column + GIN index.
- Create the four new tables + indexes.
- Install `recompute_share_ids_subtree` and the four trigger pairs.
- Install `block_shares_stamp_workspace_id` + immutability triggers.
- Replace `blocks_read` and `blocks_write` policies with the union-with-shares versions.
- Add RLS policies on the new tables.
- `alter publication powersync add table ...` for the three sync-eligible tables.

**Verification:**
- `npx supabase db push` against a scratch project succeeds.
- Manual two-user matrix: A creates a share with B as a member, B sees A's subtree but not siblings.

### Phase 2 — RPCs

**Files:** same migration or follow-up.

- All RPCs from §8.
- Token generation uses `encode(gen_random_bytes(24), 'base64url')`.
- `redeem_share_link` is idempotent on `(link_id, user_id)`.
- `accept_share_invitation` and `redeem_share_link` use `GREATEST` for role.

**Verification:** unit-style SQL tests (psql sessions impersonating two users) for each RPC's authorization branches and the `GREATEST` semantics.

### Phase 3 — PowerSync sync rules

**Files:** `powersync/sync-config.yaml`.

- Append the four new streams from §7.
- Add `effective_share_ids` to the existing `blocks` stream SELECT.
- `npx powersync@latest validate && npx powersync@latest deploy`.
- **Verify `ANY(array)` is supported.** If not, switch to the junction-table fallback in §7 before merging.

**Verification:** signed-in user A creates a share; B opens the redeem link; B's local `blocks` table contains the subtree, `block_shares` contains the share row, `block_share_members` contains B's grant.

### Phase 4 — Client schema + types

**Files:** `src/types.ts`, `src/data/blockSchema.ts`, new `src/data/shareSchema.ts`, `src/data/repoInstance.ts`, `src/data/blockStorage.ts`.

- Add `effective_share_ids` to block column lists, parsers, JSON-snapshot builders.
- Register raw tables for `block_shares`, `block_share_members`, `share_links`. Add CREATE TABLE statements.
- Extend `BlockData` and `parseBlockRow`.
- Add `applyBlockChange` immutability guard for `effectiveShareIds`.

**Verification:** `yarn tsc -b` clean; existing tests pass with fixture updates that set `effectiveShareIds: []`.

### Phase 5 — Routing + share-mode bootstrap

**Files:** `src/utils/routing.ts`, `src/App.tsx`, new `src/components/share/SnapshotShareView.tsx`, new `src/data/shares.ts` (RPC wrappers).

- Extend `parseAppHash` / `buildAppHash`.
- Branch in `App` on share-mode.
- `SnapshotShareView` for read-only links (no `Repo` writes).
- Read-write redeem path → share-recipient session.

**Verification:** open a `#share/<token>` URL in an incognito window; for RO link, see snapshot rendered without anonymous sign-in; for RW link, anon sign-in fires, redeem succeeds, subtree renders.

### Phase 6 — Presentation root clipping

**Files:** `src/data/blockTraversal.ts`, `src/data/block.ts`, `src/components/Breadcrumbs.tsx`.

- Thread `clipAt` through `getRootBlock`, `Block.parents()`, breadcrumb construction.
- Pass it from share-mode bootstrap.

**Verification:** in share-recipient mode, breadcrumbs end at the share root; `getRootBlock` returns the share root, not the workspace root; reference auto-creation still works (creates entries in the workspace's `library`, transparent to the share recipient because they have read access via the share).

### Phase 7 — Share dialog + indicators

**Files:** new `src/components/share/ShareDialog.tsx`, new `src/components/share/ShareBadge.tsx`, edits to `DefaultBlockRenderer.tsx`, `src/shortcuts/defaultShortcuts.ts`.

- Dialog with People + Link tabs.
- Block bullet "Share…" entry.
- `share_block` command palette action.
- Share badge on shared block bullets.
- `PendingInvitations` accepts both kinds of invitation.

**Verification:** end-to-end happy paths from §12.

### Phase 8 — Reference stubs + cleanup

**Files:** `src/components/markdown/*` (ref renderer), new `resolve_block_link_stubs` consumer.

- Cross-scope reference rendering as label-only chips.
- Update `README.md` and `knowledge.md` with subtree-sharing concept.
- Remove any temporary scaffolding.

**Verification:** in share-recipient mode, references inside the shared subtree pointing outside it render as label-only chips; clicking is a no-op (or a "you don't have access" toast).

---

## 11. Test plan (this is mandatory; the prior implementation cratered for lack of it)

### 11.1 Recompute correctness (`src/data/test/effectiveShareIds.test.ts` + a SQL-side test)

Property test: random sequence of `(create_share | revoke_share | move_block | insert_block | delete_block)` ops. After each op, compare every block's `effective_share_ids` with an oracle computed inline by a recursive CTE walking up `parent_id` and unioning matching `block_shares`. Run for ≥1000 random sequences.

### 11.2 RLS two-user matrix (psql)

Authenticate as user A and user B (use `set local request.jwt.claims = ...` with crafted JWT claims). Verify, for every combination of `(workspace member role × share membership × revoked share × invitation pending)`, that SELECT/UPDATE/DELETE on `blocks`, `block_shares`, `block_share_members`, `share_links`, `share_link_secrets` either succeed or fail as specified.

### 11.3 Role-monotonicity

- `redeem_share_link` does not lower an existing higher-role membership.
- `accept_share_invitation` does not lower an existing higher-role membership.
- `update_share_member_role` (the only path that may lower) succeeds for the creator and fails for everyone else.

### 11.4 Concurrency

- Two transactions: T1 calls `create_block_share(root=R)` while T2 calls `update blocks set parent_id=...` re-parenting a subtree of R. Both commit. Final `effective_share_ids` matches the oracle.

### 11.5 Cross-row insert order (PowerSync)

- Locally create parent + child as part of one batch; force PowerSync to upload child first; verify the inbound trigger sequence converges to the correct `effective_share_ids` for both (parent's insert covers the child's gap per §5.3).

### 11.6 Read-only gating coverage

Enumerate every UI mutation entry point (every action in `defaultShortcuts.ts`, the paste handler, the import handler, the property editor, the renderer block-code editor) and assert that with `repo.setReadOnly(true)` set, none of them produce a non-ephemeral write. This is most easily a smoke test that snapshots the `block_events` table for `source != 'local-ephemeral'` after running each handler.

### 11.7 Presentation root

- Share recipient session: `getRootBlock(any descendant)` returns the share root.
- Breadcrumbs do not show ancestors above the share root.
- Workspace member session: behavior unchanged (no clipping).

### 11.8 Anonymous redeem flow

- New incognito session opens `#share/<token>` with `role='editor'` link.
- Anonymous Supabase sign-in fires.
- `redeem_share_link` succeeds.
- Edits apply; A (the owner) sees them via PowerSync.
- Re-redeeming with the same anon session does not double-increment `redemption_count`.

### 11.9 Token isolation

- A workspace viewer queries `share_links`, `block_shares`, `block_share_members` directly via Supabase REST. Verify they never see a `token` (it's not even a column on those tables).
- Querying `share_link_secrets` directly returns zero rows for a non-creator.
- The redeem RPC does the join internally and returns the share row, not the token.

---

## 12. Manual integration matrix

After all phases land, verify with two test accounts A (workspace owner) and B (separate user) plus an anonymous guest:

- A creates a workspace W, adds B as workspace `viewer`. B can read W, cannot edit.
- A creates a share S₁ on a subtree T inside W with default role `editor`, invites B.
- B accepts. **In workspace mode** B is still a viewer (workspace role wins per §3.6). **Opens the share URL** → in share-recipient mode B can edit T.
- A creates a *nested* share S₂ on a sub-subtree of T with role `viewer`, invites C (a third user).
  - C can read the sub-subtree only.
  - B (with editor on S₁ via share-mode) can still edit the sub-subtree because S₁ also covers it; verify the `effective_share_ids` array for the sub-subtree contains both S₁ and S₂.
- A creates a read-only link on T, copies it.
- Guest opens the link in an incognito window. No anonymous user is created. The snapshot renders.
- A creates a read-write link on a different subtree, copies it.
- Guest opens it. Anonymous sign-in fires. Guest edits. A sees edits.
- A revokes the read-write link. Guest's next edit attempt fails (RLS rejection); local UI still works ephemerally.
- A moves a sub-subtree out of T. The moved subtree's `effective_share_ids` no longer includes S₁; B and C lose access via PowerSync stream re-eval.
- A moves the sub-subtree back. Access restored.
- A revokes S₁. B loses access to T; sub-subtree still accessible to C via S₂.
- A delivers the workspace `delete_workspace` (already exists). All shares cascade.

---

## 13. Guardrails (the footgun checklist)

1. **Role-monotonic upserts** in `redeem_share_link` and `accept_share_invitation`. Demotion only via `update_share_member_role`.
2. **Token isolation** via `share_link_secrets` table. Tokens never appear in any sync stream or in any row a non-creator can SELECT.
3. **Trigger advisory lock** in `recompute_share_ids_subtree` to serialize concurrent move + share-mutation on overlapping subtrees.
4. **Re-runnable recompute on insert.** On-insert trigger covers the "child arrives before parent" case by also checking for empty children of the inserted parent.
5. **`with check` mirrors `using`** on the `blocks_write` policy.
6. **Workspace-viewer != share-membership read.** `block_share_members_read` requires writer (or creator), not member.
7. **`effectiveShareIds` immutability guard** in `Repo.applyBlockChange`. Reject any local mutation of the field.
8. **Single chokepoint for writes.** All local block writes go through `Repo`. No paste/import/agent-runtime path may construct `BlockData` and INSERT directly. Audit and add an assertion.
9. **Presentation root clipping** for `getRootBlock`, `Block.parents`, `Breadcrumbs` in share-recipient mode.
10. **Default to "allow, let RLS reject"** on permission ambiguity. The session-level `_isReadOnly` flag is set once at bootstrap; we don't compute per-block permission and so don't have a cache-miss "unknown" state to deal with.
11. **PowerSync `ANY(array)` support** verified before merging Phase 3. Junction-table fallback ready if not supported.
12. **`redeem_share_link` is idempotent** on `(link_id, user_id)`. `redemption_count` only increments on first redemption.
13. **Tokens are URL-safe** by construction (`base64url`). UI still uses `encodeURIComponent` defensively.
14. **`get_shared_subtree` does not increment `redemption_count`.** Snapshots are not redemptions.

---

## 14. Out of scope (explicitly deferred)

- Mixed-mode per-block permission resolution. A workspace member who is also a share editor gets the workspace role only while in workspace mode.
- Anonymous-to-email account upgrade ("claim" your guest edits).
- Anonymous-user GC. Users created by RW link redemption persist; a TTL cleanup job is a follow-up.
- Realtime updates inside the read-only snapshot view (`SnapshotShareView`). V1 reloads to refresh.
- Auto-expansion of references inside a shared subtree to read-only-share their targets.
- Audit log of share grant/revocation/redemption events.
- Per-property or per-field permissions.
- Cross-workspace block moves (still rejected by the immutability trigger).
- Ownership transfer of a share.

---

## 15. References

- Existing schema: `supabase/migrations/20260421130000_create_blocks.sql`, `supabase/migrations/20260426214000_seed_root_in_workspace_rpcs.sql`.
- Existing sync config: `powersync/sync-config.yaml`.
- Existing readonly machinery: `src/data/repo.ts:49-61`, `src/data/repoInstance.ts:186-235`.
- Existing routing: `src/utils/routing.ts`, `src/App.tsx:236-272`.
- Existing workspace invite flow (template for share invite flow): `src/data/workspaces.ts:268-311`, `src/components/workspace/PendingInvitations.tsx`.
- Existing reference resolver (template for cross-scope stub resolution): `src/data/block.ts:367-380`.
- Discussion notes: see chat log preceding this spec for the design tradeoffs (per-user closure vs. column-on-blocks, scalar vs. array, presentation root resolution, anon-link semantics).
