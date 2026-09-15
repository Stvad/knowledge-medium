/**
 * A UUIDv5 namespace derived from workspace key material — §10's content-oracle
 * defense, applied to derived BLOCK IDS instead of asset paths.
 *
 * A derived block id (`@/data/derivedIds`) is `uuidv5(<facts>, <namespace>)`
 * with the namespace a constant in this public repo, and block ids sync in
 * PLAINTEXT (E2EE seals `content` / `properties_json` / `references_json`, not
 * `id`). So for any kind whose derivation key contains user text, an untrusted
 * server can hash a GUESSED spelling and probe for the row — confirming "this
 * workspace has a property called `health`" without decrypting anything. Same
 * shape as a raw `sha256(plaintext)` asset path, and the same fix: key the hash
 * with a secret only the workspace's devices hold.
 *
 * The secret is `K_id`, the WK-derived HMAC subkey the asset path already uses
 * ({@link deriveContentKeyHmac}). Reusing it as a PRF rather than deriving a
 * third subkey keeps the key store, the unlock flows and the §6 entry gate
 * untouched — and `resolveWorkspaceEntry` already treats an E2EE workspace
 * whose record lacks `K_id` as LOCKED, so an open E2EE workspace is guaranteed
 * to have one.
 *
 * DOMAIN SEPARATION is by input length: `K_id`'s only other use signs a 32-byte
 * sha256 digest, and `contentHash.ts` throws unless it is exactly that, so a
 * label of any other length cannot land in the same input set. The guard below
 * enforces it rather than leaving it as a comment a future caller has to find —
 * and it matters because that other output is PUBLISHED as the Storage object
 * path, so a 32-byte label would make the namespace a prefix of a public value.
 *
 * NOT every derived-id kind in this class is covered. `computeAliasSeatId`
 * (`@/data/targets`) still hashes the alias TEXT under a public constant on
 * every workspace, which is the same oracle on a more sensitive input; it is
 * tracked separately because re-namespacing orphans every seat already minted.
 * Do not read this module as evidence the class is handled.
 *
 * ROTATION: WK rotation is unbuilt (e2ee-design §14). If it lands it changes
 * `K_id`, hence every namespace derived here, and ids already minted become
 * underivable. What that costs depends on the consumer, so check rather than
 * assume: property-definition synthesis mostly survives it, because it asks who
 * holds a NAME rather than what is at an id — but a definition the user DELETED
 * sits at the old id, the new one reads absent, and the pass would resurrect it,
 * defeating the "a deletion is an instruction" rule. Rotation breaks every asset
 * path too, so it is rotation's problem to solve fleet-wide; it is not a reason
 * to key these ids off something weaker.
 */

import { stringify as uuidStringify } from 'uuid'
import { SHA256_BYTES } from './contentHash.js'

/** UUID namespaces are 16 bytes, of which 6 bits are structural. */
const UUID_BYTES = 16

/**
 * The UUIDv5 namespace this workspace uses for one derived-id KIND.
 *
 * `first 16 bytes of HMAC-SHA256(K_id, label)`, with the version and variant
 * nibbles forced to v4/RFC-4122. Forcing them is not cosmetic: `uuid`'s `v5()`
 * THROWS `Invalid UUID` on a namespace string whose structural bits don't
 * conform (measured against uuid@14). It costs 6 of 128 bits, leaving 122 bits
 * of secret — far past what a probing server could search.
 *
 * Deterministic across a workspace's own devices (they hold the same WK, hence
 * the same `K_id`) and unguessable to anyone else.
 */
export const deriveWorkspaceIdNamespace = async (
  contentKeyHmac: CryptoKey,
  label: string,
): Promise<string> => {
  const labelBytes = new TextEncoder().encode(label)
  if (labelBytes.length === SHA256_BYTES) {
    throw new Error(
      `derived-id namespace label must not be ${SHA256_BYTES} bytes — that is the ` +
      'asset content-key input set, which shares this HMAC key',
    )
  }
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', contentKeyHmac, labelBytes))
  const bytes = mac.slice(0, UUID_BYTES)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  return uuidStringify(bytes)
}
