/**
 * The BYTE sync boundary (§5 / §6) — the asset-bytes analog of transform.ts.
 *
 *   encodeBytes(bytes, mode, getCek, ref)        — app → object store (seal on upload)
 *   verifyObjectBytes(blob, mode, getCek, ref)   — object store → app (open + hash-check)
 *
 * One transform parameterized by mode: `none` (plaintext) is the IDENTITY
 * case — bytes pass through unchanged, exactly as encodeForWire does for text —
 * and `e2ee` seals/opens with the workspace key under assetBytesAad. The object
 * is content-addressed and shared by every block carrying the bytes (§10), so
 * the AAD binds the CONTENT HASH, not a block id (binding a block id would stop
 * a co-referencing block from opening it).
 *
 * Opening an envelope authenticates it only (AAD + GCM tag), not that the
 * bytes match the content hash, so the open is private: the only read is
 * {@link verifyObjectBytes}, which always hash-checks too (§5.1 / §7.3).
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

/** Identity for plaintext; AES-GCM open for E2EE. */
const decodeBytes = async (
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

/** The object size capture and preflight measure against. A hosted project
 *  caps every bucket at its project-wide upload limit, whatever the bucket's own
 *  `file_size_limit` says, so an upload beyond this one may be refused; uploads
 *  themselves let Storage's 413 decide. */
export const MAX_OBJECT_BYTES = 50 * 1024 * 1024

/** Does a plaintext of this many bytes, encoded for `mode`, fit in `limit`?
 *  e2ee adds {@link BINARY_ENVELOPE_OVERHEAD_BYTES}, so a plaintext just under
 *  the limit can be stored raw but not sealed. */
export const fitsObjectLimit = (plaintextBytes: number, mode: SyncMode, limit = MAX_OBJECT_BYTES): boolean =>
  plaintextBytes + (mode === 'e2ee' ? BINARY_ENVELOPE_OVERHEAD_BYTES : 0) <= limit
