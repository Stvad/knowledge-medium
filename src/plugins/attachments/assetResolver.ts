/**
 * The app-wired in-thread asset resolver(s) (design §7.3).
 *
 * Wires the pure {@link createAssetResolver} to the real app deps:
 *   - byteStore  — the OPFS byte store (§8), one per origin.
 *   - blobStore  — Supabase Storage, authed by the app's own session.
 *   - sync deps  — a §6 resolver (materializability / WK / K_id), re-read per
 *                  call so a key/mode change is reflected without rebuilding.
 *   - getUserId  — the byte store's isolation scope (§7).
 *
 * Two flavors, built lazily:
 *   - {@link getAssetResolver} — the ONE ambient singleton the live demand-render
 *     path uses (`resolve`, via MediaBlockRenderer.tsx): every dep tracks whoever
 *     is currently ACTIVE, so a rendered asset always reflects the signed-in
 *     account, by design.
 *   - {@link getAssetResolverForUser} — a resolver pinned to ONE user, for a
 *     background pass that must not drift with an ambient account switch (the
 *     down-lane; see its doc comment + assetDownLane.ts).
 *
 * When Supabase isn't configured (a local-only / unauthed build) there's no
 * REMOTE object store — but a locally-captured paste still wrote its plaintext
 * to the OPFS byte store, so we still build the NORMAL resolver, just with a
 * blob store whose remote `get` always misses ({@link NO_REMOTE_BLOB_STORE}).
 * The resolver checks the local byte store first (§7.3), so a local-only paste
 * renders from disk; only a genuine remote miss fails closed (placeholder).
 */

import {
  getActiveSyncResolver,
  getActiveUserId,
  isRemoteSyncActive,
  syncResolverForUser,
} from '@/data/repoProvider.js'
import { supabase } from '@/services/supabase.js'
import { BlobPutError, createSupabaseBlobStore, type BlobStore } from './blobStore.js'
import { getByteStore } from './byteStore.js'
import { createAssetResolver, type AssetResolver } from './resolver.js'

let singleton: AssetResolver | null = null

/** A blob store for a build with no remote object store (local-only / unauthed):
 *  `get` always misses, so the resolver serves LOCAL byte-store hits and fails
 *  closed (`fetch-failed`) only on a true miss. `put`/`delete` are never reached
 *  via the resolver (the up-lane has its own blob store) but are total for safety. */
export const NO_REMOTE_BLOB_STORE: BlobStore = {
  put: async () => {
    throw new BlobPutError('no remote object store configured', false, undefined, 'no_remote')
  },
  get: async () => {
    throw new Error('no remote object store configured')
  },
  // Throw (not a 404-null) so the §9 recovery probe treats local-only as TRANSIENT and
  // DEFERS — never mistaking "no remote configured" for "path free" and re-driving an
  // upload there's nowhere to send. (Recovery is gated off in local-only anyway; this
  // only covers a mode flip mid-lane.)
  probe: async () => {
    throw new Error('no remote object store configured')
  },
  delete: async () => {},
}

/** Wrap the remote blob store so it's consulted ONLY while the active session has
 *  remote sync on; in local-only mode it behaves as {@link NO_REMOTE_BLOB_STORE} (a
 *  remote miss), so the resolver still serves local OPFS hits but never makes a
 *  Supabase request — the read-side half of the "no remote requests in local-only"
 *  contract (Codex P1). Checked PER CALL, so a re-login mode switch is respected
 *  without rebuilding the singleton. Shared with the up-lane (assetUpload's
 *  getBlobStore) so the WRITE side gets the same per-call gate: an arm-time-only
 *  check can go stale if remote sync is toggled off while a drain lock is held. */
export const remoteSyncGated = (remote: BlobStore): BlobStore => ({
  put: (ws, key, bytes) => (isRemoteSyncActive() ? remote : NO_REMOTE_BLOB_STORE).put(ws, key, bytes),
  get: (ws, key) => (isRemoteSyncActive() ? remote : NO_REMOTE_BLOB_STORE).get(ws, key),
  probe: (ws, key) => (isRemoteSyncActive() ? remote : NO_REMOTE_BLOB_STORE).probe(ws, key),
  delete: (ws, key) => (isRemoteSyncActive() ? remote : NO_REMOTE_BLOB_STORE).delete(ws, key),
})

/** The blob store half of a resolver's deps — identical construction for the
 *  ambient singleton and every per-user resolver below, so they don't drift.
 *  Cheap to rebuild (the Supabase wrapper is stateless — every op rides the
 *  client's own session), so callers that need a fresh one (the per-user path)
 *  just call this again rather than caching. */
const buildBlobStore = (): BlobStore => {
  if (!supabase) return NO_REMOTE_BLOB_STORE
  const client = supabase
  return remoteSyncGated(
    createSupabaseBlobStore({
      // Presence probe only — the upload/download ride the client's own session.
      client,
      getAccessToken: async () => (await client.auth.getSession()).data.session?.access_token ?? null,
    }),
  )
}

export const getAssetResolver = (): AssetResolver => {
  if (singleton) return singleton
  singleton = createAssetResolver({
    getUserId: getActiveUserId,
    byteStore: getByteStore(),
    blobStore: buildBlobStore(),
    // Delegate the three-valued decode + key decisions to the active user's §6
    // resolver; signed out → fail closed (defer / no key).
    getMaterializability: (ws) => getActiveSyncResolver()?.getMaterializability(ws) ?? 'defer',
    getCek: (ws) => getActiveSyncResolver()?.getCek(ws) ?? Promise.resolve(null),
    getContentKeyHmac: (ws) => getActiveSyncResolver()?.getContentKeyHmac(ws) ?? Promise.resolve(null),
  })
  return singleton
}

// One resolver per user, built lazily — the down-lane's per-(user,workspace) pass
// binding (see assetDownLane.ts's `getAssetResolverForUser` use). Separate from
// `singleton` above, which is deliberately AMBIENT (tracks whoever is currently
// active, for the live demand-render path — see repoProvider.ts's
// `syncResolverForUser` doc comment for why that split is intentional).
const resolversByUser = new Map<string, AssetResolver>()

/**
 * A resolver bound to ONE user for the lifetime of a background pass, instead of
 * the ambient active account. Fixes a review finding (PR #424 P2): the down-lane
 * pass reads `repo.user.id` ONCE at its boundary (see assetDownLane.ts) for its
 * lock name and its one-shot OPFS presence enumeration, but used to hand that
 * work to {@link getAssetResolver}'s singleton, whose `getUserId` — and its §6
 * materializability/CEK/K_id lookups — re-read the AMBIENT active user on every
 * call. If the active account switches WHILE a pass is still in flight, the
 * presence set (enumerated under the old user) and `replicate()`'s own
 * resolve/store (now running under the new ambient user) mix two users' scope in
 * one pass — e.g. a stale `present` entry that happens to share a content-key
 * with the new user's absent asset would wrongly report it "present" and skip
 * storing it. Every user-scoped read here — `getUserId` AND the §6 resolver — is
 * therefore pinned to `userId` via {@link syncResolverForUser} (never null,
 * unlike the ambient {@link getActiveSyncResolver}), mirroring assetUpload.ts's
 * `laneKeyDeps` binding for the up-lane.
 *
 * Cached per user (not a single ambient singleton) so repeated down-lane sweeps
 * for the SAME user still coalesce concurrent replicate/resolve calls with each
 * other. It does NOT share `getAssetResolver()`'s in-flight coalescing map, so a
 * down-lane replicate and a live demand resolve of the same asset can, only in
 * the narrow window of an in-progress account switch, run a redundant fetch
 * instead of sharing one — an acceptable cost next to mixing two users' scope.
 */
export const getAssetResolverForUser = (userId: string): AssetResolver => {
  const cached = resolversByUser.get(userId)
  if (cached) return cached
  const userResolver = syncResolverForUser(userId)
  const resolver = createAssetResolver({
    getUserId: () => userId,
    byteStore: getByteStore(),
    blobStore: buildBlobStore(),
    getMaterializability: userResolver.getMaterializability,
    getCek: userResolver.getCek,
    getContentKeyHmac: userResolver.getContentKeyHmac,
  })
  resolversByUser.set(userId, resolver)
  return resolver
}
