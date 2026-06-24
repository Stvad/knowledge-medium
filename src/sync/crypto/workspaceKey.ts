/**
 * Workspace key (WK) material and its user-facing format (§5/§6).
 *
 * The WK is 256 random bits — the only secret in the design. It is
 * surfaced to the user once at create as `kmp-wk-1:<base32>` and pasted
 * on additional devices. On a device it lives as a NON-EXTRACTABLE
 * AES-GCM `CryptoKey` (§5): JS can encrypt/decrypt with it but
 * `exportKey` throws, so a hostile script can't dump the bytes for
 * offline forever-decryption.
 *
 * The `kmp-wk-1:` prefix makes a mis-pasted key identifiable; the `1`
 * reserves a clean upgrade path.
 */

import { base32ToBytes, bytesToBase32 } from './base32.js'

export const WK_PREFIX = 'kmp-wk-1:'
export const WK_BYTES = 32

/** Fresh 256-bit workspace key material, client-side CSPRNG. */
export const generateWorkspaceKeyBytes = (): Uint8Array<ArrayBuffer> =>
  crypto.getRandomValues(new Uint8Array(WK_BYTES))

/** Render key bytes as the paste-friendly `kmp-wk-1:<base32>` string. */
export const formatWorkspaceKey = (bytes: Uint8Array): string => {
  if (bytes.length !== WK_BYTES) {
    throw new Error(`workspace key must be ${WK_BYTES} bytes, got ${bytes.length}`)
  }
  return WK_PREFIX + bytesToBase32(bytes)
}

/** Parse a pasted `kmp-wk-1:<base32>` string back to key bytes.
 *  Tolerates whitespace (including internal) and case: users retype these
 *  from paper or paste line-wrapped, and base32 carries no whitespace. */
export const parseWorkspaceKey = (value: string): Uint8Array<ArrayBuffer> => {
  // Strip ALL whitespace, not just the outer edges. A line-wrapped paste or
  // a retyped paper backup can carry internal spaces/tabs/newlines; base32
  // never does, so dropping them here is safe and keeps the decoder strict.
  const cleaned = value.replace(/\s+/g, '')
  // Case-fold the prefix only. The base32 payload is upper-cased on decode
  // (base32.ts), so a user who upper-cased the WHOLE backup string —
  // `KMP-WK-1:…` — must still parse to honor the documented case tolerance;
  // a case-sensitive `startsWith` would reject exactly that paste.
  if (cleaned.slice(0, WK_PREFIX.length).toLowerCase() !== WK_PREFIX) {
    throw new Error('workspace key: missing kmp-wk-1: prefix')
  }
  const bytes = base32ToBytes(cleaned.slice(WK_PREFIX.length))
  if (bytes.length !== WK_BYTES) {
    throw new Error(`workspace key: expected ${WK_BYTES} bytes, got ${bytes.length}`)
  }
  return bytes
}

/** Import raw key bytes as a non-extractable AES-GCM `CryptoKey` (§5). */
export const importWorkspaceKey = (bytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
