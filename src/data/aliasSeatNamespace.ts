/**
 * The UUIDv5 namespace a workspace's alias seats are derived under (#719).
 *
 * A seat's id hashes the alias TEXT (`computeAliasSeatId`), and block ids sync
 * in plaintext, so under a public namespace a server can hash a guessed page
 * name and probe an encrypted workspace for it — the oracle stated at
 * {@link deriveWorkspaceIdNamespace}. A workspace whose rows leave this device
 * sealed therefore mints under a namespace derived from its `K_id`; one whose
 * rows leave as plaintext keeps the public constant, which says nothing the
 * row's own content does not.
 *
 * "Sealed" is the upload path's answer ({@link uploadModeFor}): anything but
 * `none`. Not a policy of its own, because the two disagreeing IS the leak — a
 * seat minted public while its row is held for sealing names its page.
 *
 * Two entry points, because `K_id` lives in IndexedDB, which is never opened
 * under the SQLite write lock (a wedged store would hold the app's single
 * writer — see `applyPropertyDefinitionSynthesis`):
 *  - {@link resolveAliasSeatNamespaces}, PRE-LOCK, reads the key store on a
 *    cache miss and caches the derived namespace;
 *  - {@link aliasSeatNamespacesInTx}, IN-LOCK, re-reads the MODE through the
 *    transaction and serves a sealed answer from that cache only.
 * `bootstrapWorkspace` resolves the active workspace before its first write, so
 * the in-lock seat writers of an open workspace find the cache warm.
 *
 * A sealed workspace this device holds no `K_id` for gets NO namespace: both
 * entry points throw rather than fall back to the public one.
 *
 * Seats already minted under the public namespace — before #719, or before an
 * in-place conversion — keep their ids (#1297 re-ids them). They stay
 * RECOGNIZED as seats; nothing mints or restores at them. A `[[name]]` still
 * binds to such a page, because a page is found by its alias, never by
 * recomputing its id (`ensureAliasTarget`).
 */

import type { Tx } from '@/data/api'
import type { Repo } from '@/data/repo'
import { readWorkspaceEncryptionMode } from '@/data/workspaceSchema'
import { deriveWorkspaceIdNamespace } from '@/sync/crypto/derivedIdNamespace'
import { getWorkspaceKeyStore, keyStoreRecordId } from '@/sync/keys/keyStore'
import { getModePin } from '@/sync/keys/modePin'
import { readContentKeyHmac, uploadModeFor } from '@/sync/keys/resolver'

export interface AliasSeatNamespaces {
  /** Where a seat is minted or restored. */
  readonly mint: string
  /** Every namespace a seat of this workspace may already sit under, `mint`
   *  first — for recognizing a seat, never for writing one. */
  readonly recognized: readonly string[]
}

const PUBLIC_ALIAS_SEAT_NS = 'a3c8a8c0-7c3a-4d2c-bc4f-1f6c2c6a7d11'

/** Versioned: a new label re-points every new seat and leaves the old ones
 *  unrecognized as seats. */
const ALIAS_SEAT_NS_LABEL = 'km/alias-seat-ns/v1'

/** A plaintext workspace's answer. Production code asks the two resolvers
 *  below; this is exported for tests of plaintext workspaces. */
export const PLAINTEXT_ALIAS_SEATS: AliasSeatNamespaces = Object.freeze({
  mint: PUBLIC_ALIAS_SEAT_NS,
  recognized: Object.freeze([PUBLIC_ALIAS_SEAT_NS]),
})

const sealedAliasSeats = (derived: string): AliasSeatNamespaces => ({
  mint: derived,
  recognized: [derived, PUBLIC_ALIAS_SEAT_NS],
})

/** Derived namespaces by (user, workspace). Only a SEALED answer is cached, so
 *  a workspace converted in place stops getting the public namespace at its
 *  next call; and a cached one cannot go stale while `K_id` is fixed — until WK
 *  rotation exists, which must drop the entry. */
const derivedNamespaces = new Map<string, string>()

const isPlaintext = async (
  userId: string,
  workspaceId: string,
  readEncryptionMode: () => Promise<string | null>,
): Promise<boolean> =>
  (await uploadModeFor(getModePin(userId, workspaceId), readEncryptionMode)) === 'none'

/** PRE-LOCK: the namespaces for `workspaceId`'s seats, deriving and caching a
 *  sealed workspace's on first use. */
export const resolveAliasSeatNamespaces = async (
  repo: Repo,
  workspaceId: string,
): Promise<AliasSeatNamespaces> => {
  const userId = repo.user.id
  if (await isPlaintext(userId, workspaceId, () => readWorkspaceEncryptionMode(repo.db, workspaceId))) {
    return PLAINTEXT_ALIAS_SEATS
  }
  const cacheKey = keyStoreRecordId(userId, workspaceId)
  let derived = derivedNamespaces.get(cacheKey)
  if (derived === undefined) {
    const contentKeyHmac = await readContentKeyHmac(getWorkspaceKeyStore(), userId, workspaceId)
    if (contentKeyHmac === null) {
      throw new Error(
        `alias seats: this device holds no content key for encrypted workspace ${workspaceId}, ` +
        'so a page it created would get an id that names it — unlock the workspace first')
    }
    derived = await deriveWorkspaceIdNamespace(contentKeyHmac, ALIAS_SEAT_NS_LABEL)
    derivedNamespaces.set(cacheKey, derived)
  }
  return sealedAliasSeats(derived)
}

/** IN-LOCK: the namespaces for `workspaceId`'s seats, with the mode read
 *  through `tx` immediately before the caller writes. */
export const aliasSeatNamespacesInTx = async (
  tx: Tx,
  repo: Repo,
  workspaceId: string,
): Promise<AliasSeatNamespaces> => {
  const userId = repo.user.id
  if (await isPlaintext(userId, workspaceId, () => tx.workspaceEncryptionMode(workspaceId))) {
    return PLAINTEXT_ALIAS_SEATS
  }
  const derived = derivedNamespaces.get(keyStoreRecordId(userId, workspaceId))
  if (derived === undefined) {
    throw new Error(
      `alias seats: encrypted workspace ${workspaceId} has no namespace resolved before the write ` +
      'lock — call resolveAliasSeatNamespaces before opening the transaction')
  }
  return sealedAliasSeats(derived)
}
