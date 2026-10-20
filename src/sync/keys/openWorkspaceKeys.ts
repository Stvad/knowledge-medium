/**
 * The one read of a workspace's keys for code that needs them NOW — sealing an
 * upload, opening a downloaded row, addressing an attachment, deriving an id
 * namespace. Every such read goes through {@link requireWorkspaceKeys}.
 *
 * The entry gate (`resolveWorkspaceEntry`) only checks for a key when a
 * workspace opens. After that the record can still disappear: the browser
 * evicts site storage, or IndexedDB fails. A read that finds no usable record
 * then signals {@link onWorkspaceKeyUnavailable} — the app closes the workspace
 * if it is the open one, into the same gate the entry check shows — and throws,
 * so nothing that needs the key proceeds without it.
 *
 * Not for the flows that establish a key (the gate, unlock, the pin upgrade,
 * the conversion's key step): absence is their normal input, which they answer
 * by asking for the key.
 */

import { CallbackSet } from '@/utils/callbackSet.js'
import type { WorkspaceObjectKeys } from '../crypto/contentKey.js'
import { objectKeysOf, type WorkspaceKeyStore } from './keyStore.js'

/** This device holds no usable key for the workspace: no record, a record
 *  with no `K_id` (the legacy shape, which the entry gate also treats as
 *  locked), or an unreadable store (`cause`). */
export class WorkspaceKeyUnavailableError extends Error {
  constructor(readonly workspaceId: string, options?: {cause?: unknown}) {
    super(`no usable workspace key on this device for ${workspaceId}; unlock the workspace with its key`, options)
    this.name = 'WorkspaceKeyUnavailableError'
  }
}

const unavailable = new CallbackSet<[userId: string, workspaceId: string]>('workspaceKeyUnavailable')

/** Called, synchronously and before the read throws, whenever a read finds no
 *  usable key. Fires for any workspace a caller asked about, open or not; the
 *  listener decides whether it is the open one. */
export const onWorkspaceKeyUnavailable = (
  listener: (userId: string, workspaceId: string) => void,
): (() => void) => unavailable.add(listener)

/** `workspaceId`'s keys, or {@link onWorkspaceKeyUnavailable} then a throw. */
export const requireWorkspaceKeys = async (
  keyStore: WorkspaceKeyStore,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceObjectKeys> => {
  let keys: WorkspaceObjectKeys | null = null
  let cause: unknown
  try {
    const record = await keyStore.get(userId, workspaceId)
    keys = record && objectKeysOf(record)
  } catch (err) {
    console.warn(`[workspaceKeys] key read failed for ${workspaceId}`, err)
    cause = err
  }
  if (keys) return keys
  unavailable.notify(userId, workspaceId)
  throw new WorkspaceKeyUnavailableError(workspaceId, {cause})
}
