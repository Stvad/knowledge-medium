// @vitest-environment node
/**
 * Fuzz suite for `src/data/api/codecs.ts` — see `src/test/fuzz.ts` for the
 * smoke/deep tier mechanics.
 *
 * Oracles:
 *  - Round-trip on each codec's documented valid-value domain:
 *    `decode(encode(v))` deep-equals `v`, or the code's own canonicalization
 *    where one is documented (dateCodec's ISO round-trip is lossless;
 *    `optionalRef` collapses `''` to `undefined` on the way through — cited
 *    at each site below).
 *  - Strict-decode totality: `decode` on arbitrary JSON-shaped junk either
 *    returns or throws *only* `CodecError` (never a raw `TypeError` /
 *    `RangeError` from an un-guarded property access) — every codec in
 *    `codecs.ts` type-checks its input before touching it, so this should
 *    hold unconditionally.
 *  - Lenient-path totality: `decodeRefId`, `decodeRefListIds`, and
 *    `refList().decodeValid` are documented (codecs.ts:295-317) to never
 *    throw, by design — a throw here is exactly the historical #189 failure
 *    mode (one malformed element aborting a block's whole reference
 *    projection).
 *  - `refList().decodeValid`'s output is derived by running each array
 *    element through `stringCodec.decode` (which accepts any string, no
 *    further validation — codecs.ts:85-98) and keeping only the ones that
 *    don't throw (codecs.ts:204-218). For an array input, that's exactly
 *    "keep the string elements, in order, drop the rest" — verified as an
 *    exact-match oracle, which implies the requested subset property.
 *
 * `unsafeIdentity` / `optionalIdentity` are deliberately excluded: they
 * validate nothing (codecs.ts:339-343, 388-392), so they have no "valid
 * domain" narrower than "any JS value" and no decode failure mode to probe.
 */
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { fuzzParams } from '@/test/fuzz'
import { codecs, CodecError, decodeRefId, decodeRefListIds } from './codecs'

// ──── Junk domain for the totality oracles ────
//
// A mix of well-formed JSON values, numeric edge cases that JSON itself
// can't represent (NaN/Infinity — reachable via a non-JSON caller, e.g. a
// plugin passing a live JS value straight through), deeply nested arrays,
// and strings that look like dates/UUIDs but are one character off — the
// classes of input most likely to slip past a sloppy type guard.
const hugeNumberArb = fc.constantFrom(
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
  1e308,
  -1e308,
)

const deepArrayArb = fc.array(
  fc.array(fc.array(fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)), {maxLength: 3}), {maxLength: 3}),
  {maxLength: 3},
)

const almostDateArb = fc.oneof(
  fc.date({noInvalidDate: true}).map(d => d.toISOString().replace('Z', '')), // missing tz
  fc.date({noInvalidDate: true}).map(d => d.toISOString().slice(0, -1)), // truncated
  fc.constantFrom('2023-13-40T00:00:00.000Z', '2023-02-30T00:00:00.000Z', 'not-a-date', ''),
)

const almostUuidArb = fc.uuid().chain(u =>
  fc.constantFrom(u.slice(0, -1), `${u}x`, u.replace(/-/g, ''), u.toUpperCase()),
)

const junkArb = fc.oneof(
  {arbitrary: fc.jsonValue({maxDepth: 3}), weight: 6},
  {arbitrary: hugeNumberArb, weight: 2},
  {arbitrary: deepArrayArb, weight: 1},
  {arbitrary: almostDateArb, weight: 1},
  {arbitrary: almostUuidArb, weight: 1},
)

const assertDecodeTotal = (decode: (json: unknown) => unknown) =>
  fc.property(junkArb, json => {
    try {
      decode(json)
    } catch (e) {
      expect(e).toBeInstanceOf(CodecError)
    }
  })

describe('strict decode: total (returns or throws only CodecError)', () => {
  it('string', () => {
    fc.assert(assertDecodeTotal(j => codecs.string.decode(j)), fuzzParams(150))
  })
  it('number', () => {
    fc.assert(assertDecodeTotal(j => codecs.number.decode(j)), fuzzParams(150))
  })
  it('boolean', () => {
    fc.assert(assertDecodeTotal(j => codecs.boolean.decode(j)), fuzzParams(150))
  })
  it('date', () => {
    fc.assert(assertDecodeTotal(j => codecs.date.decode(j)), fuzzParams(150))
  })
  it('url', () => {
    fc.assert(assertDecodeTotal(j => codecs.url.decode(j)), fuzzParams(150))
  })
  it('enum', () => {
    const codec = codecs.enum(['open', 'done', 'archived'])
    fc.assert(assertDecodeTotal(j => codec.decode(j)), fuzzParams(150))
  })
  it('list(number)', () => {
    const codec = codecs.list(codecs.number)
    fc.assert(assertDecodeTotal(j => codec.decode(j)), fuzzParams(150))
  })
  it('ref', () => {
    const codec = codecs.ref({targetTypes: ['project']})
    fc.assert(assertDecodeTotal(j => codec.decode(j)), fuzzParams(150))
  })
  it('optionalRef', () => {
    const codec = codecs.optionalRef({targetTypes: ['project']})
    fc.assert(assertDecodeTotal(j => codec.decode(j)), fuzzParams(150))
  })
  it('refList', () => {
    const codec = codecs.refList({targetTypes: ['task']})
    fc.assert(assertDecodeTotal(j => codec.decode(j)), fuzzParams(150))
  })
  it('optionalString', () => {
    fc.assert(assertDecodeTotal(j => codecs.optionalString.decode(j)), fuzzParams(150))
  })
  it('optionalNumber', () => {
    fc.assert(assertDecodeTotal(j => codecs.optionalNumber.decode(j)), fuzzParams(150))
  })
})

// ──── Round-trip on the documented valid-value domain ────

describe('round-trip: decode(encode(v)) on the valid domain', () => {
  it('string: any string', () => {
    fc.assert(
      fc.property(fc.string(), v => {
        expect(codecs.string.decode(codecs.string.encode(v))).toBe(v)
      }),
      fuzzParams(150),
    )
  })

  it('number: any finite number', () => {
    // Exclude -0: `toEqual`/`toBe` treat -0 and 0 as distinct under
    // Object.is-style checks in some matchers, and the codec has no
    // opinion on the sign of zero either way — avoid a spurious mismatch
    // that says nothing about the codec.
    const finiteArb = fc.double({noNaN: true, noDefaultInfinity: true}).filter(n => !Object.is(n, -0))
    fc.assert(
      fc.property(finiteArb, v => {
        expect(codecs.number.decode(codecs.number.encode(v))).toBe(v)
      }),
      fuzzParams(150),
    )
  })

  it('boolean', () => {
    fc.assert(
      fc.property(fc.boolean(), v => {
        expect(codecs.boolean.decode(codecs.boolean.encode(v))).toBe(v)
      }),
      fuzzParams(150),
    )
  })

  it('date: any Date or undefined round-trips via ISO string (lossless — codecs.ts:134-167)', () => {
    const dateOrUndefinedArb = fc.option(fc.date({noInvalidDate: true}), {nil: undefined})
    fc.assert(
      fc.property(dateOrUndefinedArb, v => {
        const decoded = codecs.date.decode(codecs.date.encode(v))
        if (v === undefined) {
          expect(decoded).toBeUndefined()
        } else {
          expect(decoded?.getTime()).toBe(v.getTime())
        }
      }),
      fuzzParams(150),
    )
  })

  it('url: any string (codec does no real URL validation — codecs.ts:319-331)', () => {
    fc.assert(
      fc.property(fc.string(), v => {
        expect(codecs.url.decode(codecs.url.encode(v))).toBe(v)
      }),
      fuzzParams(150),
    )
  })

  it('enum: any member of the fixed option set', () => {
    const codec = codecs.enum(['compact', 'cozy', 'comfortable'])
    fc.assert(
      fc.property(fc.constantFrom('compact', 'cozy', 'comfortable'), v => {
        expect(codec.decode(codec.encode(v))).toBe(v)
      }),
      fuzzParams(100),
    )
  })

  it('list(number): arrays of finite numbers', () => {
    const codec = codecs.list(codecs.number)
    const finiteArb = fc.double({noNaN: true, noDefaultInfinity: true}).filter(n => !Object.is(n, -0))
    fc.assert(
      fc.property(fc.array(finiteArb, {maxLength: 15}), v => {
        expect(codec.decode(codec.encode(v))).toEqual(v)
      }),
      fuzzParams(150),
    )
  })

  it('ref: any string target id', () => {
    const codec = codecs.ref({targetTypes: ['project']})
    fc.assert(
      fc.property(fc.string(), v => {
        expect(codec.decode(codec.encode(v))).toBe(v)
      }),
      fuzzParams(150),
    )
  })

  it('optionalRef: any string or undefined, with the documented \'\' → undefined collapse (codecs.ts:191-193)', () => {
    const codec = codecs.optionalRef({targetTypes: ['project']})
    const valueArb = fc.option(fc.string(), {nil: undefined})
    fc.assert(
      fc.property(valueArb, v => {
        const decoded = codec.decode(codec.encode(v))
        const expected = v === '' ? undefined : v
        expect(decoded).toBe(expected)
      }),
      fuzzParams(150),
    )
  })

  it('refList: arrays of strings', () => {
    const codec = codecs.refList({targetTypes: ['task']})
    fc.assert(
      fc.property(fc.array(fc.string(), {maxLength: 15}), v => {
        expect(codec.decode(codec.encode(v))).toEqual(v)
      }),
      fuzzParams(150),
    )
  })

  it('optionalString: any string or undefined (no canonicalization — codecs.ts:350-365)', () => {
    const valueArb = fc.option(fc.string(), {nil: undefined})
    fc.assert(
      fc.property(valueArb, v => {
        expect(codecs.optionalString.decode(codecs.optionalString.encode(v))).toBe(v)
      }),
      fuzzParams(150),
    )
  })

  it('optionalNumber: any finite number or undefined', () => {
    const finiteArb = fc.double({noNaN: true, noDefaultInfinity: true}).filter(n => !Object.is(n, -0))
    const valueArb = fc.option(finiteArb, {nil: undefined})
    fc.assert(
      fc.property(valueArb, v => {
        expect(codecs.optionalNumber.decode(codecs.optionalNumber.encode(v))).toBe(v)
      }),
      fuzzParams(150),
    )
  })
})

// ──── Lenient paths: never throw, by design ────

describe('lenient paths never throw', () => {
  it('decodeRefId (ref)', () => {
    const codec = codecs.ref({targetTypes: ['project']})
    fc.assert(
      fc.property(junkArb, j => {
        expect(() => decodeRefId(codec, j)).not.toThrow()
      }),
      fuzzParams(150),
    )
  })

  it('decodeRefId (optionalRef)', () => {
    const codec = codecs.optionalRef({targetTypes: ['project']})
    fc.assert(
      fc.property(junkArb, j => {
        expect(() => decodeRefId(codec, j)).not.toThrow()
      }),
      fuzzParams(150),
    )
  })

  it('decodeRefListIds', () => {
    const codec = codecs.refList({targetTypes: ['task']})
    fc.assert(
      fc.property(junkArb, j => {
        expect(() => decodeRefListIds(codec, j)).not.toThrow()
      }),
      fuzzParams(150),
    )
  })

  it("refList().decodeValid", () => {
    const codec = codecs.refList({targetTypes: ['task']})
    fc.assert(
      fc.property(junkArb, j => {
        expect(() => codec.decodeValid!(j)).not.toThrow()
      }),
      fuzzParams(150),
    )
  })
})

describe('refList().decodeValid: exact recoverable-ids contract (codecs.ts:204-218)', () => {
  // Mixed-shape array elements — strings (recoverable via stringCodec,
  // which accepts any string), and assorted non-strings that
  // stringCodec.decode rejects and decodeValid drops.
  const elementArb = fc.oneof(
    fc.string({maxLength: 10}),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.constant(undefined),
    fc.object({maxDepth: 1}),
    fc.array(fc.string({maxLength: 5}), {maxLength: 3}),
  )

  it('output equals exactly the string elements, in order (implies the subset property)', () => {
    const codec = codecs.refList()
    fc.assert(
      fc.property(fc.array(elementArb, {maxLength: 12}), arr => {
        const out = codec.decodeValid!(arr)
        const expected = arr.filter((x): x is string => typeof x === 'string')
        expect(out).toEqual(expected)
        // Every recovered id was actually present in the input.
        for (const id of out) expect(arr).toContain(id)
      }),
      fuzzParams(150),
    )
  })

  it('non-array input yields []', () => {
    const codec = codecs.refList()
    const nonArrayArb = junkArb.filter(j => !Array.isArray(j))
    fc.assert(
      fc.property(nonArrayArb, j => {
        expect(codec.decodeValid!(j)).toEqual([])
      }),
      fuzzParams(100),
    )
  })
})
