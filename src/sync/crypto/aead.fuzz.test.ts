// @vitest-environment node
/**
 * Fuzz suite for the AEAD seal/open surface: aead.ts (text), byteAead.ts
 * (raw bytes), and canary.ts (the AEAD-sealed-known-plaintext key check).
 * See `src/test/fuzz.ts` for the smoke/deep tier mechanics and
 * `docs/fuzzing.md` for conventions.
 *
 * Deterministic keys use the same fill pattern as the example-based tests
 * (aead.test.ts:7 `importWorkspaceKey(new Uint8Array(32).fill(n))`) so runs
 * are reproducible without touching `crypto.getRandomValues` outside of
 * `seal`/`sealBytes` themselves (their internal fresh-nonce draw is exactly
 * the sanctioned randomness — the envelope carries the nonce, so open()
 * doesn't need it re-supplied).
 *
 * Oracles:
 *
 *  - Round-trip: `open(seal(key, x, aad), key, aad) === x` for text
 *    (aead.ts:19-33 seal, :37-49 open) and the byte-array analogue for
 *    `sealBytes`/`openBytes` (byteAead.ts:26-39, :44-53), for arbitrary AAD
 *    tuples built from `contentAad`/`assetBytesAad` (aad.ts:39-43, :60-64).
 *    Text plaintext is restricted to well-formed-Unicode generators
 *    (`fc.string()` / `fc.string({unit:'binary'})`), not arbitrary UTF-16:
 *    `seal` encodes via `TextEncoder`, which *silently* replaces an
 *    unpaired surrogate with U+FFFD, so a lone-surrogate plaintext would
 *    fail this oracle for a reason that has nothing to do with the AEAD
 *    (confirmed and documented the same way in
 *    cryptoCodecs.fuzz.test.ts:63-78). Byte-array plaintext has no such
 *    restriction — `sealBytes`/`openBytes` never touch `TextEncoder`
 *    (byteAead.ts:1-20).
 *
 *  - Tamper rejection: flipping a single bit anywhere in the ciphertext‖tag
 *    portion of a sealed envelope must make `open`/`openBytes` reject —
 *    GCM's tag authenticates every ciphertext byte, so a modified
 *    ciphertext decrypts to garbage that fails the tag check with
 *    probability `1 - 2^-128` (aead.ts:35-36,41-43 "Throws on AEAD
 *    failure"). We decode the envelope (envelope.ts:49-63 /
 *    binaryEnvelope.ts:73-87) to locate the exact ciphertext bytes rather
 *    than perturbing the encoded string/blob blindly, so the tamper always
 *    lands on real ciphertext (never the nonce, never envelope framing) and
 *    the re-encoded envelope stays well-formed.
 *
 *  - AAD mismatch: opening under an AAD tuple that differs from the sealing
 *    tuple in exactly one field must reject. `canonicalAad`'s TLV encoding
 *    (aad.ts:22-35) makes the AAD bytes a function of the field values, so
 *    changing one field's *string content* (not just re-splitting the same
 *    total, which is the boundary-aliasing case cryptoCodecs.fuzz.test.ts
 *    already covers) changes the AAD bytes and therefore fails the GCM tag
 *    check. We force the changed field to differ by appending a sentinel
 *    control character (U+0001): `s + '\u0001'` is always strictly longer
 *    than `s`, so the property needs no `.filter()`/retry.
 *
 *  - Wrong key: opening under a different deterministic key must reject
 *    (aead.ts:35-36 "wrong key" is explicitly one of the documented AEAD
 *    failure causes).
 *
 *  - `validateCanary` (canary.ts:22-33): returns `false` and never throws
 *    for a wrong key or a corrupted/arbitrary canary string — the `try {
 *    open(...) } catch { return false }` wrapper (canary.ts:27-32) makes
 *    this a totality property, not just a "usually behaves" one. Returns
 *    `true` for a canary minted by the same key against the same workspace
 *    id (canary.ts:16-17 `mintCanary`, the plaintext-equals-id check at
 *    canary.ts:29).
 */
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { fuzzParams } from '@/test/fuzz'
import { open, seal } from './aead.js'
import { openBytes, sealBytes } from './byteAead.js'
import { mintCanary, validateCanary } from './canary.js'
import { contentAad, assetBytesAad } from './aad.js'
import { decodeEnvelope, encodeEnvelope } from './envelope.js'
import { decodeBinaryEnvelope, encodeBinaryEnvelope } from './binaryEnvelope.js'
import { importWorkspaceKey } from './workspaceKey.js'

// ──── Shared helpers ────

/** Deterministic keys, memoized per fill byte so repeated draws of the same
 *  fill across property runs don't re-hit `crypto.subtle.importKey`. */
const keyCache = new Map<number, Promise<CryptoKey>>()
const keyFrom = (fill: number): Promise<CryptoKey> => {
  let cached = keyCache.get(fill)
  if (!cached) {
    cached = importWorkspaceKey(new Uint8Array(32).fill(fill))
    keyCache.set(fill, cached)
  }
  return cached
}

const fillArb = fc.integer({ min: 0, max: 255 })
/** Two fill bytes guaranteed distinct, without a `.filter()` retry loop. */
const distinctFillPairArb = fc
  .tuple(fillArb, fc.integer({ min: 1, max: 255 }))
  .map(([fill1, offset]) => [fill1, (fill1 + offset) % 256] as const)

// Well-formed-Unicode string domain — see the top-of-file docblock on why
// this (not arbitrary UTF-16) is the right domain for TextEncoder-backed
// round-trips. Capped length keeps the smoke tier's crypto-op count cheap.
const textArb = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.string({ unit: 'binary', maxLength: 40 }),
)
const fieldArb = fc.oneof(
  fc.string({ maxLength: 24 }),
  fc.string({ unit: 'binary', maxLength: 24 }),
)
const bytesArb = fc.uint8Array({ maxLength: 64 })

/** Appending a sentinel control character (U+0001) guarantees
 *  `perturbField(s) !== s` unconditionally - the result is always strictly
 *  longer - so the AAD-mismatch generators below need no `.filter()`/retry. */
const perturbField = (s: string): string => s + '\u0001'

const contentAadTupleArb = fc.tuple(fieldArb, fieldArb, fieldArb)
/** A `contentAad` tuple plus a one-field-perturbed sibling. */
const contentAadMismatchArb = fc
  .tuple(contentAadTupleArb, fc.integer({ min: 0, max: 2 }))
  .map(([original, idx]) => {
    const mutated: [string, string, string] = [...original]
    mutated[idx] = perturbField(mutated[idx])
    return { original, mutated }
  })

const assetBytesAadTupleArb = fc.tuple(fieldArb, fieldArb)
/** An `assetBytesAad` tuple plus a one-field-perturbed sibling. */
const assetBytesAadMismatchArb = fc
  .tuple(assetBytesAadTupleArb, fc.integer({ min: 0, max: 1 }))
  .map(([original, idx]) => {
    const mutated: [string, string] = [...original]
    mutated[idx] = perturbField(mutated[idx])
    return { original, mutated }
  })

// ════════════════════════════════════════════════════════════════════════
// Round-trip
// ════════════════════════════════════════════════════════════════════════

describe('round-trip: open(seal(x)) === x', () => {
  it('text: arbitrary unicode plaintext under matching key + AAD (aead.ts:19-49)', async () => {
    await fc.assert(
      fc.asyncProperty(textArb, contentAadTupleArb, fillArb, async (plaintext, aadFields, fill) => {
        const key = await keyFrom(fill)
        const aad = contentAad(...aadFields)
        const envelope = await seal(key, plaintext, aad)
        expect(await open(key, envelope, aad)).toBe(plaintext)
      }),
      fuzzParams(40),
    )
  })

  it('bytes: arbitrary byte arrays under matching key + AAD (byteAead.ts:26-53)', async () => {
    await fc.assert(
      fc.asyncProperty(bytesArb, assetBytesAadTupleArb, fillArb, async (plaintext, aadFields, fill) => {
        const key = await keyFrom(fill)
        const aad = assetBytesAad(...aadFields)
        const sealed = await sealBytes(key, plaintext, aad)
        expect(Uint8Array.from(await openBytes(key, sealed, aad))).toEqual(plaintext)
      }),
      fuzzParams(40),
    )
  })
})

// ════════════════════════════════════════════════════════════════════════
// Tamper rejection
// ════════════════════════════════════════════════════════════════════════

describe('tamper rejection: a single flipped ciphertext bit never opens', () => {
  it('text: flipping one byte of the ciphertext‖tag rejects (envelope.ts:49-63)', async () => {
    await fc.assert(
      fc.asyncProperty(
        textArb,
        contentAadTupleArb,
        fillArb,
        fc.nat(),
        async (plaintext, aadFields, fill, idxRaw) => {
          const key = await keyFrom(fill)
          const aad = contentAad(...aadFields)
          const envelope = await seal(key, plaintext, aad)
          const { nonce, ciphertext } = decodeEnvelope(envelope)
          const tampered = Uint8Array.from(ciphertext)
          tampered[idxRaw % tampered.length] ^= 0x01
          const tamperedEnvelope = encodeEnvelope(nonce, tampered)
          await expect(open(key, tamperedEnvelope, aad)).rejects.toThrow()
        },
      ),
      fuzzParams(30),
    )
  })

  it('bytes: flipping one byte of the ciphertext‖tag rejects (binaryEnvelope.ts:73-87)', async () => {
    await fc.assert(
      fc.asyncProperty(
        bytesArb,
        assetBytesAadTupleArb,
        fillArb,
        fc.nat(),
        async (plaintext, aadFields, fill, idxRaw) => {
          const key = await keyFrom(fill)
          const aad = assetBytesAad(...aadFields)
          const sealed = await sealBytes(key, plaintext, aad)
          const { nonce, ciphertext } = decodeBinaryEnvelope(sealed)
          const tampered = Uint8Array.from(ciphertext)
          tampered[idxRaw % tampered.length] ^= 0x01
          const tamperedEnvelope = encodeBinaryEnvelope(nonce, tampered)
          await expect(openBytes(key, tamperedEnvelope, aad)).rejects.toThrow()
        },
      ),
      fuzzParams(30),
    )
  })
})

// ════════════════════════════════════════════════════════════════════════
// AAD mismatch
// ════════════════════════════════════════════════════════════════════════

describe('AAD mismatch: opening under a differing AAD tuple rejects', () => {
  it('text: contentAad, one field differs (aad.ts:39-43)', async () => {
    await fc.assert(
      fc.asyncProperty(contentAadMismatchArb, textArb, fillArb, async ({ original, mutated }, plaintext, fill) => {
        const key = await keyFrom(fill)
        const envelope = await seal(key, plaintext, contentAad(...original))
        await expect(open(key, envelope, contentAad(...mutated))).rejects.toThrow()
      }),
      fuzzParams(30),
    )
  })

  it('bytes: assetBytesAad, one field differs (aad.ts:60-64)', async () => {
    await fc.assert(
      fc.asyncProperty(
        assetBytesAadMismatchArb,
        bytesArb,
        fillArb,
        async ({ original, mutated }, plaintext, fill) => {
          const key = await keyFrom(fill)
          const sealed = await sealBytes(key, plaintext, assetBytesAad(...original))
          await expect(openBytes(key, sealed, assetBytesAad(...mutated))).rejects.toThrow()
        },
      ),
      fuzzParams(30),
    )
  })
})

// ════════════════════════════════════════════════════════════════════════
// Wrong key
// ════════════════════════════════════════════════════════════════════════

describe('wrong key rejects (aead.ts:35-36)', () => {
  it('text', async () => {
    await fc.assert(
      fc.asyncProperty(textArb, contentAadTupleArb, distinctFillPairArb, async (plaintext, aadFields, fills) => {
        const [fillA, fillB] = fills
        const aad = contentAad(...aadFields)
        const envelope = await seal(await keyFrom(fillA), plaintext, aad)
        await expect(open(await keyFrom(fillB), envelope, aad)).rejects.toThrow()
      }),
      fuzzParams(25),
    )
  })

  it('bytes', async () => {
    await fc.assert(
      fc.asyncProperty(bytesArb, assetBytesAadTupleArb, distinctFillPairArb, async (plaintext, aadFields, fills) => {
        const [fillA, fillB] = fills
        const aad = assetBytesAad(...aadFields)
        const sealed = await sealBytes(await keyFrom(fillA), plaintext, aad)
        await expect(openBytes(await keyFrom(fillB), sealed, aad)).rejects.toThrow()
      }),
      fuzzParams(25),
    )
  })
})

// ════════════════════════════════════════════════════════════════════════
// validateCanary (canary.ts)
// ════════════════════════════════════════════════════════════════════════

describe('validateCanary: totality + correctness (canary.ts:22-33)', () => {
  it('true for a canary minted and validated by the same key + workspace id', async () => {
    await fc.assert(
      fc.asyncProperty(fieldArb, fillArb, async (workspaceId, fill) => {
        const key = await keyFrom(fill)
        const canary = await mintCanary(key, workspaceId)
        expect(await validateCanary(key, canary, workspaceId)).toBe(true)
      }),
      fuzzParams(25),
    )
  })

  it('false, never throws, for a wrong key', async () => {
    await fc.assert(
      fc.asyncProperty(fieldArb, distinctFillPairArb, async (workspaceId, fills) => {
        const [mintFill, wrongFill] = fills
        const canary = await mintCanary(await keyFrom(mintFill), workspaceId)
        expect(await validateCanary(await keyFrom(wrongFill), canary, workspaceId)).toBe(false)
      }),
      fuzzParams(25),
    )
  })

  it('false, never throws, for an arbitrary junk string (canary.ts:27-32 try/catch)', async () => {
    // Exercises decodeEnvelope's format guards (missing prefix / undersized
    // payload / bad base64url) all bubbling into the catch, not GCM itself.
    await fc.assert(
      fc.asyncProperty(fieldArb, fieldArb, fillArb, async (junk, workspaceId, fill) => {
        const key = await keyFrom(fill)
        expect(await validateCanary(key, junk, workspaceId)).toBe(false)
      }),
      fuzzParams(25),
    )
  })

  it('false, never throws, for a well-formed but tampered real canary', async () => {
    // A well-formed envelope whose ciphertext‖tag has one flipped byte:
    // decodeEnvelope succeeds, so this exercises the GCM-failure branch of
    // the same try/catch (canary.ts:27-32), not the format guards.
    await fc.assert(
      fc.asyncProperty(fieldArb, fillArb, fc.nat(), async (workspaceId, fill, idxRaw) => {
        const key = await keyFrom(fill)
        const canary = await mintCanary(key, workspaceId)
        const { nonce, ciphertext } = decodeEnvelope(canary)
        const tampered = Uint8Array.from(ciphertext)
        tampered[idxRaw % tampered.length] ^= 0x01
        const tamperedCanary = encodeEnvelope(nonce, tampered)
        expect(await validateCanary(key, tamperedCanary, workspaceId)).toBe(false)
      }),
      fuzzParams(25),
    )
  })
})
