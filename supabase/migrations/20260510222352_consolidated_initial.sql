


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "private";


ALTER SCHEMA "private" OWNER TO "postgres";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";



COMMENT ON EXTENSION "pg_stat_statements" IS 'track planning and execution statistics of all SQL statements executed';



CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";



COMMENT ON EXTENSION "pgcrypto" IS 'cryptographic functions';



CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";



COMMENT ON EXTENSION "supabase_vault" IS 'Supabase Vault Extension';



CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";



COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';



CREATE OR REPLACE FUNCTION "private"."is_workspace_member"("p_workspace_id" "text", "p_user_id" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace_id and user_id = p_user_id
  );
$$;


ALTER FUNCTION "private"."is_workspace_member"("p_workspace_id" "text", "p_user_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."is_workspace_owner"("p_workspace_id" "text", "p_user_id" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select exists (
    select 1 from public.workspaces
    where id = p_workspace_id and owner_user_id = p_user_id
  );
$$;


ALTER FUNCTION "private"."is_workspace_owner"("p_workspace_id" "text", "p_user_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."is_workspace_writer"("p_workspace_id" "text", "p_user_id" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace_id
      and user_id = p_user_id
      and role in ('owner', 'editor')
  );
$$;


ALTER FUNCTION "private"."is_workspace_writer"("p_workspace_id" "text", "p_user_id" "text") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."workspace_members" (
    "id" "text" NOT NULL,
    "workspace_id" "text" NOT NULL,
    "user_id" "text" NOT NULL,
    "role" "text" NOT NULL,
    "create_time" bigint NOT NULL,
    CONSTRAINT "workspace_members_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'editor'::"text", 'viewer'::"text"])))
);


ALTER TABLE "public"."workspace_members" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."accept_invitation"("p_invitation_id" "text") RETURNS "public"."workspace_members"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_user_id text := auth.uid()::text;
  v_email text := lower(trim(coalesce(auth.email(), '')));
  v_invitation public.workspace_invitations;
  v_member public.workspace_members;
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  if v_user_id is null then raise exception 'Not authenticated'; end if;
  if v_email = '' then raise exception 'Sign in with an email to accept invitations'; end if;

  select * into v_invitation
  from public.workspace_invitations
  where id = p_invitation_id;

  if not found then
    raise exception 'Invitation not found';
  end if;

  if lower(v_invitation.email) <> v_email then
    raise exception 'Invitation is for a different email';
  end if;

  insert into public.workspace_members (
    id, workspace_id, user_id, role, create_time
  )
  values (
    gen_random_uuid()::text,
    v_invitation.workspace_id,
    v_user_id,
    v_invitation.role,
    v_now
  )
  on conflict (workspace_id, user_id) do update
    set role = excluded.role
  returning * into v_member;

  delete from public.workspace_invitations where id = p_invitation_id;

  return v_member;
end $$;


ALTER FUNCTION "public"."accept_invitation"("p_invitation_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."blocks_clamp_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
  server_now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  if NEW.updated_at > server_now_ms then
    NEW.updated_at := server_now_ms;
  end if;
  if NEW.created_at > server_now_ms then
    NEW.created_at := server_now_ms;
  end if;
  return NEW;
end $$;


ALTER FUNCTION "public"."blocks_clamp_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."blocks_prevent_workspace_change"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if OLD.workspace_id is distinct from NEW.workspace_id then
    raise exception 'blocks.workspace_id is immutable (% -> %)',
      OLD.workspace_id, NEW.workspace_id
      using errcode = 'check_violation';
  end if;
  return NEW;
end $$;


ALTER FUNCTION "public"."blocks_prevent_workspace_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_workspace"("p_name" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_user_id text := auth.uid()::text;
  v_workspace public.workspaces;
  v_member public.workspace_members;
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
  v_name text := coalesce(nullif(trim(p_name), ''), 'Workspace');
  v_workspace_id text := gen_random_uuid()::text;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.workspaces (id, name, owner_user_id, create_time, update_time)
  values (v_workspace_id, v_name, v_user_id, v_now, v_now)
  returning * into v_workspace;

  insert into public.workspace_members (id, workspace_id, user_id, role, create_time)
  values (gen_random_uuid()::text, v_workspace.id, v_user_id, 'owner', v_now)
  returning * into v_member;

  return jsonb_build_object(
    'workspace', to_jsonb(v_workspace),
    'member', to_jsonb(v_member)
  );
end $$;


ALTER FUNCTION "public"."create_workspace"("p_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."decline_invitation"("p_invitation_id" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_user_id text := auth.uid()::text;
  v_email text := lower(trim(coalesce(auth.email(), '')));
  v_invitation public.workspace_invitations;
begin
  if v_user_id is null then raise exception 'Not authenticated'; end if;

  select * into v_invitation
  from public.workspace_invitations
  where id = p_invitation_id;

  if not found then return; end if;

  if lower(v_invitation.email) <> v_email
     and not private.is_workspace_owner(v_invitation.workspace_id, v_user_id) then
    raise exception 'Cannot decline an invitation for another user';
  end if;

  delete from public.workspace_invitations where id = p_invitation_id;
end $$;


ALTER FUNCTION "public"."decline_invitation"("p_invitation_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_workspace"("p_workspace_id" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_user_id text := auth.uid()::text;
begin
  if v_user_id is null then raise exception 'Not authenticated'; end if;
  if not private.is_workspace_owner(p_workspace_id, v_user_id) then
    raise exception 'Only the workspace owner can delete the workspace';
  end if;

  delete from public.workspaces where id = p_workspace_id;
end $$;


ALTER FUNCTION "public"."delete_workspace"("p_workspace_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ensure_personal_workspace"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_user_id text := auth.uid()::text;
  v_workspace public.workspaces;
  v_member public.workspace_members;
  v_default_name text;
  v_email text;
  v_create_result jsonb;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select w.* into v_workspace
  from public.workspaces w
  join public.workspace_members m on m.workspace_id = w.id
  where m.user_id = v_user_id
  order by w.create_time asc, w.id asc
  limit 1;

  if found then
    select m.* into v_member
    from public.workspace_members m
    where m.workspace_id = v_workspace.id and m.user_id = v_user_id
    limit 1;

    return jsonb_build_object(
      'workspace', to_jsonb(v_workspace),
      'member', to_jsonb(v_member),
      'inserted', false
    );
  end if;

  v_email := nullif(trim(coalesce(auth.email(), '')), '');
  if v_email is not null then
    v_default_name := split_part(v_email, '@', 1) || '''s workspace';
  else
    v_default_name := 'Personal';
  end if;

  v_create_result := public.create_workspace(v_default_name);
  return v_create_result || jsonb_build_object('inserted', true);
end $$;


ALTER FUNCTION "public"."ensure_personal_workspace"() OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workspace_invitations" (
    "id" "text" NOT NULL,
    "workspace_id" "text" NOT NULL,
    "email" "text" NOT NULL,
    "role" "text" NOT NULL,
    "invited_by_user_id" "text" NOT NULL,
    "create_time" bigint NOT NULL,
    CONSTRAINT "workspace_invitations_role_check" CHECK (("role" = ANY (ARRAY['editor'::"text", 'viewer'::"text"])))
);


ALTER TABLE "public"."workspace_invitations" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."invite_member_by_email"("p_workspace_id" "text", "p_email" "text", "p_role" "text") RETURNS "public"."workspace_invitations"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_caller text := auth.uid()::text;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_invitation public.workspace_invitations;
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  if v_caller is null then raise exception 'Not authenticated'; end if;
  if not private.is_workspace_owner(p_workspace_id, v_caller) then
    raise exception 'Only the workspace owner can invite members';
  end if;
  if v_email = '' then raise exception 'Email is required'; end if;
  if p_role not in ('editor', 'viewer') then
    raise exception 'Role must be editor or viewer';
  end if;

  insert into public.workspace_invitations (
    id, workspace_id, email, role, invited_by_user_id, create_time
  )
  values (
    gen_random_uuid()::text,
    p_workspace_id,
    v_email,
    p_role,
    v_caller,
    v_now
  )
  on conflict (workspace_id, email) do update
    set role = excluded.role,
        invited_by_user_id = excluded.invited_by_user_id,
        create_time = excluded.create_time
  returning * into v_invitation;

  return v_invitation;
end $$;


ALTER FUNCTION "public"."invite_member_by_email"("p_workspace_id" "text", "p_email" "text", "p_role" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_my_pending_invitations"() RETURNS TABLE("id" "text", "workspace_id" "text", "workspace_name" "text", "email" "text", "role" "text", "invited_by_user_id" "text", "create_time" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select
    i.id,
    i.workspace_id,
    w.name as workspace_name,
    i.email,
    i.role,
    i.invited_by_user_id,
    i.create_time
  from public.workspace_invitations i
  join public.workspaces w on w.id = i.workspace_id
  where auth.email() is not null
    and lower(i.email) = lower(auth.email())
  order by i.create_time desc, i.id asc;
$$;


ALTER FUNCTION "public"."list_my_pending_invitations"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_workspace_members_with_emails"("p_workspace_id" "text") RETURNS TABLE("id" "text", "workspace_id" "text", "user_id" "text", "role" "text", "email" "text", "create_time" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select
    m.id,
    m.workspace_id,
    m.user_id,
    m.role,
    coalesce(u.email, '')::text as email,
    m.create_time
  from public.workspace_members m
  left join auth.users u on u.id::text = m.user_id
  where m.workspace_id = p_workspace_id
    and private.is_workspace_member(p_workspace_id, auth.uid()::text)
  order by m.create_time asc, m.id asc;
$$;


ALTER FUNCTION "public"."list_workspace_members_with_emails"("p_workspace_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."remove_workspace_member"("p_workspace_id" "text", "p_user_id" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_caller text := auth.uid()::text;
  v_is_owner boolean;
begin
  if v_caller is null then raise exception 'Not authenticated'; end if;

  v_is_owner := private.is_workspace_owner(p_workspace_id, v_caller);

  if not v_is_owner and p_user_id <> v_caller then
    raise exception 'Only the workspace owner or the target user can remove a member';
  end if;

  if exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace_id
      and user_id = p_user_id
      and role = 'owner'
  ) then
    raise exception 'Cannot remove the workspace owner; delete the workspace instead';
  end if;

  delete from public.workspace_members
  where workspace_id = p_workspace_id and user_id = p_user_id;
end $$;


ALTER FUNCTION "public"."remove_workspace_member"("p_workspace_id" "text", "p_user_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_workspace_member_role"("p_workspace_id" "text", "p_user_id" "text", "p_role" "text") RETURNS "public"."workspace_members"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_caller text := auth.uid()::text;
  v_member public.workspace_members;
begin
  if v_caller is null then raise exception 'Not authenticated'; end if;
  if not private.is_workspace_owner(p_workspace_id, v_caller) then
    raise exception 'Only the workspace owner can change roles';
  end if;
  if p_role not in ('owner', 'editor', 'viewer') then
    raise exception 'Invalid role: %', p_role;
  end if;

  if p_user_id = v_caller and p_role <> 'owner' then
    raise exception 'Owner cannot demote themselves';
  end if;

  update public.workspace_members
  set role = p_role
  where workspace_id = p_workspace_id and user_id = p_user_id
  returning * into v_member;

  if not found then
    raise exception 'Member not found';
  end if;

  return v_member;
end $$;


ALTER FUNCTION "public"."update_workspace_member_role"("p_workspace_id" "text", "p_user_id" "text", "p_role" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."blocks" (
    "id" "text" NOT NULL,
    "workspace_id" "text" NOT NULL,
    "parent_id" "text",
    "order_key" "text" NOT NULL,
    "content" "text" DEFAULT ''::"text" NOT NULL,
    "properties_json" "text" DEFAULT '{}'::"text" NOT NULL,
    "references_json" "text" DEFAULT '[]'::"text" NOT NULL,
    "created_at" bigint NOT NULL,
    "updated_at" bigint NOT NULL,
    "created_by" "text" NOT NULL,
    "updated_by" "text" NOT NULL,
    "deleted" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."blocks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workspaces" (
    "id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "owner_user_id" "text" NOT NULL,
    "create_time" bigint NOT NULL,
    "update_time" bigint NOT NULL
);


ALTER TABLE "public"."workspaces" OWNER TO "postgres";


ALTER TABLE ONLY "public"."blocks"
    ADD CONSTRAINT "blocks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."blocks"
    ADD CONSTRAINT "blocks_workspace_id_id_key" UNIQUE ("workspace_id", "id");



ALTER TABLE ONLY "public"."workspace_invitations"
    ADD CONSTRAINT "workspace_invitations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workspace_invitations"
    ADD CONSTRAINT "workspace_invitations_workspace_id_email_key" UNIQUE ("workspace_id", "email");



ALTER TABLE ONLY "public"."workspace_members"
    ADD CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workspace_members"
    ADD CONSTRAINT "workspace_members_workspace_id_user_id_key" UNIQUE ("workspace_id", "user_id");



ALTER TABLE ONLY "public"."workspaces"
    ADD CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_blocks_parent_order" ON "public"."blocks" USING "btree" ("parent_id", "order_key", "id") WHERE ("deleted" = false);



CREATE INDEX "idx_blocks_workspace_active" ON "public"."blocks" USING "btree" ("workspace_id") WHERE ("deleted" = false);



CREATE INDEX "idx_blocks_workspace_with_references" ON "public"."blocks" USING "btree" ("workspace_id") WHERE (("deleted" = false) AND ("references_json" <> '[]'::"text"));



CREATE INDEX "idx_workspace_invitations_email" ON "public"."workspace_invitations" USING "btree" ("email");



CREATE INDEX "idx_workspace_members_user_id" ON "public"."workspace_members" USING "btree" ("user_id");



CREATE OR REPLACE TRIGGER "blocks_clamp_updated_at_trg" BEFORE INSERT OR UPDATE ON "public"."blocks" FOR EACH ROW EXECUTE FUNCTION "public"."blocks_clamp_updated_at"();



CREATE OR REPLACE TRIGGER "blocks_prevent_workspace_change_trg" BEFORE UPDATE ON "public"."blocks" FOR EACH ROW EXECUTE FUNCTION "public"."blocks_prevent_workspace_change"();



ALTER TABLE ONLY "public"."blocks"
    ADD CONSTRAINT "blocks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."blocks"
    ADD CONSTRAINT "blocks_workspace_id_parent_id_fkey" FOREIGN KEY ("workspace_id", "parent_id") REFERENCES "public"."blocks"("workspace_id", "id") DEFERRABLE INITIALLY DEFERRED;



ALTER TABLE ONLY "public"."workspace_invitations"
    ADD CONSTRAINT "workspace_invitations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."workspace_members"
    ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE "public"."blocks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "blocks_read" ON "public"."blocks" FOR SELECT USING ("private"."is_workspace_member"("workspace_id", ("auth"."uid"())::"text"));



CREATE POLICY "blocks_write" ON "public"."blocks" USING ("private"."is_workspace_writer"("workspace_id", ("auth"."uid"())::"text")) WITH CHECK ("private"."is_workspace_writer"("workspace_id", ("auth"."uid"())::"text"));



ALTER TABLE "public"."workspace_invitations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "workspace_invitations_read_by_invitee" ON "public"."workspace_invitations" FOR SELECT USING ((("auth"."email"() IS NOT NULL) AND ("lower"("email") = "lower"("auth"."email"()))));



CREATE POLICY "workspace_invitations_read_by_owner" ON "public"."workspace_invitations" FOR SELECT USING ("private"."is_workspace_owner"("workspace_id", ("auth"."uid"())::"text"));



ALTER TABLE "public"."workspace_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "workspace_members_manage" ON "public"."workspace_members" USING ("private"."is_workspace_owner"("workspace_id", ("auth"."uid"())::"text")) WITH CHECK ("private"."is_workspace_owner"("workspace_id", ("auth"."uid"())::"text"));



CREATE POLICY "workspace_members_read" ON "public"."workspace_members" FOR SELECT USING ("private"."is_workspace_member"("workspace_id", ("auth"."uid"())::"text"));



ALTER TABLE "public"."workspaces" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "workspaces_delete" ON "public"."workspaces" FOR DELETE USING (("owner_user_id" = ("auth"."uid"())::"text"));



CREATE POLICY "workspaces_read" ON "public"."workspaces" FOR SELECT USING ("private"."is_workspace_member"("id", ("auth"."uid"())::"text"));



CREATE POLICY "workspaces_update" ON "public"."workspaces" FOR UPDATE USING ("private"."is_workspace_writer"("id", ("auth"."uid"())::"text")) WITH CHECK ("private"."is_workspace_writer"("id", ("auth"."uid"())::"text"));



CREATE PUBLICATION "powersync" WITH (publish = 'insert, update, delete, truncate');


ALTER PUBLICATION "powersync" OWNER TO "postgres";




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


ALTER PUBLICATION "powersync" ADD TABLE ONLY "public"."blocks";



ALTER PUBLICATION "powersync" ADD TABLE ONLY "public"."workspace_members";



ALTER PUBLICATION "powersync" ADD TABLE ONLY "public"."workspaces";



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "extensions"."armor"("bytea") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."armor"("bytea") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."armor"("bytea") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."armor"("bytea", "text"[], "text"[]) FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."armor"("bytea", "text"[], "text"[]) TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."armor"("bytea", "text"[], "text"[]) TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."crypt"("text", "text") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."crypt"("text", "text") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."crypt"("text", "text") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."dearmor"("text") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."dearmor"("text") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."dearmor"("text") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."decrypt"("bytea", "bytea", "text") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."decrypt"("bytea", "bytea", "text") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."decrypt"("bytea", "bytea", "text") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."decrypt_iv"("bytea", "bytea", "bytea", "text") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."decrypt_iv"("bytea", "bytea", "bytea", "text") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."decrypt_iv"("bytea", "bytea", "bytea", "text") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."digest"("bytea", "text") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."digest"("bytea", "text") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."digest"("bytea", "text") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."digest"("text", "text") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."digest"("text", "text") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."digest"("text", "text") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."encrypt"("bytea", "bytea", "text") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."encrypt"("bytea", "bytea", "text") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."encrypt"("bytea", "bytea", "text") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."encrypt_iv"("bytea", "bytea", "bytea", "text") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."encrypt_iv"("bytea", "bytea", "bytea", "text") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."encrypt_iv"("bytea", "bytea", "bytea", "text") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."gen_random_bytes"(integer) FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."gen_random_bytes"(integer) TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."gen_random_bytes"(integer) TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."gen_random_uuid"() FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."gen_random_uuid"() TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."gen_random_uuid"() TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."gen_salt"("text") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."gen_salt"("text") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."gen_salt"("text") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."gen_salt"("text", integer) FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."gen_salt"("text", integer) TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."gen_salt"("text", integer) TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."hmac"("bytea", "bytea", "text") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."hmac"("bytea", "bytea", "text") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."hmac"("bytea", "bytea", "text") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."hmac"("text", "text", "text") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."hmac"("text", "text", "text") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."hmac"("text", "text", "text") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."pg_stat_statements"("showtext" boolean, OUT "userid" "oid", OUT "dbid" "oid", OUT "toplevel" boolean, OUT "queryid" bigint, OUT "query" "text", OUT "plans" bigint, OUT "total_plan_time" double precision, OUT "min_plan_time" double precision, OUT "max_plan_time" double precision, OUT "mean_plan_time" double precision, OUT "stddev_plan_time" double precision, OUT "calls" bigint, OUT "total_exec_time" double precision, OUT "min_exec_time" double precision, OUT "max_exec_time" double precision, OUT "mean_exec_time" double precision, OUT "stddev_exec_time" double precision, OUT "rows" bigint, OUT "shared_blks_hit" bigint, OUT "shared_blks_read" bigint, OUT "shared_blks_dirtied" bigint, OUT "shared_blks_written" bigint, OUT "local_blks_hit" bigint, OUT "local_blks_read" bigint, OUT "local_blks_dirtied" bigint, OUT "local_blks_written" bigint, OUT "temp_blks_read" bigint, OUT "temp_blks_written" bigint, OUT "shared_blk_read_time" double precision, OUT "shared_blk_write_time" double precision, OUT "local_blk_read_time" double precision, OUT "local_blk_write_time" double precision, OUT "temp_blk_read_time" double precision, OUT "temp_blk_write_time" double precision, OUT "wal_records" bigint, OUT "wal_fpi" bigint, OUT "wal_bytes" numeric, OUT "jit_functions" bigint, OUT "jit_generation_time" double precision, OUT "jit_inlining_count" bigint, OUT "jit_inlining_time" double precision, OUT "jit_optimization_count" bigint, OUT "jit_optimization_time" double precision, OUT "jit_emission_count" bigint, OUT "jit_emission_time" double precision, OUT "jit_deform_count" bigint, OUT "jit_deform_time" double precision, OUT "stats_since" timestamp with time zone, OUT "minmax_stats_since" timestamp with time zone) FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."pg_stat_statements"("showtext" boolean, OUT "userid" "oid", OUT "dbid" "oid", OUT "toplevel" boolean, OUT "queryid" bigint, OUT "query" "text", OUT "plans" bigint, OUT "total_plan_time" double precision, OUT "min_plan_time" double precision, OUT "max_plan_time" double precision, OUT "mean_plan_time" double precision, OUT "stddev_plan_time" double precision, OUT "calls" bigint, OUT "total_exec_time" double precision, OUT "min_exec_time" double precision, OUT "max_exec_time" double precision, OUT "mean_exec_time" double precision, OUT "stddev_exec_time" double precision, OUT "rows" bigint, OUT "shared_blks_hit" bigint, OUT "shared_blks_read" bigint, OUT "shared_blks_dirtied" bigint, OUT "shared_blks_written" bigint, OUT "local_blks_hit" bigint, OUT "local_blks_read" bigint, OUT "local_blks_dirtied" bigint, OUT "local_blks_written" bigint, OUT "temp_blks_read" bigint, OUT "temp_blks_written" bigint, OUT "shared_blk_read_time" double precision, OUT "shared_blk_write_time" double precision, OUT "local_blk_read_time" double precision, OUT "local_blk_write_time" double precision, OUT "temp_blk_read_time" double precision, OUT "temp_blk_write_time" double precision, OUT "wal_records" bigint, OUT "wal_fpi" bigint, OUT "wal_bytes" numeric, OUT "jit_functions" bigint, OUT "jit_generation_time" double precision, OUT "jit_inlining_count" bigint, OUT "jit_inlining_time" double precision, OUT "jit_optimization_count" bigint, OUT "jit_optimization_time" double precision, OUT "jit_emission_count" bigint, OUT "jit_emission_time" double precision, OUT "jit_deform_count" bigint, OUT "jit_deform_time" double precision, OUT "stats_since" timestamp with time zone, OUT "minmax_stats_since" timestamp with time zone) TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."pg_stat_statements"("showtext" boolean, OUT "userid" "oid", OUT "dbid" "oid", OUT "toplevel" boolean, OUT "queryid" bigint, OUT "query" "text", OUT "plans" bigint, OUT "total_plan_time" double precision, OUT "min_plan_time" double precision, OUT "max_plan_time" double precision, OUT "mean_plan_time" double precision, OUT "stddev_plan_time" double precision, OUT "calls" bigint, OUT "total_exec_time" double precision, OUT "min_exec_time" double precision, OUT "max_exec_time" double precision, OUT "mean_exec_time" double precision, OUT "stddev_exec_time" double precision, OUT "rows" bigint, OUT "shared_blks_hit" bigint, OUT "shared_blks_read" bigint, OUT "shared_blks_dirtied" bigint, OUT "shared_blks_written" bigint, OUT "local_blks_hit" bigint, OUT "local_blks_read" bigint, OUT "local_blks_dirtied" bigint, OUT "local_blks_written" bigint, OUT "temp_blks_read" bigint, OUT "temp_blks_written" bigint, OUT "shared_blk_read_time" double precision, OUT "shared_blk_write_time" double precision, OUT "local_blk_read_time" double precision, OUT "local_blk_write_time" double precision, OUT "temp_blk_read_time" double precision, OUT "temp_blk_write_time" double precision, OUT "wal_records" bigint, OUT "wal_fpi" bigint, OUT "wal_bytes" numeric, OUT "jit_functions" bigint, OUT "jit_generation_time" double precision, OUT "jit_inlining_count" bigint, OUT "jit_inlining_time" double precision, OUT "jit_optimization_count" bigint, OUT "jit_optimization_time" double precision, OUT "jit_emission_count" bigint, OUT "jit_emission_time" double precision, OUT "jit_deform_count" bigint, OUT "jit_deform_time" double precision, OUT "stats_since" timestamp with time zone, OUT "minmax_stats_since" timestamp with time zone) TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."pg_stat_statements_info"(OUT "dealloc" bigint, OUT "stats_reset" timestamp with time zone) FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."pg_stat_statements_info"(OUT "dealloc" bigint, OUT "stats_reset" timestamp with time zone) TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."pg_stat_statements_info"(OUT "dealloc" bigint, OUT "stats_reset" timestamp with time zone) TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."pg_stat_statements_reset"("userid" "oid", "dbid" "oid", "queryid" bigint, "minmax_only" boolean) FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."pg_stat_statements_reset"("userid" "oid", "dbid" "oid", "queryid" bigint, "minmax_only" boolean) TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."pg_stat_statements_reset"("userid" "oid", "dbid" "oid", "queryid" bigint, "minmax_only" boolean) TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."pgp_armor_headers"("text", OUT "key" "text", OUT "value" "text") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."pgp_armor_headers"("text", OUT "key" "text", OUT "value" "text") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."pgp_armor_headers"("text", OUT "key" "text", OUT "value" "text") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."pgp_key_id"("bytea") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."pgp_key_id"("bytea") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."pgp_key_id"("bytea") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."pgp_pub_decrypt"("bytea", "bytea") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."pgp_pub_decrypt"("bytea", "bytea") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."pgp_pub_decrypt"("bytea", "bytea") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."pgp_pub_decrypt"("bytea", "bytea", "text") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."pgp_pub_decrypt"("bytea", "bytea", "text") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."pgp_pub_decrypt"("bytea", "bytea", "text") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."pgp_pub_decrypt"("bytea", "bytea", "text", "text") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."pgp_pub_decrypt"("bytea", "bytea", "text", "text") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."pgp_pub_decrypt"("bytea", "bytea", "text", "text") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."pgp_pub_decrypt_bytea"("bytea", "bytea") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."pgp_pub_decrypt_bytea"("bytea", "bytea") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."pgp_pub_decrypt_bytea"("bytea", "bytea") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."pgp_pub_decrypt_bytea"("bytea", "bytea", "text") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."pgp_pub_decrypt_bytea"("bytea", "bytea", "text") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."pgp_pub_decrypt_bytea"("bytea", "bytea", "text") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."pgp_pub_decrypt_bytea"("bytea", "bytea", "text", "text") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."pgp_pub_decrypt_bytea"("bytea", "bytea", "text", "text") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."pgp_pub_decrypt_bytea"("bytea", "bytea", "text", "text") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."pgp_pub_encrypt"("text", "bytea") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."pgp_pub_encrypt"("text", "bytea") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."pgp_pub_encrypt"("text", "bytea") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."pgp_pub_encrypt"("text", "bytea", "text") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."pgp_pub_encrypt"("text", "bytea", "text") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."pgp_pub_encrypt"("text", "bytea", "text") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."pgp_pub_encrypt_bytea"("bytea", "bytea") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."pgp_pub_encrypt_bytea"("bytea", "bytea") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."pgp_pub_encrypt_bytea"("bytea", "bytea") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."pgp_pub_encrypt_bytea"("bytea", "bytea", "text") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."pgp_pub_encrypt_bytea"("bytea", "bytea", "text") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."pgp_pub_encrypt_bytea"("bytea", "bytea", "text") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."pgp_sym_decrypt"("bytea", "text") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."pgp_sym_decrypt"("bytea", "text") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."pgp_sym_decrypt"("bytea", "text") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."pgp_sym_decrypt"("bytea", "text", "text") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."pgp_sym_decrypt"("bytea", "text", "text") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."pgp_sym_decrypt"("bytea", "text", "text") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."pgp_sym_decrypt_bytea"("bytea", "text") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."pgp_sym_decrypt_bytea"("bytea", "text") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."pgp_sym_decrypt_bytea"("bytea", "text") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."pgp_sym_decrypt_bytea"("bytea", "text", "text") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."pgp_sym_decrypt_bytea"("bytea", "text", "text") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."pgp_sym_decrypt_bytea"("bytea", "text", "text") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."pgp_sym_encrypt"("text", "text") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."pgp_sym_encrypt"("text", "text") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."pgp_sym_encrypt"("text", "text") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."pgp_sym_encrypt"("text", "text", "text") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."pgp_sym_encrypt"("text", "text", "text") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."pgp_sym_encrypt"("text", "text", "text") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."pgp_sym_encrypt_bytea"("bytea", "text") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."pgp_sym_encrypt_bytea"("bytea", "text") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."pgp_sym_encrypt_bytea"("bytea", "text") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."pgp_sym_encrypt_bytea"("bytea", "text", "text") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."pgp_sym_encrypt_bytea"("bytea", "text", "text") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."pgp_sym_encrypt_bytea"("bytea", "text", "text") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."uuid_generate_v1"() FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."uuid_generate_v1"() TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."uuid_generate_v1"() TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."uuid_generate_v1mc"() FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."uuid_generate_v1mc"() TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."uuid_generate_v1mc"() TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."uuid_generate_v3"("namespace" "uuid", "name" "text") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."uuid_generate_v3"("namespace" "uuid", "name" "text") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."uuid_generate_v3"("namespace" "uuid", "name" "text") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."uuid_generate_v4"() FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."uuid_generate_v4"() TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."uuid_generate_v4"() TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."uuid_generate_v5"("namespace" "uuid", "name" "text") FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."uuid_generate_v5"("namespace" "uuid", "name" "text") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."uuid_generate_v5"("namespace" "uuid", "name" "text") TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."uuid_nil"() FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."uuid_nil"() TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."uuid_nil"() TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."uuid_ns_dns"() FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."uuid_ns_dns"() TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."uuid_ns_dns"() TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."uuid_ns_oid"() FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."uuid_ns_oid"() TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."uuid_ns_oid"() TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."uuid_ns_url"() FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."uuid_ns_url"() TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."uuid_ns_url"() TO "dashboard_user";



REVOKE ALL ON FUNCTION "extensions"."uuid_ns_x500"() FROM "postgres";
GRANT ALL ON FUNCTION "extensions"."uuid_ns_x500"() TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."uuid_ns_x500"() TO "dashboard_user";



GRANT ALL ON TABLE "public"."workspace_members" TO "anon";
GRANT ALL ON TABLE "public"."workspace_members" TO "authenticated";
GRANT ALL ON TABLE "public"."workspace_members" TO "service_role";



GRANT ALL ON FUNCTION "public"."accept_invitation"("p_invitation_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."accept_invitation"("p_invitation_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."accept_invitation"("p_invitation_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."blocks_clamp_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."blocks_clamp_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."blocks_clamp_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."blocks_prevent_workspace_change"() TO "anon";
GRANT ALL ON FUNCTION "public"."blocks_prevent_workspace_change"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."blocks_prevent_workspace_change"() TO "service_role";



GRANT ALL ON FUNCTION "public"."create_workspace"("p_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."create_workspace"("p_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_workspace"("p_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."decline_invitation"("p_invitation_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."decline_invitation"("p_invitation_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."decline_invitation"("p_invitation_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."delete_workspace"("p_workspace_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."delete_workspace"("p_workspace_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_workspace"("p_workspace_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."ensure_personal_workspace"() TO "anon";
GRANT ALL ON FUNCTION "public"."ensure_personal_workspace"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."ensure_personal_workspace"() TO "service_role";



GRANT ALL ON TABLE "public"."workspace_invitations" TO "anon";
GRANT ALL ON TABLE "public"."workspace_invitations" TO "authenticated";
GRANT ALL ON TABLE "public"."workspace_invitations" TO "service_role";



GRANT ALL ON FUNCTION "public"."invite_member_by_email"("p_workspace_id" "text", "p_email" "text", "p_role" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."invite_member_by_email"("p_workspace_id" "text", "p_email" "text", "p_role" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."invite_member_by_email"("p_workspace_id" "text", "p_email" "text", "p_role" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."list_my_pending_invitations"() TO "anon";
GRANT ALL ON FUNCTION "public"."list_my_pending_invitations"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."list_my_pending_invitations"() TO "service_role";



GRANT ALL ON FUNCTION "public"."list_workspace_members_with_emails"("p_workspace_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."list_workspace_members_with_emails"("p_workspace_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."list_workspace_members_with_emails"("p_workspace_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."remove_workspace_member"("p_workspace_id" "text", "p_user_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."remove_workspace_member"("p_workspace_id" "text", "p_user_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."remove_workspace_member"("p_workspace_id" "text", "p_user_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."update_workspace_member_role"("p_workspace_id" "text", "p_user_id" "text", "p_role" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."update_workspace_member_role"("p_workspace_id" "text", "p_user_id" "text", "p_role" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_workspace_member_role"("p_workspace_id" "text", "p_user_id" "text", "p_role" "text") TO "service_role";



GRANT ALL ON FUNCTION "vault"."_crypto_aead_det_decrypt"("message" "bytea", "additional" "bytea", "key_id" bigint, "context" "bytea", "nonce" "bytea") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "vault"."_crypto_aead_det_decrypt"("message" "bytea", "additional" "bytea", "key_id" bigint, "context" "bytea", "nonce" "bytea") TO "service_role";



GRANT ALL ON FUNCTION "vault"."create_secret"("new_secret" "text", "new_name" "text", "new_description" "text", "new_key_id" "uuid") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "vault"."create_secret"("new_secret" "text", "new_name" "text", "new_description" "text", "new_key_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "vault"."update_secret"("secret_id" "uuid", "new_secret" "text", "new_name" "text", "new_description" "text", "new_key_id" "uuid") TO "postgres" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "vault"."update_secret"("secret_id" "uuid", "new_secret" "text", "new_name" "text", "new_description" "text", "new_key_id" "uuid") TO "service_role";



REVOKE ALL ON TABLE "extensions"."pg_stat_statements" FROM "postgres";
GRANT ALL ON TABLE "extensions"."pg_stat_statements" TO "postgres" WITH GRANT OPTION;
GRANT ALL ON TABLE "extensions"."pg_stat_statements" TO "dashboard_user";



REVOKE ALL ON TABLE "extensions"."pg_stat_statements_info" FROM "postgres";
GRANT ALL ON TABLE "extensions"."pg_stat_statements_info" TO "postgres" WITH GRANT OPTION;
GRANT ALL ON TABLE "extensions"."pg_stat_statements_info" TO "dashboard_user";



GRANT ALL ON TABLE "public"."blocks" TO "anon";
GRANT ALL ON TABLE "public"."blocks" TO "authenticated";
GRANT ALL ON TABLE "public"."blocks" TO "service_role";



GRANT ALL ON TABLE "public"."workspaces" TO "anon";
GRANT ALL ON TABLE "public"."workspaces" TO "authenticated";
GRANT ALL ON TABLE "public"."workspaces" TO "service_role";



GRANT UPDATE("name") ON TABLE "public"."workspaces" TO "authenticated";



GRANT UPDATE("update_time") ON TABLE "public"."workspaces" TO "authenticated";



GRANT SELECT,REFERENCES,DELETE,TRUNCATE ON TABLE "vault"."secrets" TO "postgres" WITH GRANT OPTION;
GRANT SELECT,DELETE ON TABLE "vault"."secrets" TO "service_role";



GRANT SELECT,REFERENCES,DELETE,TRUNCATE ON TABLE "vault"."decrypted_secrets" TO "postgres" WITH GRANT OPTION;
GRANT SELECT,DELETE ON TABLE "vault"."decrypted_secrets" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































