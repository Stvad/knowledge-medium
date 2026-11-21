/**
 * The UUIDv5 namespace one derived-id KIND mints under, for one workspace.
 *
 * Block ids sync in plaintext, so a derived id under a public namespace lets
 * the server recompute it from facts it can guess or already sees — the oracle
 * described at {@link deriveWorkspaceIdNamespace}. A workspace is SEALED unless
 * its rows upload as plaintext ({@link uploadModeFor}) — one rule with the
 * upload path, because a public id on a sealed row is the leak. Sealed mints
 * under HMAC(`K_id`, kind label); plaintext keeps the kind's public constant.
 * Without `K_id` there is no namespace: nothing falls back to the public one,
 * and the key read reports the workspace locked (`requireWorkspaceKeys`).
 *
 * `K_id` is in IndexedDB, which is never opened under the SQLite write lock:
 *  - {@link resolveDerivedIdNamespace} (pre-lock) reads it and caches the
 *    derived namespace;
 *  - {@link derivedIdNamespaceInTx} (in-lock) re-reads the mode through the
 *    transaction and serves a sealed answer from that cache only.
 * `bootstrapWorkspace` starts the resolve for every kind of the workspace it
 * opens.
 */

import type { Tx } from '@/data/api'
import type { Repo } from '@/data/repo'
import { readWorkspaceEncryptionMode } from '@/data/workspaceSchema'
import { deriveWorkspaceIdNamespace } from '@/sync/crypto/derivedIdNamespace'
import { getWorkspaceKeyStore, keyStoreRecordId } from '@/sync/keys/keyStore'
import { getModePin } from '@/sync/keys/modePin'
import { requireWorkspaceKeys } from '@/sync/keys/openWorkspaceKeys'
import { uploadModeFor } from '@/sync/keys/resolver'

export interface DerivedIdNamespaceKind {
  /** HMAC input for a sealed workspace. Versioned: a new label re-points every
   *  new id of the kind. */
  readonly label: string
  /** A plaintext workspace's namespace. */
  readonly plaintextNamespace: string
}

/** A sealed workspace's namespace was not resolved before the write lock. A
 *  caller that can do without the derived id catches this; none may fall back
 *  to the public namespace. */
export class DerivedIdNamespaceUnavailableError extends Error {}

/** Derived namespaces by (user, workspace, label). Only a SEALED answer is
 *  cached, so a workspace converted in place stops getting the public namespace
 *  at its next call; and a cached one cannot go stale while `K_id` is fixed —
 *  until WK rotation exists, which must drop the entry. */
const derivedNamespaces = new Map<string, string>()

const cacheKey = (userId: string, workspaceId: string, kind: DerivedIdNamespaceKind): string =>
  `${keyStoreRecordId(userId, workspaceId)}\n${kind.label}`

const isPlaintext = async (
  userId: string,
  workspaceId: string,
  readEncryptionMode: () => Promise<string | null>,
): Promise<boolean> =>
  (await uploadModeFor(getModePin(userId, workspaceId), readEncryptionMode)) === 'none'

/** PRE-LOCK: `kind`'s namespace for `workspaceId`, deriving and caching a
 *  sealed workspace's on first use. Throws `WorkspaceKeyUnavailableError` when
 *  that needs a key this device does not hold. */
export const resolveDerivedIdNamespace = async (
  repo: Repo,
  workspaceId: string,
  kind: DerivedIdNamespaceKind,
): Promise<string> => {
  const userId = repo.user.id
  if (await isPlaintext(userId, workspaceId, () => readWorkspaceEncryptionMode(repo.db, workspaceId))) {
    return kind.plaintextNamespace
  }
  const key = cacheKey(userId, workspaceId, kind)
  let derived = derivedNamespaces.get(key)
  if (derived === undefined) {
    const {contentKeyHmac} = await requireWorkspaceKeys(getWorkspaceKeyStore(), userId, workspaceId)
    derived = await deriveWorkspaceIdNamespace(contentKeyHmac, kind.label)
    derivedNamespaces.set(key, derived)
  }
  return derived
}

/** IN-LOCK: `kind`'s namespace for `workspaceId`, with the mode read through
 *  `tx` immediately before the caller writes. Throws
 *  {@link DerivedIdNamespaceUnavailableError} for a sealed workspace whose
 *  namespace was not resolved before the lock. */
export const derivedIdNamespaceInTx = async (
  tx: Tx,
  userId: string,
  workspaceId: string,
  kind: DerivedIdNamespaceKind,
): Promise<string> => {
  if (await isPlaintext(userId, workspaceId, () => tx.workspaceEncryptionMode(workspaceId))) {
    return kind.plaintextNamespace
  }
  const derived = derivedNamespaces.get(cacheKey(userId, workspaceId, kind))
  if (derived === undefined) {
    throw new DerivedIdNamespaceUnavailableError(
      `${kind.label}: encrypted workspace ${workspaceId} has no namespace resolved before the ` +
      'write lock — call resolveDerivedIdNamespace before opening the transaction')
  }
  return derived
}
