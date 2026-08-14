import { describe, it, expect } from 'vitest'
import {
  parseReferences,
  parseOutermostReferences,
  parseReferencesMarkdownAware,
  extractAliases,
  hasReferences,
  parseBlockRefs,
  isBlockRefId,
  parseBlockRefTarget,
  renderAliasedBlockref,
  renderWikilink,
  rewriteWikilinks,
  inlineBlockRefs,
  rewriteBlockRefs,
  faithfulWikilinkReplacement,
  pinnedSpanReplacement,
  MAX_ALIAS_LENGTH,
} from '../referenceParser'

const UUID = '11111111-1111-4111-8111-111111111111'
const OTHER_UUID = '22222222-2222-4222-8222-222222222222'

describe('referenceParser', () => {
  describe('parseReferences', () => {
    it('should parse basic [[alias]] syntax', () => {
      const content = 'This is a [[test]] reference'
      const result = parseReferences(content)
      
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        alias: 'test',
        startIndex: 10,
        endIndex: 18
      })
    })

    it('should parse multiple references', () => {
      const content = 'Here are [[first]] and [[second]] references'
      const result = parseReferences(content)
      
      expect(result).toHaveLength(2)
      expect(result[0].alias).toBe('first')
      expect(result[1].alias).toBe('second')
    })

    it('should handle nested syntax [text]([[alias]])', () => {
      const content = 'This is [display text]([[alias]]) with custom text'
      const result = parseReferences(content)
      
      expect(result).toHaveLength(1)
      expect(result[0].alias).toBe('alias')
    })

    it('preserves whitespace inside aliases', () => {
      const content = 'Reference with [[ spaced alias ]] whitespace'
      const result = parseReferences(content)
      
      expect(result).toHaveLength(1)
      expect(result[0].alias).toBe(' spaced alias ')
    })

    // A run of three or more `]` is the only place the closer is in doubt,
    // and bracket balance decides it: `[[Book of [x]]]` has an inner `[`
    // waiting to be closed, `[[foo]]]` does not. Runs of exactly two are
    // untouched by the rule, so ordinary content parses exactly as before.
    describe('a run of `]` is resolved by bracket balance', () => {
      it('lets the alias keep a `]` that closes its own `[`', () => {
        expect(parseReferences('see [[Book of [x]]] here')).toEqual([
          {alias: 'Book of [x]', startIndex: 4, endIndex: 19},
        ])
      })

      it('reads a stray `]` after a plain link as text, not as part of the name', () => {
        expect(parseReferences('see [[foo]]] here')).toEqual([
          {alias: 'foo', startIndex: 4, endIndex: 11},
        ])
      })

      it('takes the longest balanced reading of a longer run', () => {
        expect(parseReferences('[[a[]]]]')[0]?.alias).toBe('a[]')
      })

      it('leaves an unbalanced `[` alone rather than refusing to link', () => {
        // Only a run of >= 3 can change; this is a run of 2, so the alias
        // stays exactly what it has always been even though it is unbalanced.
        expect(parseReferences('[[a[b]]')[0]?.alias).toBe('a[b')
        expect(parseReferences('[[a]b]]')[0]?.alias).toBe('a]b')
      })

      it('still reports nesting from both ends', () => {
        expect(parseReferences('[[a [[b]]]]').map(r => r.alias)).toEqual(['a [[b]]', 'b'])
      })

      it('does not eat a closing pair an enclosing link still needs', () => {
        // Four `]`: one for the inner alias's unmatched `[` would leave a
        // single `]`, and the OUTER link would never be emitted at all.
        expect(parseReferences('[[outer [[inner[]]]]').map(r => r.alias))
          .toEqual(['outer [[inner[]]', 'inner['])
      })

      it('still absorbs when the run has pairs to spare for the enclosing link', () => {
        expect(parseReferences('[[a [[Book of [x]]]]]').map(r => r.alias))
          .toEqual(['a [[Book of [x]]]', 'Book of [x]'])
      })

      it('still absorbs when the enclosing link closes later in the content', () => {
        // A blanket "reserve two per enclosing opener" would wrongly refuse
        // this one — the outer closes at the end and never wanted this run.
        expect(parseReferences('[[outer [[Book of [x]]] tail]]').map(r => r.alias))
          .toEqual(['outer [[Book of [x]]] tail', 'Book of [x]'])
      })
    })

    it('should ignore empty references', () => {
      const content = 'Empty [[]] reference should be ignored'
      const result = parseReferences(content)
      
      expect(result).toHaveLength(0)
    })

    it('should handle malformed syntax gracefully', () => {
      const content = 'Malformed [[ incomplete and [[valid]] reference'
      const result = parseReferences(content)
      
      expect(result).toHaveLength(1)
      expect(result[0].alias).toBe('valid')
    })

    it('should handle aliases with special characters', () => {
      const content = 'Reference to [[AI/ML Research]] and [[Node.js]]'
      const result = parseReferences(content)
      
      expect(result).toHaveLength(2)
      expect(result[0].alias).toBe('AI/ML Research')
      expect(result[1].alias).toBe('Node.js')
    })

    it('should handle nested references correctly', () => {
      const content = 'Outer [[outer with [[inner]] nested]] reference'
      const result = parseReferences(content)
      
      expect(result).toHaveLength(2)
      expect(result[0].alias).toBe('outer with [[inner]] nested')
      expect(result[1].alias).toBe('inner')
    })

    it('should handle multiple levels of nesting', () => {
      const content = '[[level1 [[level2 [[level3]] nested]] here]]'
      const result = parseReferences(content)
      
      expect(result).toHaveLength(3)
      expect(result[0].alias).toBe('level1 [[level2 [[level3]] nested]] here')
      expect(result[1].alias).toBe('level2 [[level3]] nested')
      expect(result[2].alias).toBe('level3')
    })

    it('should handle adjacent nested references', () => {
      const content = '[[first [[nested1]]]][[second [[nested2]]]]'
      const result = parseReferences(content)
      
      expect(result).toHaveLength(4)
      expect(result[0].alias).toBe('first [[nested1]]')
      expect(result[1].alias).toBe('nested1')
      expect(result[2].alias).toBe('second [[nested2]]')
      expect(result[3].alias).toBe('nested2')
    })

    it('can project nested references to outermost spans', () => {
      const content = '[[first [[nested1]]]][[second [[nested2]]]]'
      const result = parseOutermostReferences(content)

      expect(result.map(ref => ref.alias)).toEqual([
        'first [[nested1]]',
        'second [[nested2]]',
      ])
    })
  })

  describe('parseReferencesMarkdownAware', () => {
    it('should parse references while respecting markdown structure', () => {
      const content = 'Normal [[reference]] and `code with [[not-a-ref]]`'
      const result = parseReferencesMarkdownAware(content)
      
      // Should find the normal reference but skip the one in code
      expect(result).toHaveLength(1)
      expect(result[0].alias).toBe('reference')
    })

    it('uses the canonical nested wikilink parser inside markdown text nodes', () => {
      const result = parseReferencesMarkdownAware('Normal [[outer [[inner]] tail]] here')

      expect(result.map(ref => ref.alias)).toEqual(['outer [[inner]] tail', 'inner'])
    })

    it('should handle code blocks', () => {
      const content = `
Normal [[reference]] here

\`\`\`
Code block with [[code-ref]]
\`\`\`

Another [[normal-ref]]
`
      const result = parseReferencesMarkdownAware(content)
      
      expect(result).toHaveLength(2)
      expect(result.map(r => r.alias)).toEqual(['reference', 'normal-ref'])
    })

    it('should fallback to regex parsing on error', () => {
      // Test with malformed markdown that might break remark
      const content = 'Simple [[reference]] test'
      const result = parseReferencesMarkdownAware(content)
      
      expect(result).toHaveLength(1)
      expect(result[0].alias).toBe('reference')
    })

    it('preserves whitespace inside aliases', () => {
      const result = parseReferencesMarkdownAware('Normal [[ spaced reference ]] here')

      expect(result).toHaveLength(1)
      expect(result[0].alias).toBe(' spaced reference ')
    })
  })

  describe('extractAliases', () => {
    it('should extract unique aliases', () => {
      const content = 'Multiple [[test]] and [[other]] and [[test]] again'
      const result = extractAliases(content)
      
      expect(result).toHaveLength(2)
      expect(result).toContain('test')
      expect(result).toContain('other')
    })

    it('should return empty array for no references', () => {
      const content = 'No references here'
      const result = extractAliases(content)
      
      expect(result).toHaveLength(0)
    })
  })

  describe('hasReferences', () => {
    it('should return true when references exist', () => {
      expect(hasReferences('Has [[reference]]')).toBe(true)
    })

    it('should return false when no references exist', () => {
      expect(hasReferences('No references here')).toBe(false)
    })

    it('should return false for malformed references', () => {
      expect(hasReferences('Malformed [[ reference')).toBe(false)
    })
  })

  describe('parseBlockRefs', () => {
    const id = '0123abcd-4567-89ef-0123-456789abcdef'
    const id2 = 'fedcba98-7654-3210-fedc-ba9876543210'

    it('parses a bare ((uuid)) ref', () => {
      const result = parseBlockRefs(`see ((${id})) for context`)
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({blockId: id, embed: false})
    })

    it('keeps an empty aliased label distinguishable from a plain ref', () => {
      // `[](((id)))` displays the id (renderer fallback); `label: ''`
      // marks the aliased FORM so rewrites preserve it instead of
      // degrading to `((id))`. Found by referenceParser.fuzz.
      const result = parseBlockRefs(`[](((${id})))`)
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({blockId: id, embed: false, label: ''})
      expect(rewriteBlockRefs(`[](((${id})))`, id, id2)).toBe(`[](((${id2})))`)
      // Inlining degrades to what the mark displayed. An empty-label
      // mark renders like a plain ref (remark-blockrefs emits no
      // display children for '', so BlockRef shows target content) —
      // it takes the inlineContent path.
      expect(inlineBlockRefs(`[](((${id})))`, id, 'target content')).toBe('target content')
    })

    it('parses an aliased [label](((uuid))) ref as one block ref span', () => {
      const content = `see [named block](((${id}))) for context`
      const result = parseBlockRefs(content)
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({blockId: id, embed: false, label: 'named block'})
      expect(content.slice(result[0].startIndex, result[0].endIndex)).toBe(`[named block](((${id})))`)
    })

    it('parses a !((uuid)) embed', () => {
      const result = parseBlockRefs(`!((${id}))`)
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({blockId: id, embed: true})
    })

    it('does not double-count the inner ref of a !((uuid)) embed', () => {
      const result = parseBlockRefs(`!((${id})) and ((${id2}))`)
      expect(result).toHaveLength(2)
      expect(result[0]).toMatchObject({blockId: id, embed: true})
      expect(result[1]).toMatchObject({blockId: id2, embed: false})
    })

    it('treats a bare !((uuid)) at start of line as embed', () => {
      const result = parseBlockRefs(`!((${id}))\nrest`)
      expect(result[0]).toMatchObject({blockId: id, embed: true})
    })

    it('ignores ((not-a-uuid))', () => {
      expect(parseBlockRefs('((hello world))')).toHaveLength(0)
    })

    it('lowercases the captured id', () => {
      const upper = id.toUpperCase()
      const [ref] = parseBlockRefs(`((${upper}))`)
      expect(ref.blockId).toBe(id)
    })
  })

  describe('parseBlockRefTarget', () => {
    it('accepts a markdown link destination for a block ref', () => {
      expect(parseBlockRefTarget('((0123ABCD-4567-89EF-0123-456789ABCDEF))')).toBe(
        '0123abcd-4567-89ef-0123-456789abcdef',
      )
    })

    it('rejects non-block-ref destinations', () => {
      expect(parseBlockRefTarget('https://example.com')).toBeNull()
      expect(parseBlockRefTarget('(((0123abcd-4567-89ef-0123-456789abcdef)))')).toBeNull()
    })
  })

  describe('isBlockRefId', () => {
    it('accepts a uuid', () => {
      expect(isBlockRefId('0123abcd-4567-89ef-0123-456789abcdef')).toBe(true)
    })
    it('rejects non-uuid', () => {
      expect(isBlockRefId('not-a-uuid')).toBe(false)
    })
  })

  describe('renderWikilink', () => {
    it('emits a basic wikilink', () => {
      expect(renderWikilink('Foo')).toBe('[[Foo]]')
    })

    it('preserves alias whitespace + special chars verbatim', () => {
      expect(renderWikilink(' Foo ')).toBe('[[ Foo ]]')
      expect(parseReferences(renderWikilink(' Foo '))[0]?.alias).toBe(' Foo ')
      expect(renderWikilink('a/b:c')).toBe('[[a/b:c]]')
    })

    it('breaks embedded `]]` so the close bracket cannot terminate early', () => {
      expect(renderWikilink('foo]]bar')).toBe('[[foo] ]bar]]')
      // Syntax safety: the parser finds one complete wikilink, but the
      // alias identity is not preserved.
      const result = parseReferences(renderWikilink('foo]]bar'))
      expect(result).toHaveLength(1)
      expect(result[0].alias).toBe('foo] ]bar')
    })

    it('does not pad a trailing `]` the alias itself opened', () => {
      // `Book of [x]` is a perfectly ordinary page name. The scanner reads
      // the run of `]` by bracket balance, so the closer is unambiguous and
      // nothing has to be inserted into the user's text.
      expect(renderWikilink('Book of [x]')).toBe('[[Book of [x]]]')
      expect(parseReferences('[[Book of [x]]]')[0]?.alias).toBe('Book of [x]')
      expect(renderWikilink('[x]')).toBe('[[[x]]]')
      expect(parseReferences('[[[x]]]')[0]?.alias).toBe('[x]')
    })

    it('still pads an UNBALANCED trailing `]`, which is genuinely ambiguous', () => {
      // `[[foo]]]` has to keep meaning "link to foo, then a stray `]`" —
      // that is the far commoner reading (a typo'd bracket) and it is what
      // every neighbouring tool does. So an alias whose trailing `]` opens
      // nothing still cannot be spelled as a wikilink, and the renderer
      // still says so lossily rather than silently binding elsewhere.
      expect(renderWikilink('foo]')).toBe('[[foo] ]]')
    })
  })

  describe('renderAliasedBlockref', () => {
    const uuid = '0123abcd-4567-89ef-0123-456789abcdef'

    it('emits the canonical aliased-blockref form', () => {
      expect(renderAliasedBlockref('shortcut', uuid)).toBe(`[shortcut](((${uuid})))`)
    })

    it('strips `]` and newlines from the label so the parser regex matches', () => {
      expect(renderAliasedBlockref('a]b\nc', uuid)).toBe(`[abc](((${uuid})))`)
      // Round-trip verification.
      const refs = parseBlockRefs(renderAliasedBlockref('a]b\nc', uuid))
      expect(refs).toHaveLength(1)
      expect(refs[0]).toMatchObject({blockId: uuid, label: 'abc'})
    })
  })

  describe('rewriteWikilinks', () => {
    it('rewrites a single [[alias]] occurrence', () => {
      expect(rewriteWikilinks('See [[Old]] please', 'Old', '[[New]]')).toBe(
        'See [[New]] please',
      )
    })

    it('matches aliases with surrounding whitespace exactly', () => {
      expect(rewriteWikilinks('See [[ Old ]] please', 'Old', '[[New]]')).toBe(
        'See [[ Old ]] please',
      )
      expect(rewriteWikilinks('See [[ Old ]] please', ' Old ', '[[New]]')).toBe(
        'See [[New]] please',
      )
    })

    it('handles aliases containing `$&` (would corrupt String.replace)', () => {
      // String.replace with a regex would interpret `$&` in the
      // replacement as "the whole match"; using span-splicing avoids
      // that pitfall.
      expect(rewriteWikilinks('See [[$&]] here', '$&', '[[safe]]')).toBe(
        'See [[safe]] here',
      )
      // Aliases with regex meta chars on the source side: with regex
      // we'd have needed escapeRegex. Span-based comparison is exact.
      expect(rewriteWikilinks('a [[(group)]] b', '(group)', '[[X]]')).toBe(
        'a [[X]] b',
      )
    })

    it('rewrites every matching occurrence; leaves others alone', () => {
      expect(
        rewriteWikilinks('a [[Old]] b [[Other]] c [[Old]] d', 'Old', '[[New]]'),
      ).toBe('a [[New]] b [[Other]] c [[New]] d')
    })

    it('returns input unchanged when no wikilinks present', () => {
      const content = 'plain text with no references'
      expect(rewriteWikilinks(content, 'Old', '[[New]]')).toBe(content)
    })

    it('returns input unchanged when no wikilink matches the alias', () => {
      const content = 'has [[Other]] only'
      expect(rewriteWikilinks(content, 'Old', '[[New]]')).toBe(content)
    })

    it('emits the replacement string literally (no $-interpolation in output)', () => {
      // Replacement contains regex backreference tokens; should pass
      // through verbatim because we splice, not regex-replace.
      expect(rewriteWikilinks('see [[Foo]] here', 'Foo', '$&$1[[Bar]]')).toBe(
        'see $&$1[[Bar]] here',
      )
    })
  })

  describe('inlineBlockRefs', () => {
    it('replaces a plain block-ref with the inline content', () => {
      expect(inlineBlockRefs(`before ((${UUID})) after`, UUID, 'BODY')).toBe(
        'before BODY after',
      )
    })

    it('replaces an embed mark with the inline content', () => {
      expect(inlineBlockRefs(`x !((${UUID})) y`, UUID, 'BODY')).toBe('x BODY y')
    })

    it('keeps an aliased mark\'s label instead of the content', () => {
      expect(inlineBlockRefs(`see [label](((${UUID}))) ok`, UUID, 'BODY')).toBe(
        'see label ok',
      )
    })

    it('only rewrites marks for the target id', () => {
      expect(
        inlineBlockRefs(`((${UUID})) and ((${OTHER_UUID}))`, UUID, 'BODY'),
      ).toBe(`BODY and ((${OTHER_UUID}))`)
    })

    it('matches the target id case-insensitively', () => {
      expect(inlineBlockRefs(`((${UUID.toUpperCase()}))`, UUID, 'BODY')).toBe('BODY')
    })

    it('inserts the content literally (no String.replace $-interpolation)', () => {
      expect(inlineBlockRefs(`a ((${UUID})) b`, UUID, '$& $1 text')).toBe(
        'a $& $1 text b',
      )
    })

    it('returns input unchanged when no mark targets the id', () => {
      const content = `nothing ((${OTHER_UUID})) here`
      expect(inlineBlockRefs(content, UUID, 'BODY')).toBe(content)
    })
  })

  describe('whole-span round-trip guard', () => {
    it('accepts a label that survives rendering intact', () => {
      expect(pinnedSpanReplacement('Plain', UUID)).toEqual({
        text: `[Plain](((${UUID})))`,
        refAlias: UUID,
        toTargetId: UUID,
        lossyLabel: false,
      })
    })

    it('flags a label the renderer had to sanitize, keeping the link', () => {
      // `]` is legal in a wikilink alias but illegal in a blockref label.
      const result = pinnedSpanReplacement('a]b', UUID)
      expect(result).toEqual({
        text: `[ab](((${UUID})))`,
        refAlias: UUID,
        toTargetId: UUID,
        lossyLabel: true,
      })
    })

    it('refuses a target that cannot be represented in the pinned grammar', () => {
      expect(pinnedSpanReplacement('Plain', 'not-a-uuid')).toBeNull()
    })

    it('refuses a wikilink alias markdown would re-escape, and flags the pinned label', () => {
      // Markdown owns `\` as an escape and resolves it BEFORE
      // `remark-wikilinks` sees the text, so `[[abc\]]` renders a link to
      // alias `abc` while the stored edge says `abc\` — a span pointing
      // somewhere the projection does not. The parsers here keep the
      // backslash verbatim, so nothing else notices.
      expect(faithfulWikilinkReplacement('abc\\')).toBeNull()
      expect(faithfulWikilinkReplacement('a\\b')).toBeNull()
      expect(faithfulWikilinkReplacement('abc')).not.toBeNull()

      // The pinned form survives it: the id segment carries the binding,
      // so only the DISPLAYED label loses the escape — reported, not
      // refused, which is what keeps the ladder's fallback available.
      const pinned = pinnedSpanReplacement('abc\\', UUID)
      expect(pinned).not.toBeNull()
      expect(pinned!.toTargetId).toBe(UUID)
      expect(pinned!.lossyLabel).toBe(true)
    })

    it('flags a pinned label markdown would split at an unmatched bracket', () => {
      // `[a[b](((uuid)))` clears the `[[` check — there is no doubled
      // opener — but markdown reads the INNER `[b](...)` as the link and
      // leaves `[a` outside it as literal text. The reference still lands
      // on the right block; the label is reordered and only its suffix is
      // clickable, so the honest report is lossy rather than faithful.
      const split = pinnedSpanReplacement('a[b', UUID)
      expect(split).not.toBeNull()
      expect(split!.toTargetId).toBe(UUID)
      expect(split!.lossyLabel).toBe(true)
      // A LEADING `[` is a different case and stays refused outright: it
      // renders `[[ab](((uuid)))`, whose doubled opener can pair with a
      // later `]]` and manufacture a wikilink.
      expect(pinnedSpanReplacement('[ab', UUID)).toBeNull()
    })

    it('refuses a target id the parser would canonicalize away', () => {
      // `parseBlockRefs` lower-cases UUID-shaped ids, but `blocks.id` is
      // compared case-sensitively and both `tx.create` and the agent
      // bridge accept caller-supplied ids verbatim. So an upper-case
      // target renders a span that binds to a lowercase id no row has —
      // and comparing the parse against `targetId.toLowerCase()` would
      // certify exactly that as a faithful round trip. Same divergence
      // `referenceBlockContentForId` rejects on the `((id))` form.
      // Hex LETTERS, so the id actually has a case to differ in.
      const mixed = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
      const upper = mixed.toUpperCase()
      expect(upper).not.toBe(mixed)
      expect(pinnedSpanReplacement('Plain', mixed)).not.toBeNull()
      expect(pinnedSpanReplacement('Plain', upper)).toBeNull()
    })

    it('refuses a pinned span whose label smuggles a wikilink opener', () => {
      // `renderAliasedBlockref` strips `]` and newlines but NOT `[`, so
      // this renders a valid aliased blockref that also carries an
      // unbalanced `[[`. Spliced next to any later `]]` the pair closes
      // across the spliced text and manufactures a bogus wikilink —
      // which binds a reference and mints a seat. Checking only the
      // grammar we rendered into would certify it as faithful.
      expect(pinnedSpanReplacement('a[[b', UUID)).toBeNull()
      expect(
        parseReferences(`see ${renderAliasedBlockref('a[[b', UUID)} tail]]`).length,
      ).toBe(1)
    })

    it('leaves a page-embed span alone when splicing the pinned form', () => {
      // `![[A]]` is the page-embed syntax. Splicing the pinned form under
      // the `!` yields `![A](((uuid)))` — a markdown IMAGE, and
      // remark-blockrefs only visits link/text nodes, so it renders as a
      // broken <img>. The reference survives, the display doesn't.
      const pinned = pinnedSpanReplacement('A', UUID)!.text
      expect(rewriteWikilinks('see ![[A]] please', 'A', pinned, {skipEmbeds: true}))
        .toBe('see ![[A]] please')
      // A plain (non-embed) span next to it still rewrites.
      expect(rewriteWikilinks('see [[A]] and ![[A]]', 'A', pinned, {skipEmbeds: true}))
        .toBe(`see ${pinned} and ![[A]]`)
      // And a wikilink→wikilink swap under `!` is safe — still an embed.
      expect(rewriteWikilinks('see ![[A]] please', 'A', '[[B]]'))
        .toBe('see ![[B]] please')
    })

    it('refuses wikilink forms that do not parse back to the same alias', () => {
      expect(faithfulWikilinkReplacement('')).toBeNull()
      expect(faithfulWikilinkReplacement('foo]]bar')).toBeNull()
      expect(faithfulWikilinkReplacement('Plain')).toEqual({
        text: '[[Plain]]',
        refAlias: 'Plain',
        toTargetId: null,
        lossyLabel: false,
      })
    })
  })
})

describe('runaway wikilink spans (MAX_ALIAS_LENGTH)', () => {
  const alias = (n: number) => 'a'.repeat(n)

  it('parses an alias at the cap and rejects one past it', () => {
    expect(parseReferences(`[[${alias(MAX_ALIAS_LENGTH)}]]`))
      .toHaveLength(1)
    expect(parseReferences(`[[${alias(MAX_ALIAS_LENGTH + 1)}]]`))
      .toEqual([])
  })

  // The regression this cap exists for. A regex character class whose
  // first member is a literal `[` supplies a `[[` opener; the scanner
  // paired it with a `]]` from an unrelated `x[i]]` far downstream and
  // minted a page whose name was the whole span. Both halves are real
  // text from the bundle that produced the 205 KB page.
  it('does not treat a regex char class + a distant `]]` as a wikilink', () => {
    const content = [
      'ESCAPE: /[[\\]{}()*+?.\\\\^$|\\s]/g,',
      'x'.repeat(MAX_ALIAS_LENGTH),
      'while (i--) delete createDict[PROTOTYPE][enumBugKeys[i]];',
    ].join('\n')
    expect(parseReferences(content)).toEqual([])
    expect(hasReferences(content)).toBe(false)
    expect(extractAliases(content)).toEqual([])
  })

  it('a large nested JSON array produces no reference', () => {
    // `[[1,2],[3,4]]` opens with `[[` exactly like a wikilink. Sized off
    // the constant so the fixture tracks the cap instead of silently
    // sliding under it when the cap moves.
    const point = (i: number) => `[${i},${i}]`
    const count = Math.ceil(MAX_ALIAS_LENGTH / point(0).length) + 100
    const points = Array.from({length: count}, (_, i) => point(i)).join(',')
    expect(`[${points}]`.length).toBeGreaterThan(MAX_ALIAS_LENGTH)
    expect(parseReferences(`[${points}]`)).toEqual([])
  })

  // The accepted cost of a deliberately generous cap, pinned so it is a
  // known tradeoff rather than a surprise. A short nested array still
  // mints an alias — a 2951-char drawing point-array in the author's live
  // workspace is exactly this. Lowering MAX_ALIAS_LENGTH is what would
  // catch these, at the price of refusing long legitimate page names;
  // that dial is the whole decision, so make the current setting visible.
  it('does NOT catch a nested array shorter than the cap', () => {
    const short = '[[1,2],[3,4]]'
    expect(short.length).toBeLessThanOrEqual(MAX_ALIAS_LENGTH)
    expect(parseReferences(short).map(r => r.alias)).toEqual(['1,2],[3,4'])
  })

  // The cap gates EMISSION only — the `]]` still closes its opener, so a
  // rejected span cannot leak an opener that swallows later text.
  it('an over-long span still consumes its delimiters', () => {
    const content = `[[${alias(MAX_ALIAS_LENGTH + 1)}]] and [[real]]`
    expect(parseReferences(content).map(r => r.alias)).toEqual(['real'])
    expect(parseOutermostReferences(content).map(r => r.alias)).toEqual(['real'])
  })

  // An over-long OUTER span no longer hides a legitimate inner one from
  // `parseOutermostReferences` (whose cursor previously skipped anything
  // inside the emitted outer span).
  it('emits a short alias nested inside an over-long span', () => {
    const content = `[[${alias(MAX_ALIAS_LENGTH)} [[inner]] tail]]`
    expect(parseOutermostReferences(content).map(r => r.alias)).toEqual(['inner'])
  })
})

describe('pinned rewrites inside a [display]([[alias]]) wrapper', () => {
  // `parseReferences` reports only the inner `[[alias]]`, but
  // `remark-wikilinks` treats the whole `[display]([[alias]])` as ONE
  // wikilink whose rendered children are `display`. Splicing the pinned
  // form into the inner span alone produced
  // `[display]([label](((uuid))))`, which the real pipeline renders as a
  // plain markdown link — reference destroyed, stored edge moved anyway
  // (Codex on PR #444). `remark-wikilinks.test.ts` asserts the rendered
  // node values for both forms; these pin the rewrite itself.
  const PINNED = `[Old](((${UUID})))`
  const opts = {skipEmbeds: true, pinnedTargetId: UUID}

  it('replaces the whole wrapper and keeps the author display text', () => {
    expect(rewriteWikilinks('see [label]([[Old]]) here', 'Old', PINNED, opts))
      .toBe(`see [label](((${UUID}))) here`)
  })

  it('handles a wrapper and a bare span in one pass', () => {
    expect(rewriteWikilinks('[label]([[Old]]) and [[Old]]', 'Old', PINNED, opts))
      .toBe(`[label](((${UUID}))) and [Old](((${UUID})))`)
  })

  it('leaves an image wrapper alone — it carries no reference to preserve', () => {
    // `![display]([[alias]])` parses as a markdown IMAGE, so nothing is
    // lost by leaving it and a blockref would be a different node entirely.
    expect(rewriteWikilinks('x ![label]([[Old]]) y', 'Old', PINNED, opts))
      .toBe('x ![label]([[Old]]) y')
  })

  it('takes the INNERMOST bracket as the display text', () => {
    // The opener is found by scanning back for the nearest `[`, so a
    // display can never contain `[` — which is also why the
    // label-smuggling refusal inside `spliceFor` is defence in depth
    // rather than a reachable path. Pinned here because the scan-back is
    // subtle: `[a[b]([[Old]])` wraps on `[b]`, leaving `[a` as prose.
    expect(rewriteWikilinks('x [a[b]([[Old]]) y', 'Old', PINNED, opts))
      .toBe(`x [a[b](((${UUID}))) y`)
  })

  it('reports a display text the pinned grammar would mangle as unchanged', () => {
    // `\\` is markdown-unsafe in a label, so `pinnedSpanReplacement`
    // flags `lossyLabel` — but it flags it against the LADDER's invented
    // label. Here the text was already sitting in a label position, so the
    // rendered display does not change and the rewrite proceeds.
    expect(rewriteWikilinks('x [a\\b]([[Old]]) y', 'Old', PINNED, opts))
      .toBe(`x [a\\b](((${UUID}))) y`)
  })

  it('does not widen the range for a WIKILINK replacement', () => {
    // `[display]([[new]])` is still the same wrapper shape, so the inner
    // swap stays correct and the author's display text is untouched.
    expect(rewriteWikilinks('see [label]([[Old]]) here', 'Old', '[[New]]'))
      .toBe('see [label]([[New]]) here')
  })

  it('needs a real wrapper, not just a trailing paren', () => {
    // `](` immediately before the span is the whole signal, so a span that
    // merely sits inside parens must not be widened.
    expect(rewriteWikilinks('see ([[Old]]) here', 'Old', PINNED, opts))
      .toBe(`see ([Old](((${UUID})))) here`)
  })
})

