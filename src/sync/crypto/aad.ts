/**
 * Canonical, unambiguous AAD (associated data) encoding (§6 "AAD").
 *
 * AAD binds each ciphertext to its block, workspace, column, and schema
 * version so the server can't swap ciphertexts between blocks, between
 * workspaces, or between columns of one block.
 *
 * The fields are variable-length TEXT ids, so a naive concatenation
 * lets `"A"‖"BC"` alias `"AB"‖"C"` and defeats the cross-binding. We
 * length-prefix every field with a 4-byte big-endian length so the
 * decomposition is unambiguous (§6). `schema_version` is folded in as
 * its decimal string, length-prefixed like any other field — it equals
 * the envelope's `v1` tag and is reconstructable at decrypt time.
 */

import { SCHEMA_VERSION } from './envelope.js'

const utf8 = new TextEncoder()

// Returns an ArrayBuffer-backed view so the AAD flows into WebCrypto's
// BufferSource params (aead.ts) without a cast.
const canonicalAad = (fields: readonly string[]): Uint8Array<ArrayBuffer> => {
  const encoded = fields.map(field => utf8.encode(field))
  const total = encoded.reduce((sum, bytes) => sum + 4 + bytes.length, 0)
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  let offset = 0
  for (const bytes of encoded) {
    view.setUint32(offset, bytes.length, false) // big-endian
    offset += 4
    out.set(bytes, offset)
    offset += bytes.length
  }
  return out
}

/** AAD for one encrypted content column of a block. `columnName` is one
 *  of `content` | `properties_json` | `references_json`. */
export const contentAad = (
  blockId: string,
  workspaceId: string,
  columnName: string,
): Uint8Array<ArrayBuffer> => canonicalAad([blockId, workspaceId, columnName, String(SCHEMA_VERSION)])

/** AAD for the workspace key-check canary (§7). The literal `canary`
 *  domain-separates it from any content column. */
export const canaryAad = (workspaceId: string): Uint8Array<ArrayBuffer> =>
  canonicalAad([workspaceId, 'canary', String(SCHEMA_VERSION)])
