/**
 * The byte store's boot-time repair: once per (user, workspace) per page, reap
 * the EMPTY entries an older build left behind (a `put` that minted the file and
 * then failed to write it — WebKit before Safari 26, see byteStore.ts). Until
 * they are gone the down-lane's presence scan counts them as replicated and
 * never re-fetches them; the resolver already refuses to serve them, so this is
 * what turns "broken until re-opened" into "healed in the background".
 *
 * Cheap and idempotent: one directory listing plus a size read per entry, only
 * for the workspace the user has open (a cold workspace heals when opened),
 * never more than once per page. Runs where the down-lane runs — off the
 * cold-start path, in deep idle (MediaDownLaneReplicator) — and BEFORE that
 * pass, so the same tick's presence scan already sees the repaired tree.
 */

import type { ByteStore } from './byteStore.js'

/** An empty entry younger than this may be a `put` still in flight (the entry is
 *  minted before the bytes land) — it is left for the next page's sweep. */
export const EMPTY_ENTRY_MIN_AGE_MS = 60_000

const sweptThisPage = new Set<string>()

export const repairByteStoreOnce = async (
  byteStore: ByteStore,
  userId: string,
  workspaceId: string,
): Promise<void> => {
  const key = `${userId}\n${workspaceId}`
  if (sweptThisPage.has(key)) return
  sweptThisPage.add(key)
  try {
    const { scanned, removed } = await byteStore.sweepEmpty(userId, workspaceId, { minAgeMs: EMPTY_ENTRY_MIN_AGE_MS })
    if (removed > 0) {
      console.warn(`[media] removed ${removed} empty local asset file(s) left by failed writes (${scanned} scanned)`)
    }
  } catch (err) {
    // A failed sweep is a missed repair, not a broken lane: the resolver still refuses
    // the empty entries, and the next page load sweeps again.
    sweptThisPage.delete(key)
    console.warn(`[media] byte-store repair sweep failed for ${workspaceId}`, err)
  }
}

/** Test seam: forget which (user, workspace) pairs this page already swept. */
export const resetByteStoreRepairForTests = (): void => sweptThisPage.clear()
