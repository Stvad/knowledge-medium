-- Refuse every write to `blocks` made as `anon`, with PT401.
--
-- No anon write to `blocks` can succeed, because both policies key off
-- `auth.uid()`. Yet `anon` can reach the table (PUBLIC and Supabase's default
-- grants, SECURITY INVOKER upload RPCs), and a client whose session refresh
-- failed sends its uploads with the anon key. RLS then hides every row, so the
-- outcome reads as a permanent data error: P0002 from `apply_block_patches`,
-- 42501 from `apply_block_creates`, a DELETE that silently matches nothing.
-- The uploader quarantines the valid write. PT401 makes PostgREST answer HTTP
-- 401, which the uploader retries.
--
-- FOR EACH STATEMENT, so it fires even when RLS leaves no row to touch, and it
-- covers every write path without living in RPC bodies a later migration may
-- re-copy.
-- Checks the role, not `auth.uid() IS NULL`: superuser and service-role
-- callers have no user id and must keep working.
-- Not REVOKE EXECUTE on the RPCs: the call would then fail with 42501, which
-- is also quarantined.

CREATE OR REPLACE FUNCTION public.blocks_refuse_anon()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = ''
    AS $$
BEGIN
    RAISE EXCEPTION 'blocks: no authenticated user (anon role)'
        USING ERRCODE = 'PT401';
END;
$$;

CREATE TRIGGER blocks_refuse_anon_trg
    BEFORE INSERT OR UPDATE OR DELETE ON public.blocks
    FOR EACH STATEMENT
    WHEN (current_user = 'anon')
    EXECUTE FUNCTION public.blocks_refuse_anon();
