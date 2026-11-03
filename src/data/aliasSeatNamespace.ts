/**
 * The UUIDv5 namespace a workspace's alias seats are derived under (#719).
 *
 * A seat's id hashes the alias text, so a public namespace is the page-name
 * oracle described at {@link deriveWorkspaceIdNamespace}. A workspace is
 * SEALED unless its rows upload as plaintext ({@link uploadModeFor}) — one rule
 * with the upload path, because a public seat id on a sealed row is the leak.
 * Sealed mints under HMAC(`K_id`); plaintext keeps the public constant. Without
 * `K_id` there is no namespace: nothing falls back to the public one, and the
 * key read reports the workspace locked (`requireWorkspaceKeys`).
 *
 * `K_id` is in IndexedDB, which is never opened under the SQLite write lock:
 *  - {@link resolveAliasSeatNamespaces} (pre-lock) reads it and caches the
 *    derived namespace;
 *  - {@link aliasSeatNamespacesInTx} (in-lock) re-reads the mode through the
 *    transaction and serves a sealed answer from that cache only.
 * `bootstrapWorkspace` starts the resolve for the workspace it opens.
 *
 * Seats minted under the public namespace earlier keep their ids (#1297) and
 * stay recognized as seats; nothing mints or restores at them. A `[[name]]`
 * binds to one this device holds, by alias lookup. ACCEPTED: one it has not
 * downloaded yet gets a second page at the derived id — the old page is not on
 * this device to find — and #1297's re-id onto the derived slot ids converges
 * the two.
 */

import type { Tx } from '@/data/api'
import type { Repo } from '@/data/repo'
import { readWorkspaceEncryptionMode } from '@/data/workspaceSchema'
import { deriveWorkspaceIdNamespace } from '@/sync/crypto/derivedIdNamespace'
import { getWorkspaceKeyStore, keyStoreRecordId } from '@/sync/keys/keyStore'
import { getModePin } from '@/sync/keys/modePin'
import { requireWorkspaceKeys } from '@/sync/keys/openWorkspaceKeys'
import { uploadModeFor } from '@/sync/keys/resolver'

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

/** A plaintext workspace's answer. Not exported: a caller holding it would
 *  not have asked whether the workspace is plaintext. */
const PLAINTEXT_ALIAS_SEATS: AliasSeatNamespaces = Object.freeze({
  mint: PUBLIC_ALIAS_SEAT_NS,
  recognized: Object.freeze([PUBLIC_ALIAS_SEAT_NS]),
})

/** A sealed workspace's namespace was not resolved before the write lock. A
 *  caller that can leave the seat out — a derived reference — catches this;
 *  none may fall back to the public namespace. */
export class AliasSeatNamespaceUnavailableError extends Error {}

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
 *  sealed workspace's on first use. Throws `WorkspaceKeyUnavailableError` when
 *  that needs a key this device does not hold. */
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
    const {contentKeyHmac} = await requireWorkspaceKeys(getWorkspaceKeyStore(), userId, workspaceId)
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
    throw new AliasSeatNamespaceUnavailableError(
      `alias seats: encrypted workspace ${workspaceId} has no namespace resolved before the write ` +
      'lock — call resolveAliasSeatNamespaces before opening the transaction')
  }
  return sealedAliasSeats(derived)
}
