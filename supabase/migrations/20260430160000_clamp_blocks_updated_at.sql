-- Clamp `blocks.updated_at` to the server's current time on insert / update.
-- Companion to client-side LWW (BlockCache.applySyncSnapshot): the cache
-- rejects sync-arriving snapshots whose `updated_at` is older than what's
-- locally cached. Without a server-side ceiling, a future-dated client
-- write (broken NTP, manual clock change, malicious user) could install an
-- `updated_at` arbitrarily far in the future and block every subsequent
-- legitimate write from being accepted by other clients' caches until wall
-- time catches up.
--
-- The trigger only enforces the ceiling — past-dated writes still flow
-- through unchanged, which is what we want (a client with a slow clock
-- loses to a client with a correct clock under LWW; that's the design).
--
-- Server time is the implicit authority here. Client clocks remain the
-- coordination signal for the common case; this trigger is a defense-in-
-- depth against the worst skew direction (future).

create or replace function public.blocks_clamp_updated_at()
returns trigger
language plpgsql
as $$
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

create trigger blocks_clamp_updated_at_trg
  before insert or update on public.blocks
  for each row execute function public.blocks_clamp_updated_at();
