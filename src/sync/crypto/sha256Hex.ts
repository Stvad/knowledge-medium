import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from './hex.js'

/** Synchronous, unlike `crypto.subtle`, and available outside a secure context. */
export const sha256Hex = (bytes: Uint8Array): string => bytesToHex(sha256(bytes))
