/**
 * E2EE crypto primitives (design doc §6/§7) — the public surface of the
 * sync-boundary crypto module. The encrypt/decrypt seam (`src/sync`,
 * §9/§11.1) and the workspace key/mode-pin layer consume these; the
 * implementations stay in focused sibling files so each is independently
 * testable.
 *
 * This barrel is the module's declared boundary. Symbols land here when
 * they are part of the primitive set even if their production consumer
 * arrives in a later phase of the rollout.
 */

export { bytesToBase64Url, base64UrlToBytes } from './base64url.js'
export { bytesToBase32, base32ToBytes } from './base32.js'
export { bytesToHex, hexToBytes } from './hex.js'
export {
  ENVELOPE_PREFIX,
  SCHEMA_VERSION,
  NONCE_BYTES,
  GCM_TAG_BYTES,
  hasEnvelopePrefix,
  encodeEnvelope,
  decodeEnvelope,
  type DecodedEnvelope,
} from './envelope.js'
export {
  BINARY_ENVELOPE_MAGIC,
  BINARY_MAGIC_BYTES,
  BINARY_ENVELOPE_MIN_BYTES,
  hasBinaryEnvelopeMagic,
  encodeBinaryEnvelope,
  decodeBinaryEnvelope,
  type DecodedBinaryEnvelope,
} from './binaryEnvelope.js'
export { contentAad, canaryAad, assetBytesAad } from './aad.js'
export { seal, open } from './aead.js'
export { sealBytes, openBytes } from './byteAead.js'
export {
  CONTENT_HASH_PREFIX,
  sha256,
  computeContentHash,
  verifyContentHash,
  digestFromContentHash,
} from './contentHash.js'
export {
  CONTENT_KEY_HKDF_INFO,
  deriveContentKeyHmac,
  deriveContentKey,
  type ContentKeyRef,
} from './contentKey.js'
export {
  WK_PREFIX,
  WK_BYTES,
  generateWorkspaceKeyBytes,
  formatWorkspaceKey,
  parseWorkspaceKey,
  importWorkspaceKey,
} from './workspaceKey.js'
export { mintCanary, validateCanary } from './canary.js'
