// @vitest-environment node
/**
 * Fuzz suite for the pure, synchronous crypto codecs in `src/sync/crypto/`:
 * base64url.ts, base32.ts, hex.ts, envelope.ts, binaryEnvelope.ts,
 * workspaceKey.ts (parse/format only), the sync parser half of
 * contentHash.ts (`digestFromContentHash` — `sha256`/`computeContentHash`
 * are async and out of scope here), and aad.ts. See `src/test/fuzz.ts` for
 * the smoke/deep tier mechanics and `docs/fuzzing.md` for conventions.
 *
 * Oracles:
 *
 *  - Round-trip on each codec's documented valid domain: `decode(encode(v))`
 *    deep-equals `v`.
 *      - base64url/base32/hex: any byte string (base64url.ts:15-28,
 *        base32.ts:14-23, hex.ts:11-39 place no restriction on content).
 *      - `enc:v1:` / `encb:v1:` envelopes: any 12-byte nonce and any
 *        ciphertext of at least `GCM_TAG_BYTES` (16) bytes — the decode
 *        guard's floor (envelope.ts:54, binaryEnvelope.ts:78:
 *        `payload.length < NONCE_BYTES + GCM_TAG_BYTES`, and nonce is
 *        always exactly `NONCE_BYTES`, so the floor on ciphertext alone is
 *        `GCM_TAG_BYTES`).
 *      - workspace key: any 32 (`WK_BYTES`) bytes, and — per the documented
 *        whitespace/case tolerance (workspaceKey.ts:33-44) — still under
 *        arbitrary injected whitespace and per-character case flips of the
 *        formatted string.
 *      - content hash digest: `digestFromContentHash` is the sync inverse
 *        of the *format* half of `computeContentHash` (`CONTENT_HASH_PREFIX
 *        + bytesToHex(digest)`, contentHash.ts:29-30, 47-65); we build that
 *        format string directly from `bytesToHex` (sync) rather than going
 *        through the async `sha256`, to stay in the sync/pure lane.
 *
 *  - Decode totality: every decoder either returns or throws an `Error`
 *    (never a bare `TypeError`/`RangeError` from an unguarded access) whose
 *    message matches one of that module's own documented guard messages —
 *    enumerated per decoder below, cited against source. Each decoder's
 *    guards are read top-to-bottom from its module so the message list is
 *    exhaustive, including messages *bubbled* from a lower-level codec
 *    (e.g. `decodeEnvelope` can surface `base64UrlToBytes`'s error).
 *
 *  - AAD injectivity (aad.ts): the canonical encoding length-prefixes every
 *    field with a 4-byte big-endian length (aad.ts:22-35), which makes
 *    decoding a deterministic left-inverse of encoding — so two field lists
 *    produce equal bytes iff the lists are themselves equal (same length,
 *    same fields pointwise). We fuzz this both directly (arbitrary field
 *    tuples: equal tuples byte-equal, unequal tuples byte-unequal) and via
 *    the specific "boundary aliasing" shape called out in aad.ts's own
 *    docblock (`"A"‖"BC"` vs `"AB"‖"C"`), generalized to arbitrary splits
 *    of an arbitrary ASCII string. Cross-builder disjointness follows from
 *    the same argument: `canaryAad` (3 fields) can never collide with
 *    `contentAad`/`assetBytesAad` (4 fields) for *any* input, since the
 *    field count is itself recoverable from the decoded byte stream
 *    (aad.test.ts already pins this for canary — generalized here to all
 *    inputs). `contentAad` vs `assetBytesAad` (both 4 fields) only stays
 *    disjoint when `columnName` is restricted to the three real column
 *    names documented at aad.ts:37-38 (`content` | `properties_json` |
 *    `references_json`) — none of which equals the `assetBytesAad` literal
 *    `'asset-bytes'` (aad.ts:60-64); the exported builders don't enforce
 *    that restriction at the type level, so this test constrains the
 *    generator to the documented domain rather than the full string space
 *    (matches aad.test.ts's own "domain-separated from every real content
 *    column" example).
 *
 * A note on the string domain used here: `fc.string()` (default
 * `'grapheme'` unit) and `fc.string({unit: 'binary'})` both produce
 * well-formed Unicode (the latter explicitly excludes half surrogate
 * pairs per its fast-check docs). That matters for the AAD tuple-level
 * injectivity property: `canonicalAad` UTF-8-encodes fields via
 * `TextEncoder`, which *silently* replaces an unpaired surrogate with
 * U+FFFD — so two distinct JS strings that differ only in how they spell
 * an ill-formed code unit sequence (e.g. a lone high surrogate vs. a
 * literal U+FFFD) can encode to identical bytes, breaking injectivity at
 * the string level even though the byte-level TLV encoding itself is
 * sound. Confirmed directly: `new TextEncoder().encode('\uD800')` and
 * `new TextEncoder().encode('�')` are byte-identical. Sticking to
 * well-formed-Unicode generators keeps the property about the thing aad.ts
 * actually claims to defend (byte-boundary aliasing), not this separate
 * (and, for real callers — UUIDs/enum column names — unreachable) UTF-16
 * encoding quirk.
 */
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { fuzzParams } from '@/test/fuzz'
import { bytesToBase64Url, base64UrlToBytes } from './base64url.js'
import { bytesToBase32, base32ToBytes } from './base32.js'
import { bytesToHex, hexToBytes } from './hex.js'
import {
  ENVELOPE_PREFIX,
  NONCE_BYTES,
  GCM_TAG_BYTES,
  encodeEnvelope,
  decodeEnvelope,
} from './envelope.js'
import {
  BINARY_ENVELOPE_MAGIC,
  BINARY_MAGIC_BYTES,
  encodeBinaryEnvelope,
  decodeBinaryEnvelope,
} from './binaryEnvelope.js'
import { WK_BYTES, WK_PREFIX, formatWorkspaceKey, parseWorkspaceKey } from './workspaceKey.js'
import { CONTENT_HASH_PREFIX, digestFromContentHash } from './contentHash.js'
import { contentAad, assetBytesAad, canaryAad } from './aad.js'

// ──── Shared helpers ────

/** Well-formed-Unicode "nasty" strings: default grapheme unit plus the full
 *  Unicode code-point range (still well-formed — see docblock above) and
 *  ASCII control characters. */
const junkStringArb = fc.oneof(
  fc.string(),
  fc.string({ unit: 'binary' }),
  fc.string({ unit: 'binary-ascii' }),
)

const asArray = (bytes: Uint8Array): number[] => Array.from(bytes)

/** Assert `action` either returns normally or throws an `Error` (never a
 *  bare TypeError/RangeError) whose message matches one of `patterns`. */
const assertThrowsKnown = (action: () => unknown, patterns: readonly RegExp[]) => {
  try {
    action()
  } catch (e) {
    expect(e).toBeInstanceOf(Error)
    expect(e).not.toBeInstanceOf(TypeError)
    expect(e).not.toBeInstanceOf(RangeError)
    const message = (e as Error).message
    expect(
      patterns.some(p => p.test(message)),
      `unexpected error message for ${action}: ${JSON.stringify(message)}`,
    ).toBe(true)
  }
}

// ════════════════════════════════════════════════════════════════════════
// Round-trips on the valid domain
// ════════════════════════════════════════════════════════════════════════

describe('round-trip: decode(encode(bytes)) on the valid domain', () => {
  it('base64url: any byte string', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), bytes => {
        expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes)
      }),
      fuzzParams(200),
    )
  })

  it('base32: any byte string', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), bytes => {
        expect(base32ToBytes(bytesToBase32(bytes))).toEqual(bytes)
      }),
      fuzzParams(200),
    )
  })

  it('hex: any byte string', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), bytes => {
        expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes)
      }),
      fuzzParams(200),
    )
  })

  it('enc:v1: envelope: any 12-byte nonce + ciphertext >= GCM_TAG_BYTES (envelope.ts:54)', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: NONCE_BYTES, maxLength: NONCE_BYTES }),
        fc.uint8Array({ minLength: GCM_TAG_BYTES, maxLength: 200 }),
        (nonce, ciphertext) => {
          const decoded = decodeEnvelope(encodeEnvelope(nonce, ciphertext))
          expect(asArray(decoded.nonce)).toEqual(asArray(nonce))
          expect(asArray(decoded.ciphertext)).toEqual(asArray(ciphertext))
        },
      ),
      fuzzParams(200),
    )
  })

  it('encb:v1: binary envelope: any 12-byte nonce + ciphertext >= GCM_TAG_BYTES (binaryEnvelope.ts:78)', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: NONCE_BYTES, maxLength: NONCE_BYTES }),
        fc.uint8Array({ minLength: GCM_TAG_BYTES, maxLength: 200 }),
        (nonce, ciphertext) => {
          const decoded = decodeBinaryEnvelope(encodeBinaryEnvelope(nonce, ciphertext))
          expect(asArray(decoded.nonce)).toEqual(asArray(nonce))
          expect(asArray(decoded.ciphertext)).toEqual(asArray(ciphertext))
        },
      ),
      fuzzParams(200),
    )
  })

  it('workspace key: any 32-byte key round-trips format/parse', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: WK_BYTES, maxLength: WK_BYTES }), bytes => {
        expect(parseWorkspaceKey(formatWorkspaceKey(bytes))).toEqual(bytes)
      }),
      fuzzParams(200),
    )
  })

  it('workspace key: parse tolerates injected whitespace and per-character case flips (workspaceKey.ts:33-44)', () => {
    // formatWorkspaceKey always produces WK_PREFIX + a fixed-length base32
    // payload (length depends only on WK_BYTES, not content), so the
    // formatted length is constant for every generated key.
    const formattedLen = WK_PREFIX.length + Math.ceil((WK_BYTES * 8) / 5)
    const swapCase = (c: string): string => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())
    const wsCharArb = fc.constantFrom(' ', '\t', '\n', '\r')
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: WK_BYTES, maxLength: WK_BYTES }),
        fc.array(fc.boolean(), { minLength: formattedLen, maxLength: formattedLen }),
        // One "gap" of 0-3 whitespace chars before each character, plus one trailing gap.
        fc.array(fc.array(wsCharArb, { maxLength: 3 }), {
          minLength: formattedLen + 1,
          maxLength: formattedLen + 1,
        }),
        (bytes, caseFlips, gaps) => {
          const formatted = formatWorkspaceKey(bytes)
          expect(formatted.length).toBe(formattedLen)
          let perturbed = gaps[0].join('')
          for (let i = 0; i < formatted.length; i++) {
            const c = formatted[i]
            perturbed += caseFlips[i] ? swapCase(c) : c
            perturbed += gaps[i + 1].join('')
          }
          expect(parseWorkspaceKey(perturbed)).toEqual(bytes)
        },
      ),
      fuzzParams(150),
    )
  })

  it('content hash digest: sync format/parse round-trip via bytesToHex (contentHash.ts:47-65)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), digest => {
        const hashString = CONTENT_HASH_PREFIX + bytesToHex(digest)
        expect(digestFromContentHash(hashString)).toEqual(digest)
      }),
      fuzzParams(200),
    )
  })
})

// ════════════════════════════════════════════════════════════════════════
// Decode totality: returns, or throws only a documented Error
// ════════════════════════════════════════════════════════════════════════

describe('decode totality: returns or throws only a documented Error', () => {
  it('base64UrlToBytes (base64url.ts:26)', () => {
    fc.assert(
      fc.property(junkStringArb, s => assertThrowsKnown(() => base64UrlToBytes(s), [/^base64url: invalid input$/])),
      fuzzParams(200),
    )
  })

  it('base32ToBytes (base32.ts:21)', () => {
    fc.assert(
      fc.property(junkStringArb, s => assertThrowsKnown(() => base32ToBytes(s), [/^base32: invalid input$/])),
      fuzzParams(200),
    )
  })

  it('hexToBytes (hex.ts:26,34)', () => {
    fc.assert(
      fc.property(junkStringArb, s =>
        assertThrowsKnown(() => hexToBytes(s), [
          /^hexToBytes: odd-length hex string \(\d+ chars\)$/,
          /^hexToBytes: non-hex characters at offset \d+$/,
        ]),
      ),
      fuzzParams(200),
    )
  })

  it('decodeEnvelope (envelope.ts:51,55, bubbling base64url.ts:26)', () => {
    // Weight some junk toward carrying the enc:v1: prefix so the property
    // also exercises the base64url-decode and too-short guards, not just
    // the prefix check (mirrors codecs.fuzz.test.ts's "almost valid" arbs).
    const arb = fc.oneof(
      { arbitrary: junkStringArb, weight: 3 },
      { arbitrary: junkStringArb.map(s => ENVELOPE_PREFIX + s), weight: 2 },
    )
    fc.assert(
      fc.property(arb, s =>
        assertThrowsKnown(() => decodeEnvelope(s), [
          /^envelope: missing enc:v1: prefix$/,
          /^envelope: payload too short to hold a nonce and auth tag$/,
          /^base64url: invalid input$/,
        ]),
      ),
      fuzzParams(200),
    )
  })

  it('decodeBinaryEnvelope (binaryEnvelope.ts:75,79)', () => {
    const withMagic = fc.uint8Array({ maxLength: 200 }).map(tail => {
      const out = new Uint8Array(BINARY_MAGIC_BYTES + tail.length)
      out.set(BINARY_ENVELOPE_MAGIC, 0)
      out.set(tail, BINARY_MAGIC_BYTES)
      return out
    })
    const arb = fc.oneof(
      { arbitrary: fc.uint8Array({ maxLength: 200 }), weight: 3 },
      { arbitrary: withMagic, weight: 2 },
    )
    fc.assert(
      fc.property(arb, blob =>
        assertThrowsKnown(() => decodeBinaryEnvelope(blob), [
          /^binary envelope: missing encb:v1: magic$/,
          /^binary envelope: payload too short to hold a nonce and auth tag$/,
        ]),
      ),
      fuzzParams(200),
    )
  })

  it('parseWorkspaceKey (workspaceKey.ts:45,49, bubbling base32.ts:21)', () => {
    const arb = fc.oneof(
      { arbitrary: junkStringArb, weight: 3 },
      { arbitrary: junkStringArb.map(s => WK_PREFIX + s), weight: 2 },
    )
    fc.assert(
      fc.property(arb, s =>
        assertThrowsKnown(() => parseWorkspaceKey(s), [
          /^workspace key: missing kmp-wk-1: prefix$/,
          /^workspace key: expected 32 bytes, got \d+$/,
          /^base32: invalid input$/,
        ]),
      ),
      fuzzParams(200),
    )
  })

  it('digestFromContentHash (contentHash.ts:49,57,62, bubbling hex.ts:26,34)', () => {
    const arb = fc.oneof(
      { arbitrary: junkStringArb, weight: 3 },
      { arbitrary: junkStringArb.map(s => CONTENT_HASH_PREFIX + s), weight: 2 },
    )
    fc.assert(
      fc.property(arb, s =>
        assertThrowsKnown(() => digestFromContentHash(s), [
          /^content hash: missing 'sha256:' prefix$/,
          /^content hash: expected lowercase hex$/,
          /^content hash: expected 32-byte digest, got \d+$/,
          /^hexToBytes: odd-length hex string \(\d+ chars\)$/,
          /^hexToBytes: non-hex characters at offset \d+$/,
        ]),
      ),
      fuzzParams(200),
    )
  })
})

// ════════════════════════════════════════════════════════════════════════
// AAD injectivity (aad.ts)
// ════════════════════════════════════════════════════════════════════════

describe('AAD injectivity (aad.ts canonical length-prefixed encoding)', () => {
  // Well-formed-Unicode field values — see the top-of-file docblock for why
  // this (not arbitrary UTF-16) is the right domain for this property.
  const fieldArb = fc.oneof(fc.string(), fc.string({ unit: 'binary' }))

  it('contentAad: equal argument tuples byte-equal, unequal tuples byte-unequal', () => {
    fc.assert(
      fc.property(
        fc.tuple(fieldArb, fieldArb, fieldArb),
        fc.tuple(fieldArb, fieldArb, fieldArb),
        (t1, t2) => {
          const a1 = asArray(contentAad(...t1))
          const a2 = asArray(contentAad(...t2))
          const equalArgs = t1[0] === t2[0] && t1[1] === t2[1] && t1[2] === t2[2]
          if (equalArgs) expect(a1).toEqual(a2)
          else expect(a1).not.toEqual(a2)
        },
      ),
      fuzzParams(150),
    )
  })

  it('assetBytesAad: equal argument tuples byte-equal, unequal tuples byte-unequal', () => {
    fc.assert(
      fc.property(fc.tuple(fieldArb, fieldArb), fc.tuple(fieldArb, fieldArb), (t1, t2) => {
        const a1 = asArray(assetBytesAad(...t1))
        const a2 = asArray(assetBytesAad(...t2))
        const equalArgs = t1[0] === t2[0] && t1[1] === t2[1]
        if (equalArgs) expect(a1).toEqual(a2)
        else expect(a1).not.toEqual(a2)
      }),
      fuzzParams(150),
    )
  })

  it('canaryAad: equal workspaceId byte-equal, unequal workspaceId byte-unequal', () => {
    fc.assert(
      fc.property(fieldArb, fieldArb, (w1, w2) => {
        const a1 = asArray(canaryAad(w1))
        const a2 = asArray(canaryAad(w2))
        if (w1 === w2) expect(a1).toEqual(a2)
        else expect(a1).not.toEqual(a2)
      }),
      fuzzParams(150),
    )
  })

  it('never aliases across a field boundary, for any two distinct splits of the same ASCII string (generalizes aad.test.ts\'s "A"‖"BC" vs "AB"‖"C")', () => {
    // ASCII-only total: slicing an arbitrary Unicode string at an arbitrary
    // UTF-16 index can split a surrogate pair, which reintroduces the
    // TextEncoder replacement-character aliasing discussed in the top
    // docblock — a distinct (and separately understood) phenomenon from the
    // field-boundary aliasing this property targets. ASCII chars are always
    // one UTF-16 code unit, so any split point here is well-formed.
    const totalWithSplitsArb = fc
      .string({ unit: 'grapheme-ascii', maxLength: 40 })
      .chain(total => fc.tuple(fc.constant(total), fc.nat(total.length), fc.nat(total.length)))
    fc.assert(
      fc.property(totalWithSplitsArb, ([total, i, j]) => {
        fc.pre(i !== j)
        const aadA = contentAad(total.slice(0, i), total.slice(i), 'content')
        const aadB = contentAad(total.slice(0, j), total.slice(j), 'content')
        expect(asArray(aadA)).not.toEqual(asArray(aadB))
      }),
      fuzzParams(150),
    )
  })

  it('canaryAad never collides with contentAad or assetBytesAad, for any input (different field arity)', () => {
    fc.assert(
      fc.property(
        fieldArb,
        fc.tuple(fieldArb, fieldArb, fieldArb),
        fc.tuple(fieldArb, fieldArb),
        (canaryWs, contentArgs, assetArgs) => {
          const canary = asArray(canaryAad(canaryWs))
          expect(canary).not.toEqual(asArray(contentAad(...contentArgs)))
          expect(canary).not.toEqual(asArray(assetBytesAad(...assetArgs)))
        },
      ),
      fuzzParams(150),
    )
  })

  it("contentAad never collides with assetBytesAad when columnName is one of the three real column names (aad.ts:37-38)", () => {
    const columnArb = fc.constantFrom('content', 'properties_json', 'references_json')
    fc.assert(
      fc.property(fieldArb, fieldArb, columnArb, fieldArb, fieldArb, (blockId, wsA, column, contentHash, wsB) => {
        expect(asArray(contentAad(blockId, wsA, column))).not.toEqual(
          asArray(assetBytesAad(contentHash, wsB)),
        )
      }),
      fuzzParams(150),
    )
  })
})
