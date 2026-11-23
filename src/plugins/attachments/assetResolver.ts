/** The live renderer uses an ambient resolver that follows the active account.
 *  Background work uses the resolver for the account it started with. */

import {
  getActiveSyncResolver,
  getActiveUserId,
} from '@/data/repoProvider.js'
import { buildBlobStore, getMediaLanesForUser } from './browserMedia.js'
import { getByteStore } from './byteStore.js'
import { createAssetResolver, type AssetResolver } from './resolver.js'

let singleton: AssetResolver | null = null

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

/** The per-user and ambient resolvers coalesce separately, so an account switch can cost a duplicate fetch. */
export const getAssetResolverForUser = (userId: string): AssetResolver =>
  getMediaLanesForUser(userId).resolver
