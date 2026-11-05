// @vitest-environment node
/**
 * Fuzz suite for the whole-block reference grammar (`referenceBlock.ts`) —
 * see `src/test/fuzz.ts` for the smoke/deep tier mechanics.
 *
 * Oracles, none of them the implementation's own regexes:
 *  - LABELS: the INLINE reader (`@/plugins/references/referenceParser`) is
 *    the other reader of `[[name]]`, written separately. A name is
 *    round-trippable exactly when BOTH readers get it back from
 *    `referenceBlockContentForLabel`, so the predicate is checked in both
 *    directions against them: it must never approve a name either reader
 *    loses, and never refuse one both keep.
 *  - IDS: a per-character model of what `((id))` can carry (no whitespace,
 *    no parens, non-empty) plus the one canonicalization the parser does
 *    (UUID-shaped ids read back lowercased).
 *  - PARSE: structural facts about every accepted span (trim-insensitive,
 *    `fieldForm` iff the `::` marker leads, the parsed value re-renders to
 *    content that parses back to it).
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
// Cross-layer oracle only: the plugin's reader of the same grammar.
import { parseReferences } from '@/plugins/references/referenceParser'
import {
  FIELD_FORM_MARKER,
  MAX_ALIAS_LENGTH,
  isRoundTrippableReferenceLabel,
  parseExactReferenceBlockContent,
  referenceBlockContentForId,
  referenceBlockContentForLabel,
} from './referenceBlock.ts'

/** Characters the grammar gives meaning to, plus enough filler that most
 *  draws are names rather than pure punctuation. */
const grammarChar = fc.constantFrom(
  '[', ']', '(', ')', ':', '!', ' ', '\n', '\t', '\\', 'a', 'b', 'Z', '-', '0', 'é',
)
const grammarSoup = fc.array(grammarChar, {maxLength: 14}).map(cs => cs.join(''))

const isBlank = (ch: string): boolean => ch.trim() === ''

const HEX = '0123456789abcdef'
const isUuidShaped = (s: string): boolean => {
  const lower = s.toLowerCase()
  if (lower.length !== 36) return false
  return [...lower].every((c, i) =>
    [8, 13, 18, 23].includes(i) ? c === '-' : HEX.includes(c))
}

/** UUIDs with each hex letter's case drawn independently. */
const mixedCaseUuid = fc.tuple(fc.uuid(), fc.array(fc.boolean(), {minLength: 36, maxLength: 36}))
  .map(([id, upper]) => [...id].map((c, i) => (upper[i] ? c.toUpperCase() : c)).join(''))

const idCandidate = fc.oneof(grammarSoup, mixedCaseUuid, fc.string({maxLength: 12}))

const whitespacePad = fc.array(fc.constantFrom(' ', '\n', '\t', ' '), {maxLength: 3})
  .map(cs => cs.join(''))

describe('reference labels (fuzz)', () => {
  it('a label is round-trippable exactly when both readers get it back', () => {
    fc.assert(
      fc.property(fc.oneof(grammarSoup, fc.string({maxLength: 12})), label => {
        const content = referenceBlockContentForLabel(label)
        const whole = parseExactReferenceBlockContent(content)
        const wholeKeeps = whole?.kind === 'alias' && whole.alias === label
        const inlineKeeps = parseReferences(content).some(ref =>
          ref.startIndex === 0 && ref.endIndex === content.length && ref.alias === label)
        expect(isRoundTrippableReferenceLabel(label), JSON.stringify({content, whole}))
          .toBe(wholeKeeps && inlineKeeps)
      }),
      fuzzParams(2000),
    )
  }, fuzzTestTimeout())
})

describe('block-ref ids (fuzz)', () => {
  it('renders exactly the ids that read back as themselves, in every position', () => {
    fc.assert(
      fc.property(idCandidate, whitespacePad, whitespacePad, (id, before, after) => {
        const renderable = id !== ''
          && ![...id].some(ch => isBlank(ch) || ch === '(' || ch === ')')
          && !(isUuidShaped(id) && id !== id.toLowerCase())
        if (!renderable) {
          expect(() => referenceBlockContentForId(id)).toThrow()
          return
        }
        const content = referenceBlockContentForId(id)
        expect(parseExactReferenceBlockContent(`${before}${content}${after}`))
          .toEqual({kind: 'blockRef', id, fieldForm: false})
        expect(parseExactReferenceBlockContent(`${before}${FIELD_FORM_MARKER}${content}${after}`))
          .toEqual({kind: 'blockRef', id, fieldForm: true})
      }),
      fuzzParams(2000),
    )
  }, fuzzTestTimeout())
})

describe('parseExactReferenceBlockContent (fuzz)', () => {
  const span = fc.oneof(
    grammarSoup,
    grammarSoup.map(s => `[[${s}]]`),
    idCandidate.map(s => `((${s}))`),
    fc.tuple(grammarSoup, mixedCaseUuid).map(([label, id]) => `[${label}](((${id})))`),
  )
  const content = fc.tuple(fc.constantFrom('', FIELD_FORM_MARKER, '!', ': '), span)
    .map(([prefix, s]) => prefix + s)

  it('reads every accepted span back from its own rendering, whatever surrounds it', () => {
    fc.assert(
      fc.property(content, whitespacePad, whitespacePad, (text, before, after) => {
        const parsed = parseExactReferenceBlockContent(text)
        expect(parseExactReferenceBlockContent(`${before}${text}${after}`)).toEqual(parsed)
        if (parsed === null) return

        expect(parsed.fieldForm).toBe(text.trim().startsWith(FIELD_FORM_MARKER))
        const marker = parsed.fieldForm ? FIELD_FORM_MARKER : ''
        switch (parsed.kind) {
          case 'alias':
            expect(parsed.alias).toBe(parsed.alias.trim())
            expect(parsed.alias).not.toBe('')
            expect(parsed.alias.length).toBeLessThanOrEqual(MAX_ALIAS_LENGTH)
            expect(parsed.alias).not.toContain('[[')
            expect(parsed.alias).not.toContain(']]')
            expect(parseExactReferenceBlockContent(marker + referenceBlockContentForLabel(parsed.alias)))
              .toEqual(parsed)
            break
          case 'blockRef':
            // Whatever id the parser hands out is one the renderer accepts.
            expect(parseExactReferenceBlockContent(marker + referenceBlockContentForId(parsed.id)))
              .toEqual(parsed)
            break
          case 'aliasedBlockRef':
            expect(isUuidShaped(parsed.id) && parsed.id === parsed.id.toLowerCase()).toBe(true)
            expect(parsed.label).not.toMatch(/[\]\n]/)
            expect(parseExactReferenceBlockContent(`${marker}[${parsed.label}](((${parsed.id})))`))
              .toEqual(parsed)
            break
        }
      }),
      fuzzParams(2000),
    )
  }, fuzzTestTimeout())
})
