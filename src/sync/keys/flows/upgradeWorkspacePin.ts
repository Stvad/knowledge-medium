/**
 * The one-way pin upgrade for a workspace converted to E2EE in place
 * (docs/workspace-e2ee-conversion.md §6.2, §6.4).
 *
 * The server says e2ee and this device's pin doesn't — plaintext, or never set.
 * Until the pin moves, the resolver defers this workspace's rows and holds its
 * uploads. This flow moves it, in an order chosen so a crash at any step leaves
 * a state the next start can finish from:
 *
 *   1. check the server (one PostgREST read) and validate the key against its
 *      canary, then store the key;
 *   2. write the pin-upgrade marker;
 *   3. upgrade the pin;
 *   4. drain the workspace, re-reading every row deferred under the old pin;
 *   5. clear the marker.
 *
 * Before step 2 nothing needs resuming: the mismatch gate reappears and the
 * stored key finishes the upgrade without a paste. From step 2 to step 5 the
 * marker is what startup resumes from ({@link resumePinUpgrade}); it is needed
 * because an upgraded pin reads like any other e2ee pin while deferred rows are
 * still staged.
 *
 * Separate from `unlockWorkspaceWithKey`, which pins FIRST — right for an
 * unpinned workspace in quarantine, but a plaintext pin refuses it.
 */

import { validateCanary } from '../../crypto/canary.js'
import type { WorkspaceConversionRead } from '../conversionState.js'
import {
  getUsableKeyRecord,
  readUsableKeyRecord,
  type WorkspaceKeyRecord,
  type WorkspaceKeyStore,
} from '../keyStore.js'
import {
  clearPinUpgradeMarker,
  hasPinUpgradeMarker,
  upgradeModePinToE2ee,
  writePinUpgradeMarker,
} from '../modePin.js'
import { importPastedWorkspaceKey } from './pastedKey.js'

export interface ServerE2eeEntryDeps {
  readonly userId: string
  readonly workspaceId: string
  /** The server's workspace row, read now (not the synced copy). */
  readonly fetchConversionState: () => Promise<WorkspaceConversionRead>
  /** Whether this device's `blocks` already hold ciphertext for the workspace. */
  readonly hasCopiedCiphertext: () => Promise<boolean>
}

/** May this device enter a workspace the server calls e2ee, right now? */
export type ServerE2eeEntry =
  /** The server couldn't be read, or its row isn't a well-formed e2ee one. */
  | {readonly kind: 'unavailable'}
  /** `sealing`: the server may still hold plaintext and every write must wait
   *  for the purge, so no device unlocks or upgrades its pin. */
  | {readonly kind: 'converting'}
  /** An older build copied ciphertext into this device's `blocks`; the device
   *  needs the gated reset, not an upgrade. */
  | {readonly kind: 'copied-ciphertext'}
  /** Past `sealing`. `offerFinish`: the conversion is still cleaning up and this
   *  user owns the workspace, so this device can finish it. */
  | {readonly kind: 'open'; readonly canary: string; readonly offerFinish: boolean}

export const checkServerE2eeEntry = async (deps: ServerE2eeEntryDeps): Promise<ServerE2eeEntry> => {
  const read = await deps.fetchConversionState()
  if (read.kind !== 'read') return {kind: 'unavailable'}
  const {state} = read
  if (state.encryptionMode !== 'e2ee' || !state.wkCanary) return {kind: 'unavailable'}
  if (state.conversionPhase === 'sealing') return {kind: 'converting'}
  if (await deps.hasCopiedCiphertext()) return {kind: 'copied-ciphertext'}
  return {
    kind: 'open',
    canary: state.wkCanary,
    offerFinish: state.conversionPhase === 'cleaning' && state.ownerUserId === deps.userId,
  }
}

/** Where the key comes from: pasted now, or already in this device's key store
 *  (the converting device minted it; an earlier attempt stored it). */
export type PinUpgradeKey =
  | {readonly kind: 'pasted'; readonly text: string}
  | {readonly kind: 'stored'}

/** Re-materialize every staged row of the workspace (`repo.drainSyncWorkspace`),
 *  reporting how many it still had to defer; null when nothing is draining. */
export type WorkspaceDrain = () => Promise<{readonly deferred: number} | null>

export interface UpgradeWorkspacePinArgs extends ServerE2eeEntryDeps {
  readonly key: PinUpgradeKey
  readonly keyStore: WorkspaceKeyStore
  readonly drainWorkspace: WorkspaceDrain
}

export type UpgradeWorkspacePinResult =
  /** The pin moved. If the drain still deferred rows, the marker stays and the
   *  gate's finishing-upgrade state drains again. */
  | {readonly ok: true}
  /** `refused`: the server state doesn't allow it now (see `entry`).
   *  `format` / `invalid-key`: the pasted text isn't a key, or not this one.
   *  `no-stored-key`: no stored key with K_id to reuse.
   *  `storage`: the key, marker or pin couldn't be written; nothing has moved
   *  that a retry can't redo. */
  | {readonly ok: false; readonly reason: 'refused'; readonly entry: Exclude<ServerE2eeEntry, {kind: 'open'}>}
  | {readonly ok: false; readonly reason: 'format' | 'invalid-key' | 'no-stored-key' | 'storage'}

const resolveKey = async (
  args: UpgradeWorkspacePinArgs,
): Promise<{record: WorkspaceKeyRecord; pasted: boolean} | 'format' | 'no-stored-key'> => {
  if (args.key.kind === 'pasted') {
    const imported = await importPastedWorkspaceKey(args.key.text)
    return imported ? {record: imported, pasted: true} : 'format'
  }
  const stored = await readUsableKeyRecord(args.keyStore, args.userId, args.workspaceId)
  return stored ? {record: stored, pasted: false} : 'no-stored-key'
}

/** Steps 4–5, shared with {@link resumePinUpgrade}: true when the drain left
 *  nothing deferred and the marker is cleared. A drain that throws, or that
 *  still deferred rows, leaves the marker for the next try. Under an e2ee pin
 *  with its key a row only defers when the key store can't be read, and nothing
 *  else would re-read it. */
const drainAndClearMarker = async (
  userId: string,
  workspaceId: string,
  drainWorkspace: WorkspaceDrain,
): Promise<boolean> => {
  const report = await drainWorkspace()
  if (report && report.deferred > 0) return false
  clearPinUpgradeMarker(userId, workspaceId)
  return true
}

export const upgradeWorkspacePin = async (args: UpgradeWorkspacePinArgs): Promise<UpgradeWorkspacePinResult> => {
  const {userId, workspaceId} = args

  // Read here, not taken from the caller: the phase is checked against the
  // server immediately before anything is written.
  const entry = await checkServerE2eeEntry(args)
  if (entry.kind !== 'open') return {ok: false, reason: 'refused', entry}

  const key = await resolveKey(args)
  if (key === 'format' || key === 'no-stored-key') return {ok: false, reason: key}
  if (!(await validateCanary(key.record.wk, entry.canary, workspaceId))) {
    return {ok: false, reason: 'invalid-key'}
  }

  try {
    if (key.pasted) await args.keyStore.put(userId, workspaceId, key.record)
    writePinUpgradeMarker(userId, workspaceId)
    // A failure here leaves the marker, and the next start retries the pin
    // from the key stored above.
    upgradeModePinToE2ee(userId, workspaceId)
  } catch (err) {
    console.warn(`upgradeWorkspacePin: persisting the upgrade failed for ${workspaceId}`, err)
    return {ok: false, reason: 'storage'}
  }
  await drainAndClearMarker(userId, workspaceId, args.drainWorkspace)
  return {ok: true}
}

export interface ResumePinUpgradeArgs {
  readonly userId: string
  readonly workspaceId: string
  readonly keyStore: WorkspaceKeyStore
  readonly drainWorkspace: WorkspaceDrain
}

export type ResumePinUpgradeResult =
  | {readonly kind: 'nothing-pending'}
  | {readonly kind: 'resumed'}
  /** The drain still deferred rows; the marker stays for another try. */
  | {readonly kind: 'incomplete'}
  /** The store read fine and holds no usable key (evicted): the marker is
   *  dropped, and the workspace goes back to a key prompt, whose unlock drains it
   *  all. A store that can't be read THROWS instead, keeping the marker — the
   *  next read may well succeed, open the workspace `ready`, and drain nothing. */
  | {readonly kind: 'key-missing'}

/** Startup's half: finish an upgrade a crash interrupted, from the current pin.
 *  Local only — the marker was written after the server check passed, and the
 *  phase never moves back. */
export const resumePinUpgrade = async (args: ResumePinUpgradeArgs): Promise<ResumePinUpgradeResult> => {
  const {userId, workspaceId} = args
  if (!hasPinUpgradeMarker(userId, workspaceId)) return {kind: 'nothing-pending'}
  if (!(await getUsableKeyRecord(args.keyStore, userId, workspaceId))) {
    clearPinUpgradeMarker(userId, workspaceId)
    return {kind: 'key-missing'}
  }
  upgradeModePinToE2ee(userId, workspaceId)
  const complete = await drainAndClearMarker(userId, workspaceId, args.drainWorkspace)
  return {kind: complete ? 'resumed' : 'incomplete'}
}
