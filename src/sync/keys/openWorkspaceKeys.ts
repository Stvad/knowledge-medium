/**
 * The one read of a workspace's keys for code that needs them NOW — sealing an
 * upload, opening a downloaded row, addressing an attachment, deriving an id
 * namespace. Every such read goes through {@link requireWorkspaceKeys}.
 *
 * The entry gate (`resolveWorkspaceEntry`) only checks for a key when a
 * workspace opens. After that the record can still disappear: the browser
 * evicts site storage. A read that finds no usable record then signals
 * {@link onWorkspaceKeyUnavailable} — the app closes the workspace if it is the
 * open one, into the same gate the entry check shows — and throws, so nothing
 * that needs the key proceeds without it. A store that cannot be read throws
 * too, without the signal.
 *
 * Not for the flows that establish a key (the gate, unlock, the pin upgrade,
 * the conversion's key step): absence is their normal input, which they answer
 * by asking for the key.
 */

import { CallbackSet } from '@/utils/callbackSet.js'
import type { WorkspaceObjectKeys } from '../crypto/contentKey.js'
import { objectKeysOf, type WorkspaceKeyRecord, type WorkspaceKeyStore } from './keyStore.js'

/** No usable key could be read for the workspace. Either this device holds
 *  none — no record, or one with no `K_id` (the legacy shape, which the entry
 *  gate also treats as locked) — or the store could not be read at all (the
 *  failure is `cause`), which says nothing about whether the key is still
 *  there. Only the first has locked the workspace. */
export class WorkspaceKeyUnavailableError extends Error {
  constructor(readonly workspaceId: string, options?: {cause?: unknown}) {
    super(
      options?.cause === undefined
        ? `no usable workspace key on this device for ${workspaceId}; unlock the workspace with its key`
        : `the workspace key store could not be read for ${workspaceId}`,
      options,
    )
    this.name = 'WorkspaceKeyUnavailableError'
  }
}

const unavailable = new CallbackSet<[userId: string, workspaceId: string]>('workspaceKeyUnavailable')

/** Called, synchronously and before the read throws, whenever a read finds
 *  this device holds no usable key. Fires for any workspace a caller asked
 *  about, open or not; the listener decides whether it is the open one. */
export const onWorkspaceKeyUnavailable = (
  listener: (userId: string, workspaceId: string) => void,
): (() => void) => unavailable.add(listener)

/** `workspaceId`'s keys, or a throw. A read that FINDS no usable key signals
 *  {@link onWorkspaceKeyUnavailable} first. A failed read is tried once more,
 *  since the store reopens a connection the browser closed, and then only
 *  throws: the caller's work fails and is retried, and locking the workspace
 *  over it would ask for a key the device still holds. */
export const requireWorkspaceKeys = async (
  keyStore: WorkspaceKeyStore,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceObjectKeys> => {
  let record: WorkspaceKeyRecord | null
  try {
    const read = () => keyStore.get(userId, workspaceId)
    record = await read().catch(read)
  } catch (cause) {
    console.warn(`[workspaceKeys] key read failed for ${workspaceId}`, cause)
    throw new WorkspaceKeyUnavailableError(workspaceId, {cause})
  }
  const keys = record && objectKeysOf(record)
  if (keys) return keys
  unavailable.notify(userId, workspaceId)
  throw new WorkspaceKeyUnavailableError(workspaceId)
}

/** `read`'s keys, or null when no usable key could be read (see
 *  {@link WorkspaceKeyUnavailableError}), for a caller whose own result
 *  already says "no key". */
export const orNullWhenKeyUnavailable = async <T>(read: Promise<T>): Promise<T | null> => {
  try {
    return await read
  } catch (err) {
    if (err instanceof WorkspaceKeyUnavailableError) return null
    throw err
  }
}
