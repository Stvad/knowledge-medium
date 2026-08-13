import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { visit } from 'unist-util-visit'
import type { Root, RootContent } from 'mdast'
import { remarkWikilinks } from '../remark-wikilinks.ts'
import { MAX_ALIAS_LENGTH, parseReferences } from '../../../referenceParser.ts'
import { remarkBlockrefs } from '../../blockrefs/remark-blockrefs.ts'

interface WikilinkNode {
  type: 'wikilink'
  value: string
  children: RootContent[]
  data: {
    hName: string
    hProperties: { alias: string; blockId: string; hasCustomDisplay: boolean }
  }
}

const transform = (md: string, refs: Record<string, string> = {}) => {
  const processor = unified()
    .use(remarkParse)
    .use(remarkWikilinks, {resolveAlias: (alias: string) => refs[alias]})
  const tree = processor.parse(md) as Root
  return processor.runSync(tree) as Root
}

// Runs the full real pipeline (parse + remark-gfm + remarkWikilinks) so the
// tests cover the GFM autolink-literal interaction. remark-gfm splits emails
// and URLs inside `[[…]]` into `link` siblings during parsing, which the
// fourth pass in remarkWikilinks reassembles.
const transformWithGfm = (md: string, refs: Record<string, string> = {}) => {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkWikilinks, {resolveAlias: (alias: string) => refs[alias]})
  const tree = processor.parse(md) as Root
  return processor.runSync(tree) as Root
}

const collectWikilinks = (tree: Root): WikilinkNode[] => {
  const out: WikilinkNode[] = []
  visit(tree, (node) => {
    if ((node as { type: string }).type === 'wikilink') out.push(node as unknown as WikilinkNode)
  })
  return out
}

const collectText = (tree: Root): string[] => {
  const out: string[] = []
  visit(tree, 'text', (node) => out.push(node.value))
  return out
}

const wikilinkChildText = (link: WikilinkNode): string =>
  link.children
    .map(child => (child as { value?: string; children?: RootContent[] }).value
      ?? ((child as { children?: RootContent[] }).children
        ? wikilinkChildText({children: (child as { children: RootContent[] }).children} as WikilinkNode)
        : ''))
    .join('')

describe('remarkWikilinks', () => {
  describe('bare [[alias]] in text', () => {
    it('rewrites [[link]] into a wikilink node with alias and resolved blockId', () => {
      const tree = transform('See [[Foo]] for context.', {Foo: 'block-foo'})
      const links = collectWikilinks(tree)
      expect(links).toHaveLength(1)
      expect(links[0].data.hName).toBe('wikilink')
      expect(links[0].data.hProperties.alias).toBe('Foo')
      expect(links[0].data.hProperties.blockId).toBe('block-foo')
      expect(wikilinkChildText(links[0])).toBe('Foo')
    })

    it('emits an empty blockId when the resolver returns nothing', () => {
      const tree = transform('See [[Unknown]] here.', {})
      expect(collectWikilinks(tree)[0].data.hProperties.blockId).toBe('')
    })

    it('handles multiple links on one line', () => {
      const tree = transform('A [[one]] and [[two]] on one line.', {one: '1', two: '2'})
      const links = collectWikilinks(tree)
      expect(links.map(n => n.data.hProperties.alias)).toEqual(['one', 'two'])
      expect(links.map(n => n.data.hProperties.blockId)).toEqual(['1', '2'])
    })

    it('preserves surrounding text', () => {
      const tree = transform('before [[Foo]] after', {Foo: 'x'})
      const texts = collectText(tree)
      expect(texts).toContain('before ')
      expect(texts).toContain(' after')
    })

    it('does not touch text without [[...]]', () => {
      expect(collectWikilinks(transform('Plain text without links'))).toHaveLength(0)
    })

    it('preserves whitespace inside brackets', () => {
      const tree = transform('Hello [[  Spaced Alias  ]] world', {'  Spaced Alias  ': 'sa'})
      const link = collectWikilinks(tree)[0]
      expect(link.data.hProperties.alias).toBe('  Spaced Alias  ')
      expect(link.data.hProperties.blockId).toBe('sa')
    })

    it('does not rewrite inside inline code', () => {
      expect(collectWikilinks(transform('Inline `[[notlink]]` here'))).toHaveLength(0)
    })

    it('does not rewrite inside fenced code blocks', () => {
      expect(collectWikilinks(transform('```\n[[notlink]]\n```\n'))).toHaveLength(0)
    })

    it('emits a single span for nested [[a [[b]] c]]', () => {
      const tree = transform('Nested [[outer [[inner]] tail]] end')
      const links = collectWikilinks(tree)
      expect(links).toHaveLength(1)
      expect(links[0].data.hProperties.alias).toBe('outer [[inner]] tail')
    })
  })

  describe('link-form [display]([[alias]])', () => {
    it('rewrites the link into a wikilink with the display text as children', () => {
      const tree = transform('See [my page]([[Foo]]) here.', {Foo: 'block-foo'})
      const links = collectWikilinks(tree)
      expect(links).toHaveLength(1)
      expect(links[0].data.hProperties.alias).toBe('Foo')
      expect(links[0].data.hProperties.blockId).toBe('block-foo')
      expect(wikilinkChildText(links[0])).toBe('my page')
    })

    it('preserves rich children inside the display text', () => {
      const tree = transform('Read [the **bold** doc]([[Foo]]).', {Foo: 'x'})
      const link = collectWikilinks(tree)[0]
      expect(wikilinkChildText(link)).toBe('the bold doc')
    })

    it('leaves regular markdown links alone', () => {
      const tree = transform('A [normal](https://example.com) link.', {})
      expect(collectWikilinks(tree)).toHaveLength(0)
    })

    it('mixes link-form and bare-form on one line', () => {
      const tree = transform('Bare [[Foo]] and named [name]([[Bar]]).', {Foo: '1', Bar: '2'})
      const links = collectWikilinks(tree)
      expect(links.map(n => n.data.hProperties.alias)).toEqual(['Foo', 'Bar'])
      expect(wikilinkChildText(links[0])).toBe('Foo')
      expect(wikilinkChildText(links[1])).toBe('name')
    })

    it('handles spaced aliases that remark leaves as plain text', () => {
      // `[X]([[April 30th, 2026]])` — the space in the alias means remark
      // never produces a link node, so this lands in our text-form scan.
      const tree = transform(
        'Meeting [notes]([[April 30th, 2026]]) attached.',
        {'April 30th, 2026': 'block-date'},
      )
      const links = collectWikilinks(tree)
      expect(links).toHaveLength(1)
      expect(links[0].data.hProperties.alias).toBe('April 30th, 2026')
      expect(links[0].data.hProperties.blockId).toBe('block-date')
      expect(wikilinkChildText(links[0])).toBe('notes')
      expect(collectText(tree)).toContain('Meeting ')
      expect(collectText(tree)).toContain(' attached.')
    })

    it('handles multi-word aliases without commas', () => {
      const tree = transform('See [docs]([[Foo Bar]]) here.', {'Foo Bar': 'fb'})
      const links = collectWikilinks(tree)
      expect(links[0].data.hProperties.alias).toBe('Foo Bar')
      expect(wikilinkChildText(links[0])).toBe('docs')
    })

    it('does not mangle adjacent bare links sharing a paragraph with a spaced one', () => {
      const tree = transform(
        '[a]([[X]]) then [b]([[Long Y]]) then [[Z]] end',
        {X: 'x', 'Long Y': 'y', Z: 'z'},
      )
      const links = collectWikilinks(tree)
      expect(links.map(n => n.data.hProperties.alias)).toEqual(['X', 'Long Y', 'Z'])
      expect(links.map(wikilinkChildText)).toEqual(['a', 'b', 'Z'])
    })
  })

  describe('![[alias]] page-embed', () => {
    const collectEmbeds = (tree: Root) => {
      const out: Array<{alias: string; blockId: string; raw: string}> = []
      visit(tree, (node) => {
        if ((node as {type: string}).type === 'pageembed') {
          const props = (node as unknown as {data: {hProperties: {alias: string; blockId: string}}; value: string})
          out.push({
            alias: props.data.hProperties.alias,
            blockId: props.data.hProperties.blockId,
            raw: props.value,
          })
        }
      })
      return out
    }

    it('rewrites ![[Foo]] as a pageembed', () => {
      const tree = transform('See ![[Foo]] for context.', {Foo: 'block-foo'})
      const embeds = collectEmbeds(tree)
      expect(embeds).toEqual([{alias: 'Foo', blockId: 'block-foo', raw: '![[Foo]]'}])
      // And no wikilink for the same span.
      expect(collectWikilinks(tree)).toHaveLength(0)
    })

    it('does not consume the ! when the bracket pair is bare [[Foo]]', () => {
      const tree = transform('![[Foo]]', {Foo: 'x'})
      const embeds = collectEmbeds(tree)
      expect(embeds).toHaveLength(1)
      expect(embeds[0].raw).toBe('![[Foo]]')
    })

    it('mixes embed and bare wikilink in the same paragraph', () => {
      const tree = transform('Embed ![[A]] with link [[B]] inline.', {A: 'a', B: 'b'})
      const embeds = collectEmbeds(tree)
      const links = collectWikilinks(tree)
      expect(embeds).toEqual([{alias: 'A', blockId: 'a', raw: '![[A]]'}])
      expect(links.map(l => l.data.hProperties.alias)).toEqual(['B'])
    })
  })

  describe('GFM autolink-literal interaction', () => {
    const collectEmbeds = (tree: Root) => {
      const out: Array<{alias: string; blockId: string; raw: string}> = []
      visit(tree, (node) => {
        if ((node as {type: string}).type === 'pageembed') {
          const props = (node as unknown as {data: {hProperties: {alias: string; blockId: string}}; value: string})
          out.push({
            alias: props.data.hProperties.alias,
            blockId: props.data.hProperties.blockId,
            raw: props.value,
          })
        }
      })
      return out
    }

    it('reassembles [[email@host]] split into text + link + text by gfm', () => {
      const tree = transformWithGfm('[[foo@example.com]]', {'foo@example.com': 'block-foo'})
      const links = collectWikilinks(tree)
      expect(links).toHaveLength(1)
      expect(links[0].data.hProperties.alias).toBe('foo@example.com')
      expect(links[0].data.hProperties.blockId).toBe('block-foo')
      expect(wikilinkChildText(links[0])).toBe('foo@example.com')
    })

    it('reassembles [[https://url]] split by gfm autolink-literal', () => {
      const tree = transformWithGfm('[[https://example.com]]', {'https://example.com': 'block-url'})
      const links = collectWikilinks(tree)
      expect(links).toHaveLength(1)
      expect(links[0].data.hProperties.alias).toBe('https://example.com')
      expect(links[0].data.hProperties.blockId).toBe('block-url')
    })

    it('preserves surrounding text around a reassembled email wikilink', () => {
      const tree = transformWithGfm(
        'before [[foo@example.com]] after',
        {'foo@example.com': 'x'},
      )
      const links = collectWikilinks(tree)
      expect(links).toHaveLength(1)
      const texts = collectText(tree)
      expect(texts).toContain('before ')
      expect(texts).toContain(' after')
    })

    it('reassembles multiple email wikilinks in one paragraph', () => {
      const tree = transformWithGfm(
        'See [[a@x.com]] and [[b@y.com]] please.',
        {'a@x.com': '1', 'b@y.com': '2'},
      )
      const links = collectWikilinks(tree)
      expect(links.map(l => l.data.hProperties.alias)).toEqual(['a@x.com', 'b@y.com'])
      expect(links.map(l => l.data.hProperties.blockId)).toEqual(['1', '2'])
      const texts = collectText(tree)
      expect(texts).toContain('See ')
      expect(texts).toContain(' and ')
      expect(texts).toContain(' please.')
    })

    it('reassembles an alias whose interior also contains an email', () => {
      // GFM autolinks `john@example.com` inside the brackets; the alias is the
      // whole bracketed phrase.
      const tree = transformWithGfm(
        '[[meet john@example.com soon]]',
        {'meet john@example.com soon': 'block-y'},
      )
      const links = collectWikilinks(tree)
      expect(links).toHaveLength(1)
      expect(links[0].data.hProperties.alias).toBe('meet john@example.com soon')
      expect(links[0].data.hProperties.blockId).toBe('block-y')
    })

    it('reassembles ![[email@host]] as a pageembed', () => {
      const tree = transformWithGfm(
        '![[user@example.com]]',
        {'user@example.com': 'block-x'},
      )
      expect(collectWikilinks(tree)).toHaveLength(0)
      const embeds = collectEmbeds(tree)
      expect(embeds).toEqual([
        {alias: 'user@example.com', blockId: 'block-x', raw: '![[user@example.com]]'},
      ])
    })

    it('mixes simple bare and email wikilinks in one paragraph', () => {
      const tree = transformWithGfm(
        '[[plain]] and [[user@x.com]] together',
        {plain: 'p', 'user@x.com': 'u'},
      )
      const links = collectWikilinks(tree)
      expect(links.map(l => l.data.hProperties.alias)).toEqual(['plain', 'user@x.com'])
      expect(links.map(l => l.data.hProperties.blockId)).toEqual(['p', 'u'])
    })

    it('does not reassemble across a regular markdown link inside [[…]]', () => {
      // `[foo](foo)` is a regular markdown link, NOT a GFM autolink-literal,
      // even though its url happens to equal its display text. Reassembling
      // here would silently rewrite the alias and lose the link.
      const tree = transformWithGfm('[[a [foo](foo) b]]', {})
      expect(collectWikilinks(tree)).toHaveLength(0)
      // The inline `[foo](foo)` link should survive intact.
      const linkUrls: string[] = []
      visit(tree, 'link', (node) => {
        linkUrls.push((node as {url: string}).url)
      })
      expect(linkUrls).toEqual(['foo'])
    })

    it('does not reassemble across a `<…>` markdown autolink inside [[…]]', () => {
      const tree = transformWithGfm('[[before <https://example.com> after]]', {})
      expect(collectWikilinks(tree)).toHaveLength(0)
      const linkUrls: string[] = []
      visit(tree, 'link', (node) => {
        linkUrls.push((node as {url: string}).url)
      })
      expect(linkUrls).toEqual(['https://example.com'])
    })

    it('marks bare [[…]] wikilinks with hasCustomDisplay=false', () => {
      const tree = transform('See [[Foo]] here.', {Foo: 'x'})
      const links = collectWikilinks(tree)
      expect(links[0].data.hProperties.hasCustomDisplay).toBe(false)
    })

    it('marks [display]([[alias]]) wikilinks with hasCustomDisplay=true', () => {
      const tree = transform('See [my page]([[Foo]]) here.', {Foo: 'x'})
      const links = collectWikilinks(tree)
      expect(links[0].data.hProperties.hasCustomDisplay).toBe(true)
    })

    it('marks text-form [display]([[Spaced Alias]]) with hasCustomDisplay=true', () => {
      const tree = transform(
        'Meeting [notes]([[April 30th, 2026]]) attached.',
        {'April 30th, 2026': 'x'},
      )
      const links = collectWikilinks(tree)
      expect(links[0].data.hProperties.hasCustomDisplay).toBe(true)
    })

    it('marks reassembled cross-node [[email@host]] with hasCustomDisplay=false', () => {
      const tree = transformWithGfm('[[foo@example.com]]', {'foo@example.com': 'x'})
      const links = collectWikilinks(tree)
      expect(links[0].data.hProperties.hasCustomDisplay).toBe(false)
    })

    it('leaves a bare email autolink alone when it is not wrapped in [[…]]', () => {
      const tree = transformWithGfm('contact foo@example.com here', {})
      expect(collectWikilinks(tree)).toHaveLength(0)
      // The autolink itself should still be present.
      const links: Array<{url: string}> = []
      visit(tree, 'link', (node) => {
        links.push({url: (node as {url: string}).url})
      })
      expect(links).toHaveLength(1)
      expect(links[0].url).toBe('mailto:foo@example.com')
    })
  })
})

describe('rewriting a [display]([[alias]]) wikilink, end to end', () => {
  // The claim the rename/merge rewrite rests on, asserted on NODE VALUES
  // through the real pipeline rather than on node counts (Codex on PR #444
  // found the bug this pins; counting nodes would have missed it, since
  // both the broken and the fixed form yield exactly one node).
  const UUID = '11111111-2222-4333-8444-555555555555'
  const pipeline = (md: string) => {
    const processor = unified()
      .use(remarkParse)
      .use(remarkWikilinks, {resolveAlias: (a: string) => (a === 'Old' ? 't' : undefined)})
      .use(remarkBlockrefs)
    return processor.runSync(processor.parse(md) as Root) as Root
  }
  const nodeTypes = (tree: Root): string[] => {
    const out: string[] = []
    visit(tree, (n) => out.push((n as {type: string}).type))
    return out
  }

  it('is a wikilink before any rewrite, displaying the wrapper text', () => {
    const links = collectWikilinks(pipeline('[label]([[Old]])'))
    expect(links).toHaveLength(1)
    expect(links[0].data.hProperties.alias).toBe('Old')
    expect(links[0].data.hProperties.blockId).toBe('t')
    expect(wikilinkChildText(links[0])).toBe('label')
  })

  it('becomes a plain markdown LINK if only the inner span is pinned', () => {
    // The pre-fix output. Not a wikilink and not a blockref — the URL is
    // the pinned span as literal text, so the reference is gone while the
    // stored edge has already moved to the target.
    const tree = pipeline(`[label]([Old](((${UUID}))))`)
    expect(collectWikilinks(tree)).toHaveLength(0)
    expect(nodeTypes(tree)).not.toContain('blockref')
    expect(nodeTypes(tree)).toContain('link')
  })

  it('becomes a blockref keeping the display text when the whole wrapper is pinned', () => {
    // What the fixed rewrite emits.
    const tree = pipeline(`[label](((${UUID})))`)
    const refs: Array<{type: string; value?: string}> = []
    visit(tree, (n) => {
      const node = n as {type: string; value?: string}
      if (node.type === 'blockref') refs.push(node)
    })
    expect(refs).toHaveLength(1)
    expect(collectText(tree)).toEqual(['label'])
  })

  it('stays a wikilink when the inner span takes the wikilink form', () => {
    // Why the wikilink branch needs no widening.
    const links = collectWikilinks(pipeline('[label]([[New]])'))
    expect(links).toHaveLength(1)
    expect(links[0].data.hProperties.alias).toBe('New')
    expect(wikilinkChildText(links[0])).toBe('label')
  })
})

// The cap must hold for EVERY shape this plugin recognises, not just the
// bare scan. Passes 1 and 2 match the `[display]([[alias]])` wrapper with
// their own regexes and never call `parseOutermostReferences`, so without
// an explicit re-check they would render a live link for a span the
// reference index treats as literal text (Codex on PR #540).
describe('MAX_ALIAS_LENGTH holds across all four passes', () => {
  // Bracket- and newline-free, so it can reach every pass. Kept just over
  // and just under the cap so each pair isolates the length rule alone —
  // the under-cap half is what distinguishes "capped" from "broken".
  const over = 'a'.repeat(MAX_ALIAS_LENGTH + 1)
  const under = 'a'.repeat(MAX_ALIAS_LENGTH)
  // Spaces force remark to leave the wrapper as raw text, which is what
  // routes it to pass 2 (LINK_FORM_RE) instead of pass 1 (LINK_URL_RE).
  const spaced = (n: number) => 'ab '.repeat(Math.ceil(n / 3)).slice(0, n).trim()

  it('pass 3 (bare span) drops an over-cap alias and keeps the text literal', () => {
    const tree = transform(`see [[${over}]] here`)
    expect(collectWikilinks(tree)).toEqual([])
    expect(collectText(tree).join('')).toBe(`see [[${over}]] here`)
  })

  it('pass 1 (link destination) drops an over-cap alias', () => {
    expect(collectWikilinks(transform(`[display]([[${over}]])`))).toEqual([])
    const kept = collectWikilinks(transform(`[display]([[${under}]])`))
    expect(kept).toHaveLength(1)
    expect(kept[0].data.hProperties.alias).toBe(under)
    expect(wikilinkChildText(kept[0])).toBe('display')
  })

  // Declining is not enough on this path. remark has ALREADY made the
  // wrapper a `link` node before the visitor runs, so leaving it alone
  // renders `<a href="[[…]]">display</a>` — the app's anchor component
  // only special-cases external hrefs, and react-markdown's default
  // urlTransform passes a colon-less string through, so a click is a
  // relative navigation away from the page. Assert on the surviving NODE,
  // not just on the absence of a wikilink: "no wikilink" was true of the
  // clickable-anchor bug too (Codex on PR #540).
  it('pass 1 leaves no navigable link node behind for a rejected alias', () => {
    const tree = transform(`[display]([[${over}]])`)
    const links: string[] = []
    visit(tree, 'link', (node) => { links.push(node.url) })
    expect(links).toEqual([])
    expect(collectText(tree).join('')).toBe(`[display]([[${over}]])`)
  })

  it('pass 2 (text-form wrapper) drops an over-cap alias', () => {
    const overSpaced = spaced(MAX_ALIAS_LENGTH + 30)
    const underSpaced = spaced(MAX_ALIAS_LENGTH - 30)
    expect(overSpaced.length).toBeGreaterThan(MAX_ALIAS_LENGTH)
    expect(underSpaced.length).toBeLessThanOrEqual(MAX_ALIAS_LENGTH)

    expect(collectWikilinks(transform(`[display]([[${overSpaced}]])`))).toEqual([])
    const kept = collectWikilinks(transform(`[display]([[${underSpaced}]])`))
    expect(kept).toHaveLength(1)
    expect(kept[0].data.hProperties.alias).toBe(underSpaced)
    expect(wikilinkChildText(kept[0])).toBe('display')
  })

  // Known divergence, pinned so it is visible rather than folklore. The
  // index parses RAW content; this plugin parses what remark produced,
  // with backslash escapes already resolved. So the two sides measure —
  // and name — different strings whenever escapes are present. That is a
  // property of the alias VALUE at every length (`[[a\.b]]` is stored as
  // `a\.b` and rendered as `a.b`), predates the cap, and is already
  // documented at `faithfulWikilinkReplacement`. Tracked in #542; closing
  // it means parsing the index side through markdown too. Update this
  // test deliberately when that lands — do not "fix" it in passing.
  it('measures the DECODED alias, which an escaped span makes shorter than raw', () => {
    const escaped = '\\.'.repeat(MAX_ALIAS_LENGTH / 2 + 50)
    expect(escaped.length).toBeGreaterThan(MAX_ALIAS_LENGTH)

    // Raw is over the cap, so the index stores nothing for this span.
    expect(parseReferences(`[[${escaped}]]`)).toEqual([])

    // Decoded is under it, so the renderer still emits a wikilink — one
    // that resolves to nothing, exactly as it did before the cap existed
    // (the index never held this decoded name either way). The cap's
    // effect here is that no phantom page gets minted for the raw form.
    const links = collectWikilinks(transform(`[[${escaped}]]`))
    expect(links).toHaveLength(1)
    expect(links[0].data.hProperties.alias).toBe('.'.repeat(escaped.length / 2))
    expect(links[0].data.hProperties.blockId).toBe('')
  })

  it('pass 4 (cross-node reassembly) drops an over-cap alias', () => {
    // GFM splits the email into its own link node mid-span, so the bare
    // scan can't see it and the reassembly pass owns this text.
    const filler = 'a'.repeat(MAX_ALIAS_LENGTH)
    expect(collectWikilinks(transformWithGfm(`[[${filler} user@example.com]]`))).toEqual([])
    const short = collectWikilinks(transformWithGfm('[[note user@example.com]]'))
    expect(short).toHaveLength(1)
    expect(short[0].data.hProperties.alias).toBe('note user@example.com')
  })
})

