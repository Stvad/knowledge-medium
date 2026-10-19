/**
 * The workspace key a conversion runs under (docs/workspace-e2ee-conversion.md
 * §6.3 step 1, and the canary check every run makes once the mode is e2ee).
 */

import { mintCanary, validateCanary } from '../crypto/canary.js'
import { importPastedWorkspaceKey } from '../keys/flows/pastedKey.js'
import {
  getUsableKeyRecord,
  readUsableKeyRecord,
  type WorkspaceKeyRecord,
  type WorkspaceKeyStore,
} from '../keys/keyStore.js'
import { mintWorkspaceKey, probeKeyStore } from '../keys/mintWorkspaceKey.js'

export interface SaveKeyPrompt {
  /** The `kmp-wk-1:` string, shown once. */
  readonly displayed: string
  /** The last string typed back doesn't unlock the workspace. */
  readonly mismatch: boolean
}

export type SavedKeyProblem =
  /** This device holds a key that doesn't open the server's canary. */
  | 'stored-key-wrong'
  | 'format'
  | 'wrong-key'

export interface KeyPrompts {
  /** Show the new key and resolve with the string the user types back from
   *  where they saved it. */
  saveKey(prompt: SaveKeyPrompt): Promise<string>
  /** Resolve with the saved key, pasted. */
  enterSavedKey(prompt: {readonly problem: SavedKeyProblem | null}): Promise<string>
}

export interface KeyStepDeps {
  readonly userId: string
  readonly workspaceId: string
  readonly keyStore: WorkspaceKeyStore
  readonly prompts: KeyPrompts
  readonly generateKeyBytes?: () => Uint8Array<ArrayBuffer>
}

export interface FlipKey {
  readonly record: WorkspaceKeyRecord
  readonly canary: string
  /** Minted by an earlier attempt that didn't flip, and saved by the user then. */
  readonly reused: boolean
}

const opensCanary = async (text: string, canary: string, workspaceId: string): Promise<boolean> => {
  const key = await importPastedWorkspaceKey(text)
  return key !== null && (await validateCanary(key.wk, canary, workspaceId))
}

/**
 * The key to flip under. A key this device holds for a workspace that is still
 * plaintext can only come from an earlier attempt that didn't flip — or whose
 * flip is still committing — and the user saved it then, so it is reused:
 * a late-committing flip carries its canary. Otherwise a new key is minted,
 * revealed once, typed back, and stored, then read back.
 *
 * A key store that can't be read throws rather than minting a second key while
 * the first may still exist.
 */
export const obtainFlipKey = async (deps: KeyStepDeps): Promise<FlipKey> => {
  const {userId, workspaceId, keyStore, prompts} = deps
  const stored = await getUsableKeyRecord(keyStore, userId, workspaceId)
  if (stored) return {record: stored, canary: await mintCanary(stored.wk, workspaceId), reused: true}

  const minted = await mintWorkspaceKey(workspaceId, deps.generateKeyBytes)
  // Before the reveal: the user shouldn't save a key this device can't keep.
  await probeKeyStore(keyStore, userId, minted.record)
  for (let mismatch = false; ;) {
    const typed = await prompts.saveKey({displayed: minted.displayed, mismatch})
    if (await opensCanary(typed, minted.canary, workspaceId)) break
    mismatch = true
  }
  await keyStore.put(userId, workspaceId, minted.record)
  const kept = await getUsableKeyRecord(keyStore, userId, workspaceId)
  if (!kept || !(await validateCanary(kept.wk, minted.canary, workspaceId))) {
    throw new Error('conversion: the workspace key did not read back from this device\'s key store')
  }
  return {record: minted.record, canary: minted.canary, reused: false}
}

/**
 * The key that opens the server's canary: this device's, or the saved one,
 * pasted and then stored. Every run checks it before sealing anything, so no
 * row is ever sealed under a key nobody saved.
 */
export const requireCanaryKey = async (
  deps: Omit<KeyStepDeps, 'generateKeyBytes'> & {readonly canary: string},
): Promise<WorkspaceKeyRecord> => {
  const {userId, workspaceId, keyStore, prompts, canary} = deps
  const stored = await readUsableKeyRecord(keyStore, userId, workspaceId)
  if (stored && (await validateCanary(stored.wk, canary, workspaceId))) return stored

  for (let problem: SavedKeyProblem | null = stored ? 'stored-key-wrong' : null; ;) {
    const pasted = await importPastedWorkspaceKey(await prompts.enterSavedKey({problem}))
    if (!pasted) {
      problem = 'format'
      continue
    }
    if (!(await validateCanary(pasted.wk, canary, workspaceId))) {
      problem = 'wrong-key'
      continue
    }
    await keyStore.put(userId, workspaceId, pasted)
    return pasted
  }
}
