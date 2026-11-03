import { validateCanary } from '../../crypto/canary.js'
import { deriveContentKeyHmac } from '../../crypto/contentKey.js'
import { importWorkspaceKey, parseWorkspaceKey } from '../../crypto/workspaceKey.js'

/** A workspace key the user pasted, imported with its K_id. */
export interface PastedWorkspaceKey {
  readonly wk: CryptoKey
  readonly contentKeyHmac: CryptoKey
}

/** Import a pasted `kmp-wk-1:` string (whitespace/case tolerated), or null when
 *  it isn't one. K_id (§10) is derived here because the raw bytes are in scope
 *  only now — the stored WK handle is non-extractable — and the bytes are zeroed
 *  on every exit. */
export const importPastedWorkspaceKey = async (pastedKey: string): Promise<PastedWorkspaceKey | null> => {
  try {
    const wkBytes = parseWorkspaceKey(pastedKey)
    try {
      return {
        wk: await importWorkspaceKey(wkBytes),
        contentKeyHmac: await deriveContentKeyHmac(wkBytes),
      }
    } finally {
      wkBytes.fill(0)
    }
  } catch {
    return null
  }
}

/** Why pasted text didn't open a canary: it isn't a key at all, or it is
 *  another workspace's key. */
export type PastedKeyProblem = 'format' | 'invalid-key'

/** The pasted key, if it opens `canary`: the one test every flow that takes a
 *  pasted key applies before trusting it. */
export const openCanaryWithPastedKey = async (
  pastedKey: string,
  canary: string,
  workspaceId: string,
): Promise<PastedWorkspaceKey | PastedKeyProblem> => {
  const imported = await importPastedWorkspaceKey(pastedKey)
  if (!imported) return 'format'
  return (await validateCanary(imported.wk, canary, workspaceId)) ? imported : 'invalid-key'
}
