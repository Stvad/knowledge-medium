/**
 * Base32 (RFC 4648, no padding) for the user-facing workspace-key format
 * `kmp-wk-1:<base32>` (§5/§6). Base32 is paste-friendly across messaging
 * apps and legible on paper; 32 key bytes encode to 52 chars.
 *
 * Thin wrapper over `@scure/base` (audited, zero-dep). scure's
 * `base32nopad` is case-SENSITIVE on decode, so we upper-case first to
 * keep paste tolerance (users retype keys). The caller
 * (./workspaceKey.ts) asserts the decoded byte length.
 */

import { base32nopad } from '@scure/base'

export const bytesToBase32 = (bytes: Uint8Array): string =>
  base32nopad.encode(bytes)

export const base32ToBytes = (value: string): Uint8Array<ArrayBuffer> => {
  try {
    return Uint8Array.from(base32nopad.decode(value.toUpperCase()))
  } catch (cause) {
    throw new Error(`base32: invalid input`, { cause })
  }
}
