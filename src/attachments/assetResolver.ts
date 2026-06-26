/**
 * The app-wired in-thread asset resolver singleton (design §7.3).
 *
 * Wires the pure {@link createAssetResolver} to the real app deps:
 *   - byteStore  — the OPFS byte store (§8), one per origin.
 *   - blobStore  — Supabase Storage, authed by the app's own session.
 *   - sync deps  — the ACTIVE user's §6 resolver (materializability / WK / K_id),
 *                  re-read per call so an account switch is reflected without
 *                  rebuilding the singleton.
 *   - getUserId  — the active account, the byte store's isolation scope (§7).
 *
 * Built once, lazily. When Supabase isn't configured (a local-only / unauthed
 * build) there's no object store to fetch from, so the resolver always fails
 * closed — the renderer shows the placeholder, never a broken fetch.
 */

import { getActiveSyncResolver, getActiveUserId } from '@/data/repoProvider.js'
import { supabase } from '@/services/supabase.js'
import { createSupabaseBlobStore } from './blobStore.js'
import { createByteStore } from './byteStore.js'
import { createAssetResolver, type AssetResolver } from './resolver.js'

let singleton: AssetResolver | null = null

export const getAssetResolver = (): AssetResolver => {
  if (singleton) return singleton

  if (!supabase) {
    // No object store reachable — every resolve fails closed (placeholder).
    singleton = { resolve: async () => ({ ok: false, reason: 'error' }) }
    return singleton
  }
  const client = supabase

  singleton = createAssetResolver({
    getUserId: getActiveUserId,
    byteStore: createByteStore(),
    blobStore: createSupabaseBlobStore({
      client,
      // Presence probe only — the upload/download ride the client's own session.
      getAccessToken: async () => (await client.auth.getSession()).data.session?.access_token ?? null,
    }),
    // Delegate the three-valued decode + key decisions to the active user's §6
    // resolver; signed out → fail closed (defer / no key).
    getMaterializability: (ws) => getActiveSyncResolver()?.getMaterializability(ws) ?? 'defer',
    getCek: (ws) => getActiveSyncResolver()?.getCek(ws) ?? Promise.resolve(null),
    getContentKeyHmac: (ws) => getActiveSyncResolver()?.getContentKeyHmac(ws) ?? Promise.resolve(null),
  })
  return singleton
}
