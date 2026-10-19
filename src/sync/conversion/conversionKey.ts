/**
 * The workspace key a conversion runs under (docs/workspace-e2ee-conversion.md
 * §6.3 step 1, and the canary check every run makes once the mode is e2ee).
 * No flip and no seal runs under a key the user hasn't just proved they hold,
 * by pasting their saved copy and having it open the canary.
 */

import { mintCanary, validateCanary } from '../crypto/canary.js'
import { openCanaryWithPastedKey, type PastedKeyProblem } from '../keys/flows/pastedKey.js'
import {
  getUsableKeyRecord,
  readUsableKeyRecord,
  type WorkspaceKeyRecord,
  type WorkspaceKeyStore,
} from '../keys/keyStore.js'
import { mintWorkspaceKey, probeKeyStore } from '../keys/mintWorkspaceKey.js'
import type { FlipAttempts } from './flipAttempts.js'

export interface SaveKeyPrompt {
  /** The `kmp-wk-1:` string, shown once. */
  readonly displayed: string
  /** The last string typed back doesn't unlock the workspace. */
  readonly mismatch: boolean
}

export type SavedKeyProblem =
  /** This device holds a key that doesn't open the server's canary. */
  | 'stored-key-wrong'
  | PastedKeyProblem

export interface SavedKeyPrompt {
  /** `earlier-attempt`: this device holds the key of an attempt that didn't
   *  flip. `converting`: the server is past the flip. */
  readonly context: 'earlier-attempt' | 'converting'
  readonly problem: SavedKeyProblem | null
  /** The user may drop the earlier attempt's key and get a new one instead. */
  readonly canStartOver: boolean
}

export interface KeyPrompts {
  /** Show the new key and resolve with the string the user types back from
   *  where they saved it. */
  saveKey(prompt: SaveKeyPrompt): Promise<string>
  /** Resolve with the saved key, pasted; or null to start over, which only a
   *  prompt that `canStartOver` offers. */
  enterSavedKey(prompt: SavedKeyPrompt): Promise<string | null>
}

export interface KeyStepDeps {
  readonly userId: string
  readonly workspaceId: string
  readonly keyStore: WorkspaceKeyStore
  readonly flipAttempts: FlipAttempts
  readonly prompts: KeyPrompts
  readonly generateKeyBytes?: () => Uint8Array<ArrayBuffer>
}

export interface FlipKey {
  readonly record: WorkspaceKeyRecord
  readonly canary: string
}

/** Asks until the pasted key opens `canary`, or the user starts over (null). */
const askForSavedKey = async (
  prompts: KeyPrompts,
  workspaceId: string,
  canary: string,
  prompt: Omit<SavedKeyPrompt, 'problem'>,
  problem: SavedKeyProblem | null = null,
): Promise<WorkspaceKeyRecord | null> => {
  for (;;) {
    const pasted = await prompts.enterSavedKey({...prompt, problem})
    if (pasted === null && prompt.canStartOver) return null
    const opened = pasted === null ? 'format' : await openCanaryWithPastedKey(pasted, canary, workspaceId)
    if (typeof opened !== 'string') return opened
    problem = opened
  }
}

const mintFlipKey = async (deps: KeyStepDeps): Promise<FlipKey> => {
  const {userId, workspaceId, keyStore, prompts} = deps
  const minted = await mintWorkspaceKey(workspaceId, deps.generateKeyBytes)
  // Before the reveal: the user shouldn't save a key this device can't keep.
  await probeKeyStore(keyStore, userId, minted.record)
  for (let mismatch = false; ;) {
    const typed = await prompts.saveKey({displayed: minted.displayed, mismatch})
    if (typeof (await openCanaryWithPastedKey(typed, minted.canary, workspaceId)) !== 'string') break
    mismatch = true
  }
  await keyStore.put(userId, workspaceId, minted.record)
  const kept = await getUsableKeyRecord(keyStore, userId, workspaceId)
  if (!kept || !(await validateCanary(kept.wk, minted.canary, workspaceId))) {
    throw new Error('conversion: the workspace key did not read back from this device\'s key store')
  }
  return {record: minted.record, canary: minted.canary}
}

/**
 * The key to flip under. A key this device holds for a workspace that is
 * still plaintext can only come from an earlier attempt that didn't flip — or
 * whose flip is still committing — so it is reused once the user pastes their
 * copy of it: a late-committing flip carries its canary. The user may drop it
 * for a new key only once no flip sent under it can still commit.
 *
 * A key store that can't be read throws rather than minting a second key while
 * the first may still exist.
 */
export const obtainFlipKey = async (deps: KeyStepDeps): Promise<FlipKey> => {
  const {userId, workspaceId, keyStore, prompts, flipAttempts} = deps
  const stored = await getUsableKeyRecord(keyStore, userId, workspaceId)
  if (!stored) return mintFlipKey(deps)

  const canary = await mintCanary(stored.wk, workspaceId)
  const confirmed = await askForSavedKey(prompts, workspaceId, canary, {
    context: 'earlier-attempt',
    canStartOver: !flipAttempts.sentRecently(),
  })
  if (confirmed) return {record: stored, canary}
  await keyStore.delete(userId, workspaceId)
  flipAttempts.clear()
  return mintFlipKey(deps)
}

/**
 * The key that opens the server's canary: this device's, or the saved one,
 * pasted and then stored. Every run checks it before sealing anything, so no
 * row is ever sealed under a key nobody saved.
 */
export const requireCanaryKey = async (
  deps: Omit<KeyStepDeps, 'generateKeyBytes' | 'flipAttempts'> & {readonly canary: string},
): Promise<WorkspaceKeyRecord> => {
  const {userId, workspaceId, keyStore, prompts, canary} = deps
  const stored = await readUsableKeyRecord(keyStore, userId, workspaceId)
  if (stored && (await validateCanary(stored.wk, canary, workspaceId))) return stored

  const pasted = await askForSavedKey(
    prompts,
    workspaceId,
    canary,
    {context: 'converting', canStartOver: false},
    stored ? 'stored-key-wrong' : null,
  )
  // Unreachable: a prompt that can't start over never yields null.
  if (!pasted) throw new Error('conversion: no workspace key was given')
  await keyStore.put(userId, workspaceId, pasted)
  return pasted
}
