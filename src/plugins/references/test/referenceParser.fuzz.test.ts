// @vitest-environment node
/**
 * Fuzz suite for the reference parser/renderer/rewriters — see
 * `src/test/fuzz.ts` for the smoke/deep tier mechanics.
 *
 * Oracles, not examples: adversarial bracket/paren salads must never
 * throw and must produce structurally sound spans; renderers must
 * produce re-parseable output on the documented-safe input class; the
 * rewriters are checked against a fragment-level reference model where
 * the expected output is computable without re-implementing the parser.
 */
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { fuzzParams } from '@/test/fuzz'
import {
  parseReferences,
  parseOutermostReferences,
  parseReferencesMarkdownAware,
  parseBlockRefs,
  renderWikilink,
  renderAliasedBlockref,
  rewriteWikilinks,
  inlineBlockRefs,
  rewriteBlockRefs,
} from '../referenceParser'

/** Mixed-case UUID — the parser matches case-insensitively and
 *  normalizes ids to lowercase. */
const uuidArb = fc.uuid().map(u => u.split('').map((c, i) => (i % 3 === 0 ? c.toUpperCase() : c)).join(''))

/** Adversarial soup biased toward the grammar's meta tokens. */
const saladArb = fc
  .array(
    fc.oneof(
      {arbitrary: fc.constantFrom('[[', ']]', '[', ']', '(', ')', '((', '))', '(((', ')))', '!', '$&', '$1', '$$', '\n'), weight: 5},
      {arbitrary: fc.string({maxLength: 6}), weight: 3},
      {arbitrary: uuidArb, weight: 2},
    ),
    {maxLength: 24},
  )
  .map(parts => parts.join(''))

describe('wikilink parsing', () => {
  it('parseReferences: sound spans on arbitrary input', () => {
    fc.assert(
      fc.property(saladArb, content => {
        const refs = parseReferences(content)
        let prevStart = -1
        for (const ref of refs) {
          expect(ref.startIndex).toBeGreaterThanOrEqual(0)
          expect(ref.endIndex).toBeGreaterThan(ref.startIndex)
          expect(ref.endIndex).toBeLessThanOrEqual(content.length)
          // The span reconstructs the exact token: [[alias]]
          expect(content.slice(ref.startIndex, ref.endIndex)).toBe(`[[${ref.alias}]]`)
          expect(ref.alias).not.toBe('')
          expect(ref.startIndex).toBeGreaterThanOrEqual(prevStart)
          prevStart = ref.startIndex
        }
      }),
      fuzzParams(150),
    )
  })

  it('parseOutermostReferences: non-overlapping ordered subset of parseReferences', () => {
    fc.assert(
      fc.property(saladArb, content => {
        const all = parseReferences(content)
        const outer = parseOutermostReferences(content)
        let cursor = 0
        for (const ref of outer) {
          expect(ref.startIndex).toBeGreaterThanOrEqual(cursor)
          cursor = ref.endIndex
          expect(all).toContainEqual(ref)
        }
      }),
      fuzzParams(150),
    )
  })

  it('parseReferencesMarkdownAware: never throws', () => {
    fc.assert(
      fc.property(saladArb, content => {
        parseReferencesMarkdownAware(content)
      }),
      fuzzParams(50),
    )
  })

  it('renderWikilink round-trips aliases without wikilink delimiters', () => {
    // Documented-safe class: non-empty, no `]]`/`[[` (renderer splits
    // them, lossy) and no trailing `]` (renderer pads an UNBALANCED one,
    // lossy). Balanced single brackets inside the alias are fine — and a
    // balanced trailing `]` has its own property below.
    const safeAlias = fc
      .string({minLength: 1, maxLength: 30})
      .filter(a => !a.includes(']]') && !a.includes('[[') && !a.endsWith(']'))
    fc.assert(
      fc.property(safeAlias, alias => {
        const rendered = renderWikilink(alias)
        const parsed = parseOutermostReferences(rendered)
        expect(parsed).toEqual([{alias, startIndex: 0, endIndex: rendered.length}])
      }),
      fuzzParams(200),
    )
  })

  it('renderWikilink round-trips an alias whose own bracket is the last char', () => {
    // The case that used to be padded (`Book of [x]` → `[[Book of [x] ]]`).
    // BUILT balanced rather than filtered-for-balance on purpose: filtering
    // would restate `closingDelimiterFor`'s own rule and the property could
    // only ever agree with the implementation. Everything here ends in `]`,
    // so each sample lands the alias right against the closing delimiter.
    const plain = fc.string({maxLength: 6}).map(s => s.replace(/[[\]]/g, ''))
    const wrap = (inner: fc.Arbitrary<string>) =>
      fc.tuple(plain, inner).map(([lead, body]) => `${lead}[${body}]`)
    const endsWithItsOwnBracket = fc
      .oneof(wrap(plain), wrap(wrap(plain)))
      .filter(a => !a.includes('[[') && !a.includes(']]'))
    fc.assert(
      fc.property(endsWithItsOwnBracket, alias => {
        const rendered = renderWikilink(alias)
        expect(rendered).toBe(`[[${alias}]]`)
        expect(parseOutermostReferences(rendered))
          .toEqual([{alias, startIndex: 0, endIndex: rendered.length}])
      }),
      fuzzParams(200),
    )
  })

  it('does not re-scan the alias once per candidate closer', () => {
    // `closingDelimiterFor` COUNTS the closer (one depth pass) instead of
    // searching for it (test each candidate for balance) — Codex on PR #548,
    // which is reachable from arbitrary pasted content on the editing path.
    //
    // The input isolates that one factor: a single opener, so exactly one
    // close happens and the per-close `slice` every version pays cannot
    // confound the measurement, with a long prefix AND a long `]` run so the
    // search version multiplies them. Measured on this machine: 907ms
    // searching, 2.4ms counting. Deep NESTING is separately quadratic (the
    // per-close slice, which predates this) and is deliberately not what this
    // asserts.
    //
    // The bound is set for the ~375x gap, not for the measurement: 300ms is
    // over 100x the counting version's cost, so the full gate's ~6x p99.9
    // slowdown cannot reach it, while the searching version misses by 10x.
    const adversarial = '[['.concat('a'.repeat(40_000), ']'.repeat(20_000))
    const started = performance.now()
    parseReferences(adversarial)
    expect(performance.now() - started).toBeLessThan(300)
  })

  it('a stray `]` after a link never gets absorbed into the alias', () => {
    // The other side of the same rule, and the one protecting existing
    // content: `[[foo]]` followed by literal `]`s must keep parsing as the
    // link plus text, whatever the alias is.
    const plainAlias = fc
      .string({minLength: 1, maxLength: 12})
      .map(s => s.replace(/[[\]]/g, ''))
      .filter(a => a.length > 0)
    fc.assert(
      fc.property(plainAlias, fc.integer({min: 1, max: 4}), (alias, strays) => {
        const content = `[[${alias}]]${']'.repeat(strays)}`
        expect(parseOutermostReferences(content))
          .toEqual([{alias, startIndex: 0, endIndex: alias.length + 4}])
      }),
      fuzzParams(200),
    )
  })

  it('renderWikilink output is structurally sound for ANY alias', () => {
    // Even outside the lossless class, the output must parse to exactly
    // one outermost reference spanning the whole string — no stray
    // delimiters that could pair with surrounding document text.
    // (Caught live before hardening: 'a]' → '[[a]]]' parsed to alias
    // 'a' with a stray ']'; '[[x' leaked an unclosed opener.)
    fc.assert(
      fc.property(fc.string({minLength: 1, maxLength: 30}), alias => {
        const rendered = renderWikilink(alias)
        const parsed = parseOutermostReferences(rendered)
        expect(parsed).toHaveLength(1)
        expect(parsed[0].startIndex).toBe(0)
        expect(parsed[0].endIndex).toBe(rendered.length)
      }),
      fuzzParams(300),
    )
  })

  it('renderWikilink/rewriteWikilinks never throw on arbitrary input', () => {
    fc.assert(
      fc.property(saladArb, saladArb, saladArb, (content, alias, replacement) => {
        renderWikilink(alias)
        const result = rewriteWikilinks(content, alias, replacement)
        expect(typeof result).toBe('string')
      }),
      fuzzParams(100),
    )
  })

  it('rewriteWikilinks: identity when the alias does not occur', () => {
    fc.assert(
      fc.property(saladArb, fc.string({minLength: 1, maxLength: 10}), (content, alias) => {
        fc.pre(!parseReferences(content).some(r => r.alias === alias))
        expect(rewriteWikilinks(content, alias, 'X')).toBe(content)
      }),
      fuzzParams(150),
    )
  })

  it('rewriteWikilinks inserts replacement literally (no $-backreference pitfall)', () => {
    // Bracket-free filler means the only wikilinks in the document are the
    // ones we place, so the expected output is a pure textual splice.
    const filler = fc.string({maxLength: 12}).map(s => s.replace(/[[\]]/g, '.'))
    const alias = fc.string({minLength: 1, maxLength: 8}).map(s => s.replace(/[[\]]/g, '.'))
    const replacement = fc.oneof(fc.constantFrom('$&', '$1', '$$', "$'", '$`'), saladArb)
    fc.assert(
      fc.property(filler, filler, filler, alias, replacement, (pre, mid, post, a, r) => {
        const content = `${pre}[[${a}]]${mid}[[${a}]]${post}`
        expect(rewriteWikilinks(content, a, r)).toBe(`${pre}${r}${mid}${r}${post}`)
      }),
      fuzzParams(150),
    )
  })
})

// ──── Block refs: fragment-level reference model ────
//
// Content is assembled from fragments whose individual parses are known
// and which cannot combine across boundaries into new marks (plain text
// excludes the grammar's meta characters), so the expected result of
// each rewriter is computable fragment-by-fragment.

type Fragment =
  | {kind: 'plain'; text: string}
  | {kind: 'ref'; id: string}
  | {kind: 'embed'; id: string}
  | {kind: 'aliased'; id: string; label: string}

const plainTextArb = fc
  .string({minLength: 1, maxLength: 10})
  .map(s => s.replace(/[[\]()!\n]/g, '.'))

// Aliased-blockref labels: the parser's label group excludes `]` and
// newlines; also keep `(`/`)` out so a label can't smuggle in a nested
// mark, and pre-trim since the parser trims. Empty labels included on
// purpose: `[](((id)))` must keep its aliased form through rewrites
// (label presence ⇔ form — a truthy gate here once degraded it to a
// plain ref; found by this suite's span-soundness property).
const labelArb = fc
  .string({maxLength: 8})
  .map(s => s.replace(/[[\]()!\n]/g, '.').trim())

const fragmentArb = (ids: readonly string[]): fc.Arbitrary<Fragment> =>
  fc.oneof(
    {arbitrary: plainTextArb.map(text => ({kind: 'plain', text}) as Fragment), weight: 3},
    {arbitrary: fc.constantFrom(...ids).map(id => ({kind: 'ref', id}) as Fragment), weight: 2},
    {arbitrary: fc.constantFrom(...ids).map(id => ({kind: 'embed', id}) as Fragment), weight: 1},
    {
      arbitrary: fc
        .tuple(fc.constantFrom(...ids), labelArb)
        .map(([id, label]) => ({kind: 'aliased', id, label}) as Fragment),
      weight: 1,
    },
  )

const renderFragment = (f: Fragment): string => {
  switch (f.kind) {
    case 'plain':
      return f.text
    case 'ref':
      return `((${f.id}))`
    case 'embed':
      return `!((${f.id}))`
    case 'aliased':
      return `[${f.label}](((${f.id})))`
  }
}

const docArb = fc
  .tuple(uuidArb, uuidArb)
  .chain(([a, b]) =>
    fc.tuple(
      fc.array(fragmentArb([a, b]), {maxLength: 12}),
      fc.constant(a),
      fc.constant(b),
    ),
  )

describe('block-ref parsing and rewriting', () => {
  it('parseBlockRefs: sound, non-overlapping, sorted spans on arbitrary input', () => {
    fc.assert(
      fc.property(saladArb, content => {
        const marks = parseBlockRefs(content)
        let cursor = 0
        for (const mark of marks) {
          expect(mark.startIndex).toBeGreaterThanOrEqual(cursor)
          expect(mark.endIndex).toBeGreaterThan(mark.startIndex)
          expect(mark.endIndex).toBeLessThanOrEqual(content.length)
          cursor = mark.endIndex
          const token = content.slice(mark.startIndex, mark.endIndex)
          expect(mark.blockId).toBe(mark.blockId.toLowerCase())
          if (mark.label !== undefined) {
            expect(token.toLowerCase()).toContain(`(((${mark.blockId})))`)
            expect(token.startsWith('[')).toBe(true)
          } else if (mark.embed) {
            expect(token.toLowerCase()).toBe(`!((${mark.blockId}))`)
          } else {
            expect(token.toLowerCase()).toBe(`((${mark.blockId}))`)
          }
        }
      }),
      fuzzParams(150),
    )
  })

  it('parseBlockRefs agrees with the fragment model', () => {
    fc.assert(
      fc.property(docArb, ([fragments]) => {
        const content = fragments.map(renderFragment).join('')
        const marks = parseBlockRefs(content)
        const expected = fragments
          .filter(f => f.kind !== 'plain')
          .map(f => ({
            id: f.id.toLowerCase(),
            embed: f.kind === 'embed',
            label: f.kind === 'aliased' ? f.label : undefined,
          }))
        expect(
          marks.map(m => ({id: m.blockId, embed: m.embed, label: m.label})),
        ).toEqual(expected)
      }),
      fuzzParams(150),
    )
  })

  it('inlineBlockRefs matches the fragment model and removes the target', () => {
    const inlineArb = plainTextArb
    fc.assert(
      fc.property(docArb, inlineArb, ([fragments, target], inline) => {
        const content = fragments.map(renderFragment).join('')
        const result = inlineBlockRefs(content, target, inline)
        const expected = fragments
          .map(f => {
            if (f.kind === 'plain' || f.id.toLowerCase() !== target.toLowerCase()) return renderFragment(f)
            // Aliased marks degrade to what they displayed: the label
            // when non-empty; an empty-label mark renders like a plain
            // ref, so it degrades to inlineContent too.
            if (f.kind === 'aliased' && f.label !== '') return f.label
            return inline
          })
          .join('')
        expect(result).toBe(expected)
        // Degrade-on-delete contract: no marks still target the inlined id.
        expect(parseBlockRefs(result).some(m => m.blockId === target.toLowerCase())).toBe(false)
      }),
      fuzzParams(150),
    )
  })

  it('rewriteBlockRefs matches the fragment model, preserving embed/label', () => {
    fc.assert(
      fc.property(docArb, uuidArb, ([fragments, from], to) => {
        const content = fragments.map(renderFragment).join('')
        const result = rewriteBlockRefs(content, from, to)
        const mapped = fragments.map(f =>
          f.kind === 'plain' || f.id.toLowerCase() !== from.toLowerCase() ? f : {...f, id: to},
        )
        // The rewriter emits ids verbatim as passed in `to`, and
        // re-renders aliased marks through renderAliasedBlockref.
        const expected = mapped.map(renderFragment).join('')
        expect(result).toBe(expected)
      }),
      fuzzParams(150),
    )
  })

  it('inlineBlockRefs/rewriteBlockRefs never throw on arbitrary input', () => {
    fc.assert(
      fc.property(saladArb, uuidArb, saladArb, (content, id, text) => {
        expect(typeof inlineBlockRefs(content, id, text)).toBe('string')
        expect(typeof rewriteBlockRefs(content, id, id)).toBe('string')
      }),
      fuzzParams(100),
    )
  })

  it('renderAliasedBlockref output always re-parses to the same id', () => {
    fc.assert(
      fc.property(fc.string({maxLength: 20}), uuidArb, (label, id) => {
        const rendered = renderAliasedBlockref(label, id)
        const marks = parseBlockRefs(rendered)
        expect(marks).toHaveLength(1)
        expect(marks[0].blockId).toBe(id.toLowerCase())
        expect(marks[0].startIndex).toBe(0)
        expect(marks[0].endIndex).toBe(rendered.length)
      }),
      fuzzParams(150),
    )
  })
})
