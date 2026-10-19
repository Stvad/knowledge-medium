/**
 * The BYTE sync boundary (§5 / §6) — the asset-bytes analog of transform.ts.
 *
 *   encodeBytes(bytes, mode, getCek, ref)  — app → object store (seal on upload)
 *   decodeBytes(blob,  mode, getCek, ref)  — object store → app (open on download)
 *
 * One transform parameterized by mode: `none` (plaintext) is the IDENTITY
 * case — bytes pass through unchanged, exactly as encodeForWire does for text —
 * and `e2ee` seals/opens with the workspace key under assetBytesAad. The object
 * is content-addressed and shared by every block carrying the bytes (§10), so
 * the AAD binds the CONTENT HASH, not a block id (binding a block id would stop
 * a co-referencing block from opening it).
 *
 * decodeBytes authenticates the envelope only (AAD + GCM tag). It does NOT
 * verify the bytes match the content key — that is the hash check
 * (verifyContentHash, §5.1 / §7.3). {@link verifyObjectBytes} composes the two,
 * and is the only way anything may accept an object read from Storage.
 *
 * Like transform.ts, this is free of DB / PowerSync / Storage coupling: it
 * knows only bytes, a mode, a key lookup, and the AAD-binding ref.
 */

import { assetBytesAad } from './crypto/aad.js'
import { BINARY_ENVELOPE_OVERHEAD_BYTES } from './crypto/binaryEnvelope.js'
import { openBytes, sealBytes } from './crypto/byteAead.js'
import { verifyContentHash } from './crypto/contentHash.js'
import { requireCek, type GetCek, type SyncMode } from './transform.js'

/** What the byte AAD binds an object to (§5.1): the content hash
 *  (`sha256:<hex>` — the `block.properties.hash` value) and the workspace. */
export interface AssetByteRef {
  readonly contentHash: string
  readonly workspaceId: string
}

/** App → object store. Identity for plaintext; AES-GCM seal for E2EE. */
export const encodeBytes = async (
  bytes: Uint8Array<ArrayBuffer>,
  mode: SyncMode,
  getCek: GetCek,
  ref: AssetByteRef,
): Promise<Uint8Array<ArrayBuffer>> => {
  if (mode === 'none') return bytes
  const key = await requireCek(getCek, ref.workspaceId, 'byte transform')
  return sealBytes(key, bytes, assetBytesAad(ref.contentHash, ref.workspaceId))
}

/** Object store → app. Identity for plaintext; AES-GCM open for E2EE.
 *  Authenticates the envelope only — the caller verifies the content hash
 *  (§5.1). */
export const decodeBytes = async (
  blob: Uint8Array<ArrayBuffer>,
  mode: SyncMode,
  getCek: GetCek,
  ref: AssetByteRef,
): Promise<Uint8Array<ArrayBuffer>> => {
  if (mode === 'none') return blob
  const key = await requireCek(getCek, ref.workspaceId, 'byte transform')
  return openBytes(key, blob, assetBytesAad(ref.contentHash, ref.workspaceId))
}

export type ObjectVerification =
  | { readonly ok: true; readonly plaintext: Uint8Array<ArrayBuffer> }
  /** `decode-failed`: it doesn't open (wrong or missing key, a tampered
   *  envelope, a mismatched AAD). `hash-mismatch`: it opens, to other bytes. */
  | { readonly ok: false; readonly reason: 'decode-failed' | 'hash-mismatch' }

/**
 * Is `blob`, read from Storage, the plaintext of `ref.contentHash`? Decodes it,
 * then hash-checks the result (§5.1). Storage is untrusted, and the AEAD tag
 * can't catch a poisoner who knows the content hash and seals other bytes under
 * the right AAD, so the hash check is the load-bearing half.
 */
export const verifyObjectBytes = async (
  blob: Uint8Array<ArrayBuffer>,
  mode: SyncMode,
  getCek: GetCek,
  ref: AssetByteRef,
): Promise<ObjectVerification> => {
  let plaintext: Uint8Array<ArrayBuffer>
  try {
    plaintext = await decodeBytes(blob, mode, getCek, ref)
  } catch {
    return { ok: false, reason: 'decode-failed' }
  }
  if (!(await verifyContentHash(plaintext, ref.contentHash))) return { ok: false, reason: 'hash-mismatch' }
  return { ok: true, plaintext }
}

/** The attachments bucket's original `file_size_limit`, 50 MiB. #1294 raises
 *  the bucket by the envelope overhead, but a hosted project caps every bucket at
 *  its global upload limit, so no upload may count on more than this. */
export const MAX_OBJECT_BYTES = 50 * 1024 * 1024

/** Does a plaintext of this many bytes, encoded for `mode`, fit in `limit`?
 *  e2ee adds the envelope overhead, so a plaintext within 36 bytes of the limit
 *  can be stored raw but never sealed. */
export const fitsObjectLimit = (plaintextBytes: number, mode: SyncMode, limit = MAX_OBJECT_BYTES): boolean =>
  plaintextBytes + (mode === 'e2ee' ? BINARY_ENVELOPE_OVERHEAD_BYTES : 0) <= limit
