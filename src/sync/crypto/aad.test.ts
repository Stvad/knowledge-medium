import { describe, expect, it } from 'vitest'
import { canaryAad, contentAad } from './aad.js'

const bytes = (aad: Uint8Array): number[] => Array.from(aad)

describe('canonical AAD encoding', () => {
  // Known-answer test. seal/open round-trips use the SAME code for both
  // directions, so a silent change to the wire layout (endianness of the
  // length prefix, field order, dropping schema_version) would pass every
  // round-trip test while breaking interop with data already on disk and
  // weakening the cross-binding. This pins the exact bytes.
  it('lays out content AAD as [len32-BE ‖ field] per field, ending with schema_version', () => {
    // fields = ['a', 'b', 'c', '1']  (SCHEMA_VERSION = 1, as decimal string)
    expect(bytes(contentAad('a', 'b', 'c'))).toEqual([
      0, 0, 0, 1, 0x61, // "a"
      0, 0, 0, 1, 0x62, // "b"
      0, 0, 0, 1, 0x63, // "c"
      0, 0, 0, 1, 0x31, // "1"  -> schema_version, big-endian length prefix
    ])
  })

  it('canary AAD is domain-separated from any content column', () => {
    // canary = [workspaceId, 'canary', schema_version] — a different arity
    // and a literal middle field, so no (blockId, ws, column) content AAD
    // can ever collide with a canary AAD for the same workspace.
    expect(bytes(canaryAad('w'))).toEqual([
      0, 0, 0, 1, 0x77, // "w"
      0, 0, 0, 6, 0x63, 0x61, 0x6e, 0x61, 0x72, 0x79, // "canary"
      0, 0, 0, 1, 0x31, // "1"
    ])
    expect(bytes(canaryAad('w'))).not.toEqual(bytes(contentAad('w', 'canary', '1')))
  })

  it('length-prefixing prevents field-boundary aliasing', () => {
    // Without the length prefix, "A"‖"BC" and "AB"‖"C" would concatenate to
    // the same bytes and let the server swap a ciphertext between blocks
    // whose ids share a prefix/suffix. The prefix must keep them distinct.
    expect(bytes(contentAad('A', 'BC', 'content')))
      .not.toEqual(bytes(contentAad('AB', 'C', 'content')))
  })
})
