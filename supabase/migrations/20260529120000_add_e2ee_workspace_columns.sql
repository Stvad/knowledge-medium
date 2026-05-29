-- E2EE per-workspace opt-in: server-side schema (docs/e2ee-design.html §7).
--
-- Adds two columns to public.workspaces — encryption_mode and wk_canary —
-- and a server-side guard that an e2ee workspace's block content columns
-- only ever hold well-formed enc:v1: ciphertext. No new tables.
--
-- wk_canary / encryption_mode immutability: the sketch (§7) proposed a
-- column-level privilege model (REVOKE UPDATE ... GRANT UPDATE(name,...))
-- to keep wk_canary unwritable by clients. We instead enforce it with a
-- BEFORE UPDATE trigger (below) that rejects any change to either e2ee
-- field. This is equivalent for v1 and simpler than untangling the
-- existing `GRANT ALL ON TABLE workspaces TO authenticated` + per-column
-- grants in the consolidated migration. It IS necessary: workspaces has a
-- live `workspaces_update` RLS policy for writers, so a direct PostgREST
-- UPDATE could otherwise overwrite wk_canary. Rotation (§14) — the only
-- legitimate later canary writer — is deferred to post-v1 and will add an
-- authorized SECURITY DEFINER bypass when it lands.
--
-- Every object is schema-qualified (public.*): the consolidated migration
-- runs with search_path = '' and qualifies all objects, so an unqualified
-- name would not resolve here either.

-- ── enc:v1: envelope shape check ────────────────────────────────────────
-- Shared by the wk_canary CHECK and the blocks ciphertext trigger so they
-- stay in lockstep. The server has no key, so it can't prove bytes are real
-- ciphertext — but it can require the envelope SHAPE: the enc:v1: prefix
-- plus a *decodable* base64url payload of at least nonce(12B)+tag(16B)=28B.
-- This rejects both a bare/garbage value AND a prefixed-but-readable value
-- like 'enc:v1:My plaintext note' (which would still leak plaintext).
-- Enforce the base64url group grammar: every 4 chars -> 3 bytes, with only
-- a 2-char (->1B) or 3-char (->2B) final group legal (no padding, URL-safe
-- alphabet). 28B floor => >= 9 full groups plus a terminal group (>= 38
-- data chars; data-char count mod 4 is never 1, which is impossible base64).
-- ReDoS-safe: Postgres's regex engine is DFA-based and the inner {4} is
-- fixed-width, so there is no ambiguous decomposition to backtrack on.
create or replace function public.is_enc_v1_envelope(v text)
    returns boolean
    language sql
    immutable
    set search_path = ''
    as $$
    select v ~ '^enc:v1:([A-Za-z0-9_-]{4}){9,}([A-Za-z0-9_-]{4}|[A-Za-z0-9_-]{2}|[A-Za-z0-9_-]{3})$'
$$;

-- ── workspaces: encryption_mode + wk_canary ─────────────────────────────
-- encryption_mode is a server-maintained PROJECTION of canary presence,
-- not the source of truth: per §6 a client decides "E2EE" from a durable
-- local pin earned by validating a WK, never from this column. It exists
-- for server-side feature gating and as a UX hint. Immutable once set.
alter table public.workspaces
    add column encryption_mode text not null default 'none'
        check (encryption_mode in ('none', 'e2ee'));

-- The key-check canary: an AEAD-sealed known plaintext (the workspace id)
-- that any future device decrypts to validate a pasted WK, even on a
-- workspace with no blocks yet. NULL for plaintext workspaces.
-- Format: enc:v1:base64url(nonce || ciphertext) of the workspace id, with
-- AAD = workspace_id || "canary" || schema_version (length-prefixed, §6).
alter table public.workspaces
    add column wk_canary text;

-- Biconditional cross-column CHECK: a canary is present iff mode is e2ee,
-- AND an e2ee canary must be a well-formed enc:v1: envelope (not merely a
-- prefixed string — otherwise the workspace would be unrecoverable, as
-- §8.2 could never validate a WK against a malformed canary).
alter table public.workspaces
    add constraint workspaces_wk_canary_matches_mode
    check (
        (encryption_mode = 'e2ee') = (wk_canary is not null)
        and (encryption_mode <> 'e2ee' or public.is_enc_v1_envelope(wk_canary))
    );

-- Immutability of BOTH e2ee fields (encryption_mode AND wk_canary).
--
-- This is load-bearing, not just defense-in-depth: the consolidated
-- migration keeps an RLS `workspaces_update` policy for workspace WRITERS
-- plus `GRANT ALL ON TABLE public.workspaces TO authenticated`, so an
-- authenticated writer CAN issue a direct UPDATE on this table (e.g. via
-- PostgREST) that sets wk_canary. The cross-column CHECK only requires the
-- replacement to be a well-formed envelope, so without this trigger a
-- writer (or a compromised/buggy client) could swap in an attacker-chosen
-- canary while keeping encryption_mode = 'e2ee', bricking every other
-- member's unlock (§8.2 validation would forever fail) or pinning key
-- validation to attacker-controlled data. (Thanks to the Codex review for
-- catching this — an earlier draft wrongly assumed clients had no UPDATE
-- path to public.workspaces.)
--
-- In v1 there is NO legitimate post-create writer of either field: the
-- canary is minted once inside create_workspace (an INSERT, which this
-- BEFORE UPDATE trigger doesn't gate), and rotation (§14) — the only
-- legitimate later writer — is deferred to post-v1 and will run as a
-- SECURITY DEFINER RPC that can carry an explicit bypass when added. So
-- reject ANY change to either column. rename (name/update_time) and
-- delete leave both untouched, so this never fires in normal operation.
create or replace function public.workspaces_prevent_e2ee_field_change()
    returns trigger
    language plpgsql
    set search_path = ''
    as $$
begin
    if old.encryption_mode is distinct from new.encryption_mode then
        raise exception 'workspaces.encryption_mode is immutable (% -> %)',
            old.encryption_mode, new.encryption_mode;
    end if;
    if old.wk_canary is distinct from new.wk_canary then
        raise exception 'workspaces.wk_canary is immutable (rotation is a post-v1 SECURITY DEFINER path)';
    end if;
    return new;
end;
$$;

create trigger workspaces_prevent_e2ee_field_change_trg
    before update on public.workspaces
    for each row
    execute function public.workspaces_prevent_e2ee_field_change();

-- ── create_workspace: accept e2ee mode + canary ─────────────────────────
-- Postgres function signatures include parameter types, so adding defaulted
-- params would OVERLOAD rather than replace the existing create_workspace,
-- making create_workspace('foo') ambiguous. Drop the old signature first.
-- (Returns jsonb via to_jsonb(v_workspace), so the new e2ee columns are
-- projected automatically — no RETURNS TABLE list to keep in sync, hence
-- no @projects tag here.)
drop function if exists public.create_workspace(text);

create function public.create_workspace(
        p_name            text,
        p_encryption_mode text default 'none',  -- 'none' | 'e2ee'
        p_workspace_id    text default null,     -- REQUIRED for e2ee (guard below)
        p_wk_canary       text default null      -- required iff e2ee
    )
    returns jsonb
    language plpgsql
    security definer
    set search_path = ''
    as $$
declare
    v_id text := coalesce(p_workspace_id, gen_random_uuid()::text);
    v_user_id text := auth.uid()::text;
    v_name text := coalesce(nullif(trim(p_name), ''), 'Workspace');
    v_now bigint := (extract(epoch from now()) * 1000)::bigint;
    v_workspace public.workspaces;
    v_member public.workspace_members;
begin
    if v_user_id is null then
        raise exception 'create_workspace: authentication required';
    end if;

    -- The e2ee canary is minted client-side binding the CLIENT-CHOSEN
    -- workspace id (it's the canary's plaintext and part of its AAD). If
    -- the server generated a different id the canary/mode CHECK would still
    -- pass, but the canary would never validate the WK on reload or another
    -- device. So e2ee MUST supply its own id, inserted verbatim.
    if p_encryption_mode = 'e2ee' and p_workspace_id is null then
        raise exception 'create_workspace: p_workspace_id is required for e2ee workspaces';
    end if;

    -- No explicit canary guard needed: workspaces_wk_canary_matches_mode
    -- enforces canary-present-iff-e2ee AND canary well-formedness, so a
    -- missing or garbage p_wk_canary for an e2ee create is rejected here.
    insert into public.workspaces
            (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary)
        values (v_id, v_name, v_user_id, v_now, v_now, p_encryption_mode, p_wk_canary)
        returning * into v_workspace;

    insert into public.workspace_members (id, workspace_id, user_id, role, create_time)
        values (gen_random_uuid()::text, v_workspace.id, v_user_id, 'owner', v_now)
        returning * into v_member;

    return jsonb_build_object(
        'workspace', to_jsonb(v_workspace),
        'member', to_jsonb(v_member)
    );
end;
$$;

grant execute on function public.create_workspace(text, text, text, text) to anon, authenticated, service_role;

-- ── blocks: require ciphertext in e2ee workspaces ───────────────────────
-- "The server only ever sees ciphertext for e2ee workspaces" must not rest
-- solely on the client upload hook. The blocks_* RLS policies check only
-- writer membership, not payload shape, so a stale client / missed hook /
-- direct PostgREST write could otherwise land plaintext in an e2ee
-- workspace. A CHECK can't read another table, so this is a BEFORE trigger
-- that looks the workspace up (PK lookup, cheap). The client encrypts even
-- "empty" values, so an e2ee block never legitimately holds bare ''/{}/[].
create or replace function public.blocks_require_ciphertext_for_e2ee()
    returns trigger
    language plpgsql
    set search_path = ''
    as $$
begin
    if exists (
        select 1 from public.workspaces w
        where w.id = new.workspace_id and w.encryption_mode = 'e2ee'
    ) and not (
        public.is_enc_v1_envelope(new.content) and
        public.is_enc_v1_envelope(new.properties_json) and
        public.is_enc_v1_envelope(new.references_json)
    ) then
        raise exception 'blocks in an e2ee workspace must carry a well-formed enc:v1: envelope in all content columns';
    end if;
    return new;
end;
$$;

create trigger blocks_require_ciphertext_for_e2ee_trg
    before insert or update on public.blocks
    for each row
    execute function public.blocks_require_ciphertext_for_e2ee();
