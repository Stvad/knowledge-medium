// @vitest-environment node
import {describe, expect, it} from 'vitest'
import {createElement, type ReactNode} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import Markdown, {type Components} from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {Root} from 'mdast'
import type {PluggableList} from 'unified'
import {remarkWikilinks} from '@/plugins/references/markdown/wikilinks/remark-wikilinks.js'
import {remarkBlockrefs} from '@/plugins/references/markdown/blockrefs/remark-blockrefs.js'
import {remarkTimestamps} from '@/plugins/video-player/remark-timestamps.js'
import {rehypeTrimBlockSeparators} from '@/markdown/blockSeparators.js'
import type {HighlightRange} from './highlights.ts'
import type {Block} from '@/data/block'
import type {BlockContextType} from '@/types.js'
import {
  remarkAnnotationMarks,
  THREAD_HIGHLIGHTS_INPUT,
  renderedSourceKey,
  threadMarksMarkdownExtension,
  type AnnotationMarksOptions,
} from './readHighlights.ts'
import {fnv1a32Hex} from '@/utils/fnv1a.js'
import type {ThreadSummary} from './summaries.ts'
import {highlightsOf} from './ui.tsx'

type Props = {node?: {properties?: Record<string, unknown>}; children?: ReactNode}
const show = (tag: string) => ({node, children}: Props) =>
  createElement(`x-${tag}`, {'data-props': JSON.stringify(node?.properties ?? {})}, children)

const components = {
  wikilink: show('wikilink'), pageembed: show('pageembed'), blockref: show('blockref'), blockembed: show('blockembed'),
  'time-stamp': show('timestamp'),
} as unknown as Components

/** The production order: gfm, the reference and timestamp plugins, then the
 *  marks; plus the block-separator rehype pass that reads positions. */
const render = (content: string, ranges: readonly HighlightRange[] | null, resolvedAgainst = content): string => {
  const remarkPlugins: PluggableList = [
    remarkGfm,
    [remarkWikilinks, {resolveAlias: (alias: string) => `id-${alias}`}],
    remarkBlockrefs,
    remarkTimestamps,
    ...(ranges ? [[remarkAnnotationMarks, {content: resolvedAgainst, ranges}]] as PluggableList : []),
  ]
  return renderToStaticMarkup(createElement(Markdown, {
    remarkPlugins, rehypePlugins: [rehypeTrimBlockSeparators], components,
  }, content))
}

const MARK = /<mark class="([^"]*)">([\s\S]*?)<\/mark>/g
const stripMarks = (html: string) => html.replace(/<mark class="[^"]*">|<\/mark>/g, '')
const marks = (html: string) => [...html.matchAll(MARK)].map(m => ({moved: m[1].includes("km-annotation-highlight-moved"), html: m[2]}))

const range = (content: string, quote: string, moved = false, nth = 0): HighlightRange => {
  let from = -1
  for (let i = 0; i <= nth; i++) from = content.indexOf(quote, from + 1)
  if (from < 0) throw new Error(`no ${quote}`)
  return {from, to: from + quote.length, moved}
}

/** The marks change nothing else: the same tree renders once they are taken
 *  out, reference nodes and their occurrence ids included. */
const marked = (content: string, ranges: readonly HighlightRange[]) => {
  const html = render(content, ranges)
  expect(stripMarks(html)).toBe(render(content, null))
  return marks(html)
}

describe('read-mode marks', () => {
  it('marks plain text exactly', () => {
    const content = 'We moved the launch to Thursday because the vendor slipped.'
    expect(marked(content, [range(content, 'Thursday')])).toEqual([{moved: false, html: 'Thursday'}])
    expect(marked(content, [range(content, 'We moved')])).toEqual([{moved: false, html: 'We moved'}])
    expect(marked(content, [range(content, 'slipped.')])).toEqual([{moved: false, html: 'slipped.'}])
  })

  it('keeps references inside a quote whole and live', () => {
    const content = 'Please see [[Launch plan]] and ((0b4a1f6e-1c2d-4e5f-8a9b-0c1d2e3f4a5b)) before Friday.'
    const [mark] = marked(content, [range(content, 'see [[Launch plan]] and ((0b4a1f6e-1c2d-4e5f-8a9b-0c1d2e3f4a5b)) before')])
    expect(mark.html).toContain('<x-wikilink')
    expect(mark.html).toContain('<x-blockref')
  })

  it('keeps a page embed and an aliased wikilink inside a quote, with their occurrence ids', () => {
    const content = 'Before ![[Spec]] and [the spec]([[Spec]]) after.'
    const [mark] = marked(content, [range(content, '![[Spec]] and [the spec]([[Spec]])')])
    expect(mark.html).toContain('<x-pageembed')
    expect(mark.html).toContain('&quot;hasCustomDisplay&quot;:true')
  })

  it('reassembles a wikilink the parser split around an autolink', () => {
    const content = 'Ask [[alex@example.com]] today.'
    const [mark] = marked(content, [range(content, '[[alex@example.com]]')])
    expect(mark.html).toContain('<x-wikilink')
  })

  it('keeps two highlighted occurrences of the same page embed apart', () => {
    const content = 'One ![[a@example.com]] and two ![[a@example.com]] here.'
    const result = marked(content, [range(content, '![[a@example.com]]'), range(content, '![[a@example.com]]', false, 1)])
    expect(result).toHaveLength(2)
    const ids = result.map(m => /occurrenceId&quot;:&quot;([^&]*)&quot;/.exec(m.html)?.[1])
    expect(new Set(ids).size).toBe(2)
  })

  it('marks a timestamp whole, and draws nothing for a range that cuts one', () => {
    const content = 'Watch 1:23:45 next.'
    expect(marked(content, [range(content, '1:')])).toEqual([])
    expect(marked(content, [range(content, '45 next')])).toEqual([])
    const [mark] = marked(content, [range(content, 'Watch 1:23:45')])
    expect(mark.html).toContain('<x-timestamp')
  })

  it('places text after a token whose source is not knowable, aligning back from the end', () => {
    // A link-form wikilink keeps no raw source; the timestamp split leaves the
    // text after it positionless too.
    const content = '[the spec]([[Spec]]) then see 1:23 later.'
    const [mark] = marked(content, [range(content, 'see 1:23')])
    expect(mark.html).toBe('see <x-timestamp data-props="{&quot;hms&quot;:&quot;1:23&quot;}">1:23</x-timestamp>')
  })

  it('draws nothing for a range that cuts a reference span', () => {
    const content = 'Please see [[Launch plan]] soon.'
    expect(marked(content, [range(content, 'see [[Launch')])).toEqual([])
    expect(marked(content, [range(content, 'plan]] soon')])).toEqual([])
  })

  it('marks across emphasis, one mark per side of the markup', () => {
    const content = 'A **bold claim** here.'
    expect(marked(content, [range(content, 'claim** here')]).map(m => m.html)).toEqual(['claim', ' here'])
    expect(marked(content, [range(content, '**bold claim**')]).map(m => m.html)).toEqual(['<strong>bold claim</strong>'])
    expect(marked(content, [range(content, 'bold')]).map(m => m.html)).toEqual(['bold'])
  })

  it('marks inline code whole, and draws nothing for a range inside it', () => {
    const content = 'Run `pnpm test` now.'
    expect(marked(content, [range(content, '`pnpm test` now')]).map(m => m.html)).toEqual(['<code>pnpm test</code> now'])
    expect(marked(content, [range(content, 'pnpm')])).toEqual([])
    expect(marked(content, [range(content, 'test` now')])).toEqual([])
  })

  it('draws nothing inside text whose rendered value differs from its source', () => {
    const content = 'A \\*literal\\* star &amp; more.'
    expect(marked(content, [range(content, 'literal')])).toEqual([])
    expect(marked(content, [{from: 0, to: content.length, moved: false}]).map(m => m.html)).toEqual(['A *literal* star &amp; more.'])
  })

  it('marks text the autolink literal split, by its recovered position', () => {
    const content = 'Notes at https://example.com/a and more after it.'
    expect(marked(content, [range(content, 'at https://example.com/a and')]).map(m => m.html))
      .toEqual(['at <a href="https://example.com/a">https://example.com/a</a> and'])
    expect(marked(content, [range(content, 'more')]).map(m => m.html)).toEqual(['more'])
    expect(marked(content, [range(content, 'example')]).map(m => m.html)).toEqual(['example'])
  })

  it('follows line breaks and non-ASCII text', () => {
    const content = 'Première ligne 🚀\nseconde ligne'
    expect(marked(content, [range(content, '🚀\nseconde')]).map(m => m.html)).toEqual(['🚀\nseconde'])
  })

  it('splits overlapping quotes into one mark per style, exact over moved', () => {
    const content = 'one two three four'
    const result = marked(content, [range(content, 'one two three'), range(content, 'two three four', true)])
    expect(result).toEqual([{moved: false, html: 'one two three'}, {moved: true, html: ' four'}])
  })

  it('marks across paragraphs and list items, one mark per text run', () => {
    const content = 'First para end.\n\n- item one\n- item two'
    expect(marked(content, [range(content, 'end.\n\n- item one')]).map(m => m.html)).toEqual(['end.', 'item one'])
  })

  it('never places text that may have been decoded, which its source can spell early', () => {
    // Each quote is spelled, one or more characters early, by the decoded
    // text of the piece beside it.
    const entity = 'See [[P]]&amp;amp;'
    expect(marked(entity, [range(entity, '&amp;')])).toEqual([])
    const escapes = 'Share \\\\[[Server]]'
    expect(marked(escapes, [{from: 6, to: 8, moved: false}])).toEqual([])
    const quoted = '> a 1:23\n> \\>[[P]] z'
    expect(marked(quoted, [{from: 9, to: 11, moved: false}])).toEqual([])
    // Plain text beside a token still draws.
    const plain = 'Tom & Jerry [[P]] later'
    expect(marked(plain, [range(plain, 'Jerry')]).map(m => m.html)).toEqual(['Jerry'])
  })

  it('keeps exact positions on split text, which the block-separator pass reads', () => {
    const content = 'a <div>\nb'
    expect(marked(content, [range(content, 'b')]).map(m => m.html)).toEqual(['b'])
  })

  it('draws nothing when the rendered content is not the content the ranges were resolved against', () => {
    const content = 'We moved the launch.'
    expect(render(content, [range(content, 'moved')], 'We moved the date.')).toBe(render(content, null))
  })
})

describe('recorded source spans', () => {
  const recorded = (content: string, ranges: readonly HighlightRange[] = [], before: PluggableList = []): string[] => {
    const html = renderToStaticMarkup(createElement(Markdown, {
      remarkPlugins: [
        remarkGfm,
        [remarkWikilinks, {resolveAlias: (alias: string) => `id-${alias}`}],
        remarkBlockrefs,
        ...before,
        [remarkAnnotationMarks, {content, ranges, sourceKey: 'B'}],
      ] as PluggableList,
      rehypePlugins: [rehypeTrimBlockSeparators],
      components,
    }, content))
    return [...html.matchAll(/<(\w[\w-]*)[^>]*? data-annotation-source="([^"]*)"/g)].map(m => `${m[1]}: ${m[2]}`)
  }

  it('records each text child of a phrasing element, in order, on that element', () => {
    expect(recorded('A **bold** claim')).toEqual(['p: B 0-2 10-16', 'strong: B 4-8'])
    expect(recorded('# Title *here*')).toEqual(['h1: B 2-8', 'em: B 9-13'])
  })

  it('records text beside a reference, which it does not look inside', () => {
    expect(recorded('see [[Launch plan]] and ((0b4a1f6e-1c2d-4e5f-8a9b-0c1d2e3f4a5b)) soon'))
      .toEqual(['p: B 0-4 19-24 64-69'])
  })

  it('records the recovered spans of text the autolink literal split', () => {
    expect(recorded('see https://example.com now')).toEqual(['p: B 0-4 23-27', 'a: B 4-23'])
  })

  it('records the pieces a highlight split, inside and outside the mark', () => {
    const content = 'see https://example.com now and then'
    expect(recorded(content, [range(content, 'now and')])).toEqual(['p: B 0-4 23-24 31-36', 'a: B 4-23', 'mark: B 24-31'])
  })

  it('records text that is not its source as unplaceable, without losing count', () => {
    expect(recorded('A \\*literal\\* star')).toEqual(['p: B -'])
    // The line break renders as <br> and a newline text of its own.
    expect(recorded('first  \nsecond')).toEqual(['p: B 0-5 - 8-14'])
  })

  it('records no entry for an empty text, which renders no node', () => {
    const leadingEmptyText = () => (tree: Root) => {
      for (const node of tree.children) if (node.type === 'paragraph') node.children.unshift({type: 'text', value: ''})
    }
    expect(recorded('plain words', [], [leadingEmptyText])).toEqual(['p: B 0-11'])
  })

  it('records a tight list item’s text on the item, where its paragraph is unwrapped', () => {
    expect(recorded('- first item\n- second **one**')).toEqual(['li: B 2-12', 'li: B 15-22', 'strong: B 24-27'])
    // A loose list keeps its paragraphs.
    expect(recorded('- first\n\n- second')).toEqual(['p: B 2-7', 'p: B 11-17'])
    // A task item adds a checkbox and a space of its own.
    expect(recorded('- [ ] task')).toEqual([])
    // An item holding a nested list gets newlines around it: only the inner item records.
    expect(recorded('- outer\n  - inner')).toEqual(['li: B 12-17'])
  })

  it('records nothing where the rendered text count is not knowable', () => {
    expect(recorded('a <b>raw</b> tag')).toEqual([])
    // The paragraph holding the reference, not the reference itself.
    expect(recorded('a [ref] here\n\n[ref]: https://example.com')).toEqual(['a: B 3-6'])
  })

  it('records and draws nothing after a byte-order mark, which shifts every parser position', () => {
    const content = '\uFEFFsee [a](b)))'
    expect(recorded(content)).toEqual([])
    expect(marks(render(content, [range(content, '))')]))).toEqual([])
  })

  it('records nothing for a static render, which has no selection to map', () => {
    const context = {block: {id: 'B'} as unknown as Block, input: {}, data: {content: 'text', references: [], workspaceId: 'ws'}}
    expect(threadMarksMarkdownExtension({...context, blockContext: {}})).toBeNull()
    expect(threadMarksMarkdownExtension({...context, blockContext: {renderScopeId: 'panel:p:B'}}))
      .toMatchObject({remarkPlugins: [[remarkAnnotationMarks, {sourceKey: renderedSourceKey('B', 'panel:p:B', 'text'), ranges: []}]]})
  })

  it('keys the render apart from one of another length even where their hashes collide', () => {
    expect(fnv1a32Hex('B\npanel:p:B\nxoeglo')).toBe(fnv1a32Hex('B\npanel:p:B\nrioms'))
    expect(renderedSourceKey('B', 'panel:p:B', 'xoeglo')).not.toBe(renderedSourceKey('B', 'panel:p:B', 'rioms'))
  })
})

describe('the highlight feed', () => {
  const B = {id: 'B'} as unknown as Block
  const thread = (commentCount: number): ThreadSummary => ({
    id: 'T', open: true, commentCount, quoterCount: 0, createdAt: 0,
    anchor: {kind: 'range', quote: 'moved', quoteStart: 3, prefix: 'We ', suffix: ' it'},
  })
  const config = (feed: unknown, blockContext: BlockContextType) => threadMarksMarkdownExtension({
    block: B, blockContext, input: {[THREAD_HIGHLIGHTS_INPUT]: feed},
    data: {content: 'We moved it', references: [], workspaceId: 'ws'},
  })
  const feed = {blockId: 'B', renderScopeId: 'panel:p:B', threads: highlightsOf([thread(1)])}

  const rangesOf = (feed: unknown, blockContext: BlockContextType) =>
    (config(feed, blockContext) as {remarkPlugins: [[unknown, AnnotationMarksOptions]]}).remarkPlugins[0][1].ranges

  it('marks only the block that set it, in the render scope that set it', () => {
    expect(rangesOf(feed, {renderScopeId: 'panel:p:B'})).toHaveLength(1)
    expect(rangesOf({...feed, blockId: 'X'}, {renderScopeId: 'panel:p:B'})).toEqual([])
    // A block shown inside itself, as `((B))` in B, inherits B's own feed
    // under the reference's own scope.
    expect(rangesOf(feed, {renderScopeId: 'embed:B:text:0:B:panel:p:B', isNestedSurface: true})).toEqual([])
    // A card sets its feed in its own nested scope, for its comments.
    const inCard = {...feed, renderScopeId: 'surface.margin:T:panel:p:B'}
    expect(rangesOf(inCard, {renderScopeId: 'surface.margin:T:panel:p:B', isNestedSurface: true})).toHaveLength(1)
  })

  it('carries what the marks read and not the comment count, so a new comment leaves it as it was', () => {
    expect(highlightsOf([thread(1)])).toEqual(highlightsOf([thread(2)]))
  })
})
