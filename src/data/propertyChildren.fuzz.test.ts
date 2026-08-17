// @vitest-environment node
/**
 * Fuzz suite for `src/data/propertyChildren.ts`'s pure codec-boundary
 * functions — `propertyValueToChildContent` / `propertyChildContentToEncodedValue`
 * (the property-value ↔ child-content translation, PR #288 §7) across the
 * property-type zoo, plus the null-sentinel escaping guard (`needsEscape`,
 * propertyChildren.ts:136-149) it protects. See docs/fuzzing.md for tier
 * mechanics; `src/data/propertyChildren.test.ts` is the example-based
 * corpus for the surrounding dual-write/materialize machinery.
 *
 * Oracles, grounded in propertyChildren.ts:
 *  - Round trip: for a value V in a codec's documented domain,
 *    `propertyValueToChildContent` renders V to child content and
 *    `propertyChildContentToEncodedValue` must recover the SAME canonical
 *    encoded form `schema.codec.encode(V)` (:243-286). This is exactly the
 *    dual-write/materialize contract (`writePropertyValueChild`,
 *    `materializePropertyChildrenForExistingRow`): the child holds the
 *    property's value, and PROJECT reconstructs the cell from it.
 *  - Null-sentinel guard (:126-149, :151-153): content === the bare string
 *    `'null'` if and only if the encoded value is `null` AND the codec
 *    accepts null on decode (`codecAcceptsNull`). An absence-aware
 *    string-family codec (`optionalString`) that stores the LITERAL string
 *    `"null"` (or a JSON-quoted string that unescapes to it) must escape via
 *    `JSON.stringify` so it can never collide with the sentinel. A
 *    NON-absence-aware string-family codec (`codecs.string` /
 *    `codecs.url`) never needs escaping — `codecAcceptsNull` is false, so
 *    `needsEscape` short-circuits and content is always verbatim.
 *  - Enum leniency (:261-286): a value outside the CURRENT option set still
 *    round-trips through content (`decode` is lenient on membership,
 *    codecs.ts:255-259) but is kept in its DECODED form rather than
 *    re-encoded, because `encode`/`where` would reject it — documented in
 *    the try/catch at propertyChildren.ts:271-285.
 *  - Ref addressing (:154-173, :213-225): a non-empty ref value renders as
 *    an editable `((id))` span and reads back via the CALLER-SUPPLIED
 *    `referenceTargetId` (the derived column), not by re-parsing content.
 *    An empty ref (`codecs.ref`'s "cleared" encoding, :172) renders as
 *    empty content and is NOT independently re-decodable (no id to derive
 *    from) — the documented "property reads as unset" lossy path (:162-171
 *    the "empty ref is not a reference" comment), not a round-trip failure.
 *  - Number blank-content guard (:88-100): empty/whitespace-only content is
 *    unparseable (reserved for `undefined`, never a stored zero) and must
 *    throw `CodecError`, not silently decode to 0.
 */
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { fuzzParams } from '@/test/fuzz'
import { ChangeScope, CodecError, codecs, defineProperty } from '@/data/api'
import { propertyChildContentToEncodedValue, propertyValueToChildContent } from './propertyChildren'

// ──── schemas under test, one per codec family ────

const requiredStringSchema = defineProperty<string>('s', {
  codec: codecs.string, defaultValue: '', changeScope: ChangeScope.BlockDefault,
})
const urlSchema = defineProperty<string>('u', {
  codec: codecs.url, defaultValue: '', changeScope: ChangeScope.BlockDefault,
})
const optionalStringSchema = defineProperty<string | undefined>('os', {
  codec: codecs.optionalString, defaultValue: undefined, changeScope: ChangeScope.BlockDefault,
})
const dateSchema = defineProperty<Date | undefined>('d', {
  codec: codecs.date, defaultValue: undefined, changeScope: ChangeScope.BlockDefault,
})
const numberSchema = defineProperty<number>('n', {
  codec: codecs.number, defaultValue: 0, changeScope: ChangeScope.BlockDefault,
})
const booleanSchema = defineProperty<boolean>('b', {
  codec: codecs.boolean, defaultValue: false, changeScope: ChangeScope.BlockDefault,
})
const refSchema = defineProperty<string>('r', {
  codec: codecs.ref(), defaultValue: '', changeScope: ChangeScope.BlockDefault,
})
const enumOptions = ['open', 'done', 'archived'] as const
const enumSchema = defineProperty<typeof enumOptions[number]>('e', {
  codec: codecs.enum([...enumOptions]), defaultValue: 'open', changeScope: ChangeScope.BlockDefault,
})

// A block-ref-safe id alphabet: no whitespace/parens (RENDERABLE_BLOCK_REF_ID_RE,
// referenceBlock.ts:23) and no dashes, so it can never accidentally take UUID
// shape and trip the separate case-canonicalization round-trip check
// (referenceBlock.ts:111-127) — out of scope here, that guard belongs to
// `referenceBlockContentForId`'s own suite, not this codec-boundary one.
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'
const idArb = fc.array(fc.constantFrom(...ID_ALPHABET), {minLength: 1, maxLength: 24})
  .map(chars => chars.join(''))

describe('round trip: propertyChildContentToEncodedValue(propertyValueToChildContent(v)) recovers encode(v)', () => {
  it('string (required): any string is verbatim content (codec never accepts null, so escaping never engages)', () => {
    fc.assert(
      fc.property(fc.string(), v => {
        const content = propertyValueToChildContent(requiredStringSchema, v)
        expect(content).toBe(v)
        expect(propertyChildContentToEncodedValue(requiredStringSchema, content)).toBe(v)
      }),
      fuzzParams(150),
    )
  })

  it('url: any string is verbatim content (same non-absence-aware shape as required string)', () => {
    fc.assert(
      fc.property(fc.string(), v => {
        const content = propertyValueToChildContent(urlSchema, v)
        expect(content).toBe(v)
        expect(propertyChildContentToEncodedValue(urlSchema, content)).toBe(v)
      }),
      fuzzParams(150),
    )
  })

  it('optionalString: round-trips through content; content === "null" iff the value is undefined', () => {
    fc.assert(
      fc.property(fc.option(fc.string(), {nil: undefined}), v => {
        const content = propertyValueToChildContent(optionalStringSchema, v)
        expect(content === 'null').toBe(v === undefined)
        expect(propertyChildContentToEncodedValue(optionalStringSchema, content))
          .toBe(optionalStringSchema.codec.encode(v))
      }),
      fuzzParams(200),
    )
  })

  it('date: round-trips through content; content === "null" iff the value is undefined', () => {
    fc.assert(
      fc.property(fc.option(fc.date({noInvalidDate: true}), {nil: undefined}), v => {
        const content = propertyValueToChildContent(dateSchema, v)
        expect(content === 'null').toBe(v === undefined)
        expect(propertyChildContentToEncodedValue(dateSchema, content))
          .toBe(dateSchema.codec.encode(v))
      }),
      fuzzParams(150),
    )
  })

  it('number: round-trips via String()/Number() (lossless for any finite double)', () => {
    const finiteArb = fc.double({noNaN: true, noDefaultInfinity: true}).filter(n => !Object.is(n, -0))
    fc.assert(
      fc.property(finiteArb, v => {
        const content = propertyValueToChildContent(numberSchema, v)
        expect(content).toBe(String(v))
        expect(propertyChildContentToEncodedValue(numberSchema, content)).toBe(v)
      }),
      fuzzParams(150),
    )
  })

  it('boolean: round-trips via String()', () => {
    fc.assert(
      fc.property(fc.boolean(), v => {
        const content = propertyValueToChildContent(booleanSchema, v)
        expect(content).toBe(String(v))
        expect(propertyChildContentToEncodedValue(booleanSchema, content)).toBe(v)
      }),
      fuzzParams(100),
    )
  })

  it('ref: a non-empty id renders as an editable ((id)) span and reads the id back out of it', () => {
    fc.assert(
      fc.property(idArb, id => {
        const content = propertyValueToChildContent(refSchema, id)
        expect(content).toBe(`((${id}))`)
        // The decode parses the span rather than reading the derived column
        // (#443 group 3), so this is a genuine round trip through one string
        // and the fuzz has no second input to keep consistent with it.
        expect(propertyChildContentToEncodedValue(refSchema, content)).toBe(id)
      }),
      fuzzParams(150),
    )
  })

  // The forms the decode must REFUSE, fuzzed over the same id alphabet: a
  // whole-block wikilink (a name, not an identity — `reference_target_id`
  // stamps for it and used to make it decode) and the `::`-marked span (a
  // field row, not a value). Refusing means the row keeps its text and the
  // owner's cell key reads unset, never re-pointed at a name's target.
  it('ref: rejects the name form and the marked form for every id', () => {
    fc.assert(
      fc.property(idArb, id => {
        expect(() => propertyChildContentToEncodedValue(refSchema, `[[${id}]]`))
          .toThrow(CodecError)
        expect(() => propertyChildContentToEncodedValue(refSchema, `::((${id}))`))
          .toThrow(CodecError)
      }),
      fuzzParams(150),
    )
  })

  it('enum: a current-option value round-trips through JSON content (the default/json codec branch)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...enumOptions), v => {
        const content = propertyValueToChildContent(enumSchema, v)
        expect(content).toBe(JSON.stringify(v))
        expect(propertyChildContentToEncodedValue(enumSchema, content)).toBe(v)
      }),
      fuzzParams(100),
    )
  })
})

describe('null-sentinel escaping (needsEscape, propertyChildren.ts:126-149)', () => {
  it('optionalString: a string value that IS the sentinel, or unwraps to it, is JSON-escaped and never mistaken for absence', () => {
    for (const v of ['null', '"null"', '""null""', ' null ']) {
      const content = propertyValueToChildContent(optionalStringSchema, v)
      expect(content, `value ${JSON.stringify(v)}`).not.toBe('null')
      expect(propertyChildContentToEncodedValue(optionalStringSchema, content))
        .toBe(optionalStringSchema.codec.encode(v))
    }
  })

  it('required string: the literal "null" needs no escaping (codec never accepts null, so there is no sentinel to protect)', () => {
    const content = propertyValueToChildContent(requiredStringSchema, 'null')
    expect(content).toBe('null')
    expect(propertyChildContentToEncodedValue(requiredStringSchema, content)).toBe('null')
  })
})

describe('enum leniency: a retired option decodes but is not re-canonicalized (propertyChildren.ts:271-285)', () => {
  it('a value stored before its option was removed still decodes, kept AS-IS rather than re-encoded', () => {
    const content = JSON.stringify('retired-option')
    // decode is lenient (only checks it's a string, codecs.ts:255-259); encode
    // would reject it (not a current member) — the fallback in
    // propertyChildContentToEncodedValue keeps the decoded value verbatim
    // instead of throwing or dropping it.
    expect(propertyChildContentToEncodedValue(enumSchema, content)).toBe('retired-option')
  })
})

describe('ref: the empty/cleared value is a documented non-round-trip', () => {
  it('renders as empty content, and empty content alone is not decodable (no span to read an id from)', () => {
    const content = propertyValueToChildContent(refSchema, '')
    expect(content).toBe('')
    expect(() => propertyChildContentToEncodedValue(refSchema, content)).toThrow(CodecError)
  })
})

describe('number: blank content is unparseable, never a silent zero (propertyChildren.ts:88-100)', () => {
  it('empty and whitespace-only content throw CodecError', () => {
    for (const content of ['', '   ', '\t\n']) {
      expect(() => propertyChildContentToEncodedValue(numberSchema, content), `content ${JSON.stringify(content)}`)
        .toThrow(CodecError)
    }
  })
})
