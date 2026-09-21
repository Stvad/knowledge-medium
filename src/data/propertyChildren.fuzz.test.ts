// @vitest-environment node
/**
 * Fuzz suite for `src/data/propertyChildren.ts`'s pure codec-boundary
 * functions — `propertyValueToChildContent` / `valueChildContentToEncoded`
 * (the property-value ↔ child-content translation, docs/properties-as-blocks-migration.html §7) across the
 * property-type zoo, plus the content-escaping guard (`needsEscape`) it
 * protects. See docs/fuzzing.md for tier mechanics;
 * `src/data/propertyChildren.test.ts` is the example-based corpus for the
 * surrounding dual-write/materialize machinery.
 *
 * Oracles, grounded in propertyChildren.ts:
 *  - Round trip: for a value V in a codec's documented domain,
 *    `propertyValueToChildContent` renders V to child content and
 *    `valueChildContentToEncoded` must recover the SAME canonical
 *    encoded form `schema.codec.encode(V)`. This is exactly the
 *    dual-write/materialize contract (`writePropertyValueChild`,
 *    `materializePropertyChildrenForExistingRow`): the child holds the
 *    property's value, and PROJECT reconstructs the cell from it.
 *  - Escaping guard (`needsEscape`): a verbatim string-family value that
 *    content cannot hold AS ITSELF is stored `JSON.stringify`-escaped, so it
 *    reads back as the value rather than as whatever the layers below content
 *    make of it. Three reasons, and the sentinel one alone is codec-dependent:
 *    content === the bare string `'null'` iff the encoded value is `null` AND
 *    the codec accepts null on decode (`codecAcceptsNull`), so an
 *    absence-aware codec (`optionalString`) escapes the LITERAL string
 *    `"null"` while `codecs.string` / `codecs.url` store it as itself. The
 *    other two — reference-shaped content and ill-formed UTF-16 (#688) — hold
 *    for EVERY string-family codec, and are stated as an output invariant in
 *    the "#688" describe below rather than as a per-value expectation.
 *  - Enum membership and spelling: an option value is spelled PLAINLY and
 *    reads back, in either spelling — the JSON one every value child was
 *    written with before #1080 still reads, with no migration. A value
 *    OUTSIDE the current option set is refused whichever way it is spelled,
 *    which is the `encode`-side check `decode` deliberately omits (#1088);
 *    a value that would be misread verbatim is escaped instead.
 *  - Ref addressing: a non-empty ref value renders as
 *    an editable `((id))` span and reads back via the CALLER-SUPPLIED
 *    `referenceTargetId` (the derived column), not by re-parsing content.
 *    An empty ref (`codecs.ref`'s "cleared" encoding) renders as
 *    empty content and is NOT independently re-decodable (no id to derive
 *    from) — the documented "property reads as unset" lossy path (the "empty ref is not a reference" comment), not a round-trip failure.
 *  - Number blank-content guard: empty/whitespace-only content is
 *    unparseable (reserved for `undefined`, never a stored zero) and must
 *    throw `CodecError`, not silently decode to 0.
 */
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { fuzzParams } from '@/test/fuzz'
import { utf16UnitArb } from '@/test/arbitraries/utf16'
import { ChangeScope, CodecError, codecs, defineProperty, type PropertySchema } from '@/data/api'
import {
  childContentsToEncodedPropertyValue,
  encodedPropertyValueToChildContents,
  encodedToValueChildContent,
  valueChildContentToEncoded,
} from './propertyChildren'
import { kernelValuePresetCoresById } from './kernelValuePresetCores'
import { parseExactReferenceBlockContent } from './referenceBlock'
// Tests are exempt from `boundary/no-core-to-plugin-imports`, and the inline
// parser is the other reader this content must be inert to.
import { parseReferences } from '@/plugins/references/referenceParser'

/** One scalar value's child content. Every schema in this file is
 *  single-valued, so grain and property value are the same thing here. */
const propertyValueToChildContent = <T>(
  schema: PropertySchema<T>,
  value: T,
): string => encodedToValueChildContent(schema, schema.codec.encode(value))

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

/** A synthetic block id — all-2s, plainly not a real graph id; it only has
 *  to be UUID-shaped so the span forms below parse. */
const SAMPLE_UUID = '22222222-2222-4222-8222-222222222222'

// A block-ref-safe id alphabet: no whitespace/parens (`RENDERABLE_BLOCK_REF_ID_RE`) and no dashes, so it can never accidentally take UUID
// shape and trip the separate case-canonicalization round-trip check
// in `referenceBlockContentForId` — out of scope here, that guard belongs to
// `referenceBlockContentForId`'s own suite, not this codec-boundary one.
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'
const idArb = fc.array(fc.constantFrom(...ID_ALPHABET), {minLength: 1, maxLength: 24})
  .map(chars => chars.join(''))

/** The value zoo: random UTF-16 built from single code units, so it carries the
 *  unpaired surrogates that are one of the two shapes the content column cannot
 *  hold as itself (#688); ordinary text; and hand-written grammar-shaped
 *  seeds — the span forms are far too structured for random generation to
 *  reach. */
const textArb = fc.oneof(
  fc.string({unit: utf16UnitArb, maxLength: 12}),
  fc.string(),
  fc.constantFrom(
    `::((${SAMPLE_UUID}))`,
    `((${SAMPLE_UUID}))`,
    '[[Some Page]]',
    '::[[Some Page]]',
    `[Mary](((${SAMPLE_UUID})))`,
    // Spans embedded in PROSE — never escaped, so these drive the verbatim
    // leg of the invariant above rather than the envelope leg.
    'See [[Roadmap]] for the plan',
    `context: ((${SAMPLE_UUID})) and trailing text`,
    'null',
    '"null"',
    `"::((${SAMPLE_UUID}))"`,
  ),
)

describe('round trip: valueChildContentToEncoded(propertyValueToChildContent(v)) recovers encode(v)', () => {
  it('string (required): any string round-trips through content', () => {
    fc.assert(
      fc.property(textArb, v => {
        const content = propertyValueToChildContent(requiredStringSchema, v)
        expect(valueChildContentToEncoded(requiredStringSchema, content)).toBe(v)
      }),
      fuzzParams(150),
    )
  })

  it('url: any string round-trips through content (same verbatim-family shape as required string)', () => {
    fc.assert(
      fc.property(textArb, v => {
        const content = propertyValueToChildContent(urlSchema, v)
        expect(valueChildContentToEncoded(urlSchema, content)).toBe(v)
      }),
      fuzzParams(150),
    )
  })

  it('optionalString: round-trips through content; content === "null" iff the value is undefined', () => {
    fc.assert(
      fc.property(fc.option(textArb, {nil: undefined}), v => {
        const content = propertyValueToChildContent(optionalStringSchema, v)
        expect(content === 'null').toBe(v === undefined)
        expect(valueChildContentToEncoded(optionalStringSchema, content))
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
        expect(valueChildContentToEncoded(dateSchema, content))
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
        expect(valueChildContentToEncoded(numberSchema, content)).toBe(v)
      }),
      fuzzParams(150),
    )
  })

  it('boolean: round-trips via String()', () => {
    fc.assert(
      fc.property(fc.boolean(), v => {
        const content = propertyValueToChildContent(booleanSchema, v)
        expect(content).toBe(String(v))
        expect(valueChildContentToEncoded(booleanSchema, content)).toBe(v)
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
        expect(valueChildContentToEncoded(refSchema, content)).toBe(id)
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
        expect(() => valueChildContentToEncoded(refSchema, `[[${id}]]`))
          .toThrow(CodecError)
        expect(() => valueChildContentToEncoded(refSchema, `::((${id}))`))
          .toThrow(CodecError)
      }),
      fuzzParams(150),
    )
  })

  it('enum: a current-option value is spelled plainly and reads back (#1080)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...enumOptions), v => {
        const content = propertyValueToChildContent(enumSchema, v)
        expect(content).toBe(v)
        expect(valueChildContentToEncoded(enumSchema, content)).toBe(v)
        // And the spelling these children were written with before still
        // reads, so nothing has to be migrated off it.
        expect(valueChildContentToEncoded(enumSchema, JSON.stringify(v))).toBe(v)
      }),
      fuzzParams(100),
    )
  })
})

describe('null-sentinel escaping (needsEscape)', () => {
  it('optionalString: a string value that IS the sentinel, or unwraps to it, is JSON-escaped and never mistaken for absence', () => {
    for (const v of ['null', '"null"', '""null""', ' null ']) {
      const content = propertyValueToChildContent(optionalStringSchema, v)
      expect(content, `value ${JSON.stringify(v)}`).not.toBe('null')
      expect(valueChildContentToEncoded(optionalStringSchema, content))
        .toBe(optionalStringSchema.codec.encode(v))
    }
  })

  it('required string: the literal "null" needs no escaping (codec never accepts null, so there is no sentinel to protect)', () => {
    const content = propertyValueToChildContent(requiredStringSchema, 'null')
    expect(content).toBe('null')
    expect(valueChildContentToEncoded(requiredStringSchema, content)).toBe('null')
  })
})

/**
 * The escape's OUTPUT invariant, and the one that fails on #688's bug: what a
 * string value renders to must be storable and readable as text. Stated over
 * the content rather than over the round trip because the round trip is a
 * function of `propertyChildren.ts` alone, while the loss happened OUTSIDE
 * it — `deriveReferenceColumns` classified the content and the projection's
 * value-set filter dropped the row. Anything the parser reads as a span, or
 * that carries a lone surrogate, is content this module has handed to those
 * layers as machinery instead of as a value.
 */
describe('#688: content is always storable text, never a span and never ill-formed', () => {
  /** The `isWellFormed` predicate, restated here rather than imported: the
   *  suite must be able to fail when the module's own copy is wrong. */
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

  it.each([
    ['string', requiredStringSchema],
    ['url', urlSchema],
    ['optionalString', optionalStringSchema],
  ])('%s: content is the value verbatim, or an envelope inert to both readers', (_name, schema) => {
    fc.assert(
      fc.property(textArb, v => {
        const content = propertyValueToChildContent(schema as typeof requiredStringSchema, v)
        if (content !== v) {
          // ESCAPED — inert to BOTH readers of the grammar, not just the
          // whole-block one. Quoting stops only that reader, and the inline
          // parser scans spans anywhere, so a merely-quoted `"[[Page]]"` was
          // still a live reference that a rename could rewrite.
          expect(parseExactReferenceBlockContent(content)).toBeNull()
          expect(parseReferences(content)).toEqual([])
        } else {
          // VERBATIM — legitimate only if the WHOLE-BLOCK reader, the one that
          // classifies a row as machinery, sees nothing. A span embedded in
          // prose is left verbatim and does still index inline (#756): whether
          // a property value may carry a live reference is a design question,
          // not a misread, so this leg deliberately does not assert it away.
          expect(parseExactReferenceBlockContent(content)).toBeNull()
        }
        // Ill-formed text survives neither path, so this holds either way.
        expect(LONE_SURROGATE.test(content)).toBe(false)
      }),
      fuzzParams(300),
    )
  })

  // Injectivity: the escape must not map two distinct values onto one content,
  // or one of them is unrecoverable no matter how the decode is written. The
  // nesting recursion in `needsEscape` is what buys this.
  it('distinct values never collide on the same content', () => {
    fc.assert(
      fc.property(textArb, textArb, (a, b) => {
        fc.pre(a !== b)
        expect(propertyValueToChildContent(requiredStringSchema, a))
          .not.toBe(propertyValueToChildContent(requiredStringSchema, b))
      }),
      fuzzParams(300),
    )
  })
})

describe('enum: only a DECLARED option reads (#1088)', () => {
  it('an off-menu value is refused in either spelling, and in an escaped envelope', () => {
    // `decode` is lenient (it only checks the value is a string, `enumCodec`),
    // so the membership check has to come from `encode`. Asserted for all
    // three routes into `contentToEncodedValue`, because they are three
    // different returns and only one of them is the plain one.
    for (const content of [
      'retired-option',
      JSON.stringify('retired-option'),
      encodedToValueChildContent(enumSchema, '"retired-option"'),
    ]) {
      expect(() => valueChildContentToEncoded(enumSchema, content),
        `content ${JSON.stringify(content)}`).toThrow(CodecError)
    }
  })

  it('any option value round-trips, and its content is inert to both readers', () => {
    // The same invariant the verbatim string family carries above, now that
    // `enum` has joined it: whatever the option value is — quote-shaped,
    // span-shaped, ill-formed, whitespace-edged — the content either IS the
    // value and the whole-block reader sees nothing in it, or it is an
    // envelope that is inert to both readers; and it reads back either way.
    fc.assert(
      fc.property(textArb, option => {
        const schema = defineProperty<string>('e1', {
          codec: codecs.enum([option]),
          defaultValue: option,
          changeScope: ChangeScope.BlockDefault,
        })
        const content = propertyValueToChildContent(schema, option)
        expect(valueChildContentToEncoded(schema, content)).toBe(option)
        expect(parseExactReferenceBlockContent(content)).toBeNull()
        if (content !== option) expect(parseReferences(content)).toEqual([])
      }),
      fuzzParams(300),
    )
  })
})

describe('ref: the empty/cleared value is a documented non-round-trip', () => {
  it('renders as empty content, and empty content alone is not decodable (no span to read an id from)', () => {
    const content = propertyValueToChildContent(refSchema, '')
    expect(content).toBe('')
    expect(() => valueChildContentToEncoded(refSchema, content)).toThrow(CodecError)
  })
})

describe('number: blank content is unparseable, never a silent zero', () => {
  it('empty and whitespace-only content throw CodecError', () => {
    for (const content of ['', '   ', '\t\n']) {
      expect(() => valueChildContentToEncoded(numberSchema, content), `content ${JSON.stringify(content)}`)
        .toThrow(CodecError)
    }
  })
})

describe('multi-value: N contents round-trip to the list, duplicates and empties included', () => {
  const stringListSchema = defineProperty<readonly string[]>('sl', {
    codec: kernelValuePresetCoresById['string-list'].build(),
    defaultValue: [], changeScope: ChangeScope.BlockDefault,
  })
  const refListSchema = defineProperty<readonly string[]>('rl', {
    codec: codecs.refList(), defaultValue: [], changeScope: ChangeScope.BlockDefault,
  })

  /** The whole-property round trip, as the projection actually performs it:
   *  encode to N contents, then aggregate those contents back. The oracle is
   *  the list ITSELF, with no exceptions — multiplicity included, which is the
   *  point (a repeated member is a repeated sibling, not a redundancy), and the
   *  empty list included too, since a live field row with no member is an
   *  explicitly empty list rather than an absent key. */
  const roundTrips = (schema: typeof stringListSchema, members: readonly string[]): void => {
    const contents = encodedPropertyValueToChildContents(
      schema, schema.codec.encode(members))
    expect(childContentsToEncodedPropertyValue(schema, contents)).toEqual(members)
  }

  it('string-list: arbitrary members, including ones shaped like the grammar', () => {
    fc.assert(
      fc.property(fc.array(textArb, {maxLength: 6}), members => {
        roundTrips(stringListSchema, members)
      }),
      fuzzParams(150),
    )
  })

  it('no member content is a WHOLE-content reference', () => {
    // The escape rule applies per MEMBER now. Same two legs as the scalar
    // string case above and for the same reasons: the whole-block reader must
    // see nothing in ANY member, or that member is re-roled out of the value
    // set; an escaped one must also be inert to the inline reader, which a
    // rename rewrites through. A span embedded in prose stays verbatim and
    // does still index inline (#756) — a design question, not a misread.
    fc.assert(
      fc.property(fc.array(textArb, {maxLength: 6}), members => {
        // Per MEMBER, through the grain encoder.
        for (const member of stringListSchema.codec.encode(members) as string[]) {
          const content = encodedToValueChildContent(stringListSchema, member)
          expect(parseExactReferenceBlockContent(content)).toBeNull()
          if (content !== member) expect(parseReferences(content)).toEqual([])
        }
      }),
      fuzzParams(150),
    )
  })

  it('refList: id members round-trip through their `((id))` spans', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[A-Za-z0-9-]{1,12}$/), {maxLength: 6}),
        members => { roundTrips(refListSchema, members) },
      ),
      fuzzParams(150),
    )
  })
})
