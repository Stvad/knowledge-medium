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
 * verify the bytes match the content key — that is the read-side hash check
 * (verifyContentHash, §5.1 / §7.3), which the resolver runs against
 * block.properties.hash before caching/serving. They stay composed at the
 * resolver, not folded in here, so plaintext and e2ee share one read path.
 *
 * Like transform.ts, this is free of DB / PowerSync / Storage coupling: it
 * knows only bytes, a mode, a key lookup, and the AAD-binding ref.
 */

import { assetBytesAad } from './crypto/aad.js'
import { openBytes, sealBytes } from './crypto/byteAead.js'
import type { GetCek, SyncMode } from './transform.js'

/** What the byte AAD binds an object to (§5.1): the content hash
 *  (`sha256:<hex>` — the `block.properties.hash` value) and the workspace. */
export interface AssetByteRef {
  readonly contentHash: string
  readonly workspaceId: string
}

const requireCek = async (getCek: GetCek, workspaceId: string): Promise<CryptoKey> => {
  const key = await getCek(workspaceId)
  if (!key) {
    throw new Error(`byte transform: no workspace key available for ${workspaceId}`)
  }
  return key
}

/** App → object store. Identity for plaintext; AES-GCM seal for E2EE. */
export const encodeBytes = async (
  bytes: Uint8Array<ArrayBuffer>,
  mode: SyncMode,
  getCek: GetCek,
  ref: AssetByteRef,
): Promise<Uint8Array<ArrayBuffer>> => {
  if (mode === 'none') return bytes
  const key = await requireCek(getCek, ref.workspaceId)
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
  const key = await requireCek(getCek, ref.workspaceId)
  return openBytes(key, blob, assetBytesAad(ref.contentHash, ref.workspaceId))
}
