/**
 * The content-addressed Storage path's CONTENT KEY (§10).
 *
 * An object lives at `<workspace_id>/<content-key>`, where the content-key is
 * derived from the PLAINTEXT bytes' sha256 digest:
 *
 *   plaintext workspace → content-key = hex(sha256(plaintext))        (raw)
 *   E2EE workspace      → content-key = hex(HMAC(K_id, sha256(plain)))  (keyed)
 *
 * Content-addressing makes uploads idempotent and object dedup an invariant.
 * The per-workspace HMAC subkey `K_id` is what keeps an E2EE path from becoming
 * a CONTENT ORACLE: a raw `sha256(plaintext)` path would let the untrusted
 * server confirm "does this workspace hold this known file?" by hashing a
 * candidate and probing for the object. Keying the hash with a secret only the
 * workspace's devices hold removes that — deterministic within a workspace
 * (idempotent + dedup), unguessable to the server, distinct across workspaces.
 *
 * K_id is derived from the raw WK bytes via HKDF at WK import/unlock time (the
 * only window the raw bytes are in scope — the stored WK handle is a
 * non-extractable AES-GCM key WebCrypto won't sign with), and persisted as its
 * OWN non-extractable HMAC `CryptoKey` co-located with the WK (§10 / keyStore).
 * The `info` label domain-separates this derivation from any other WK-derived
 * key, exactly as aad.ts domain-separates the canary from content columns.
 */

import { verifyObjectBytes } from '../byteTransform.js'
import type { SyncMode } from '../transform.js'
import { computeContentHash, digestFromContentHash } from './contentHash.js'
import { bytesToHex } from './hex.js'

/** HKDF `info` label binding K_id to this purpose + version (§10). NOT optional:
 *  it domain-separates the content-key subkey from any future WK-derived key
 *  (the deferred key hierarchy, a per-asset share key).
 *
 *  Versioned, but bumping it is no longer the cheap rotation it was: `K_id` is
 *  also the PRF behind an E2EE workspace's derived-id namespaces
 *  ({@link deriveWorkspaceIdNamespace}). A new label re-points asset paths,
 *  which are re-derivable and re-uploadable, AND every block id already minted
 *  under the old namespace, which is stored data. */
export const CONTENT_KEY_HKDF_INFO = 'km/asset-content-key/v1'

/** K_id length — 32 bytes (a full SHA-256 block, matches the HMAC hash). */
const CONTENT_KEY_HMAC_BITS = 256

/**
 * Derive the per-workspace content-key HMAC subkey (`K_id`, §10) from the raw
 * WK bytes. `HKDF-SHA256(ikm = WK bytes, salt = "", info = the label, L = 32)`,
 * imported NON-EXTRACTABLE as an HMAC/SHA-256 signing key. The empty salt is
 * safe — the WK is already 32 uniform random bytes. The caller must hold the
 * raw WK bytes (available only at import/unlock) and is responsible for zeroing
 * them after; this function zeroes the intermediate K_id `bits` it materializes
 * (the content-key oracle secret) once the non-extractable key is imported.
 */
export const deriveContentKeyHmac = async (
  wkBytes: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> => {
  const ikm = await crypto.subtle.importKey('raw', wkBytes, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(CONTENT_KEY_HKDF_INFO),
    },
    ikm,
    CONTENT_KEY_HMAC_BITS,
  )
  try {
    // importKey copies the bytes into the (non-extractable) key material, so the
    // raw K_id buffer can be wiped right after — same zeroing invariant the WK
    // bytes get; leaving it resident keeps the content-key oracle secret on the
    // JS heap until GC/heap reuse.
    return await crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  } finally {
    new Uint8Array(bits).fill(0)
  }
}

export interface ContentKeyRef {
  /** The block's stored `sha256:<hex>` content hash (§5.1). */
  readonly contentHash: string
  /** Decode mode for THIS workspace, mapped from materializability (§7.3):
   *  'none' (plaintext-pinned → raw path) or 'e2ee' (decrypt → keyed path). */
  readonly mode: SyncMode
  /** The workspace's K_id, required for `mode === 'e2ee'`. `null` (a device
   *  that hasn't derived K_id yet — the §10 migration) makes an E2EE derivation
   *  fail closed rather than route to a wrong path. */
  readonly contentKeyHmac: CryptoKey | null
}

/**
 * Derive the content-key (the object-path segment, §10) for a block's bytes.
 * Plaintext → the raw sha256 hex (the server already holds those bytes);
 * E2EE → `hex(HMAC(K_id, sha256))` at FULL length (never truncated — truncation
 * only invites two plaintexts to collide on one path). Throws when an E2EE
 * derivation has no K_id, so the resolver fails closed.
 */
export const deriveContentKey = async (ref: ContentKeyRef): Promise<string> => {
  const digest = digestFromContentHash(ref.contentHash)
  if (ref.mode === 'none') return bytesToHex(digest)
  if (!ref.contentKeyHmac) {
    throw new Error('content key: e2ee workspace has no K_id (re-paste the workspace key)')
  }
  const mac = await crypto.subtle.sign('HMAC', ref.contentKeyHmac, digest)
  return bytesToHex(new Uint8Array(mac))
}

/** One workspace key pair: the key that seals its objects and the `K_id`
 *  that names them, both from one key record. */
export interface WorkspaceObjectKeys {
  readonly cek: CryptoKey
  readonly contentKeyHmac: CryptoKey
}

/** The keyed names of a set of content hashes, each mapped back to its hash,
 *  with the key that opens the objects under them. */
export interface KeyedNames {
  readonly cek: CryptoKey
  readonly hashByName: ReadonlyMap<string, string>
}

/** Index the keyed name of each content hash under `keys`. A malformed hash
 *  names no object, so it is skipped; a key that can't sign throws. */
export const indexKeyedNames = async (
  contentHashes: Iterable<string>,
  keys: WorkspaceObjectKeys,
): Promise<KeyedNames> => {
  const hashByName = new Map<string, string>()
  for (const contentHash of contentHashes) {
    let digest: Uint8Array<ArrayBuffer>
    try {
      digest = digestFromContentHash(contentHash)
    } catch {
      continue
    }
    const mac = await crypto.subtle.sign('HMAC', keys.contentKeyHmac, digest)
    hashByName.set(bytesToHex(new Uint8Array(mac)), contentHash)
  }
  return {cek: keys.cek, hashByName}
}

export type StoredObjectClass =
  /** The plaintext bytes of `contentHash`, at their pre-conversion name. */
  | {readonly kind: 'raw'; readonly contentHash: string}
  /** `contentHash`'s plaintext, sealed, at its keyed name. */
  | {readonly kind: 'keyed'; readonly contentHash: string}
  | {readonly kind: 'neither'}

/**
 * What the object at `<workspaceId>/<name>` holds, decided by its bytes
 * (docs/workspace-e2ee-conversion.md §6.3 step 8). `name` is the object's path
 * under the workspace's folder, so a nested object is never raw or keyed. For
 * bytes b under name n:
 *   - raw iff n == hex(sha256(b));
 *   - keyed iff b opens under the workspace key to p, and n == hex(HMAC(K_id, sha256(p)));
 *   - otherwise neither.
 * Never by a header or the name's shape: both names are 64 hex characters, and
 * a plaintext file may begin with `encb:v1:`.
 *
 * The asset AAD binds the content hash, so b can only be opened with p's hash
 * in hand: an object is keyed only under a name `keyed` maps, and any other is
 * neither. `keyed` is null when nothing can be keyed: a plaintext workspace, or
 * a caller without the key.
 */
export const classifyStoredObject = async ({
  workspaceId,
  name,
  bytes,
  keyed,
}: {
  readonly workspaceId: string
  readonly name: string
  readonly bytes: Uint8Array<ArrayBuffer>
  readonly keyed: KeyedNames | null
}): Promise<StoredObjectClass> => {
  const contentHash = await computeContentHash(bytes)
  if (name === (await deriveContentKey({contentHash, mode: 'none', contentKeyHmac: null}))) {
    return {kind: 'raw', contentHash}
  }
  const keyedHash = keyed?.hashByName.get(name)
  if (keyed && keyedHash !== undefined) {
    const verified = await verifyObjectBytes(bytes, 'e2ee', async () => keyed.cek, {contentHash: keyedHash, workspaceId})
    if (verified.ok) return {kind: 'keyed', contentHash: keyedHash}
  }
  return {kind: 'neither'}
}
