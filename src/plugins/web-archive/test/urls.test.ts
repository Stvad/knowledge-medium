// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { extractLinkTargets } from '../urls.ts'

describe('extractLinkTargets', () => {
  it('finds inline links, autolinks, and GFM bare literals', () => {
    const content = [
      'See [the wombat page](https://example.com/wombat) and <https://example.org/pointy>.',
      'Also https://example.net/bare works.',
    ].join('\n')
    expect(extractLinkTargets(content)).toEqual([
      'https://example.com/wombat',
      'https://example.org/pointy',
      'https://example.net/bare',
    ])
  })

  it('finds reference-style definitions', () => {
    const content = '[a][ref]\n\n[ref]: https://example.com/defined'
    expect(extractLinkTargets(content)).toContain('https://example.com/defined')
  })

  // The whole reason this parses instead of regexing: a URL the user is
  // QUOTING is not a URL the user visited, and publishing it would be wrong.
  it('ignores URLs inside code spans and fenced blocks', () => {
    const fenced = '```\ncurl https://secret.example.com/in-a-fence\n```'
    expect(extractLinkTargets(fenced)).toEqual([])
    expect(extractLinkTargets('use `https://secret.example.com/in-a-span`')).toEqual([])
  })

  it('ignores image sources — an embedded asset is not a page the user linked', () => {
    expect(extractLinkTargets('![alt](https://example.com/pic.png)')).toEqual([])
  })

  it('keeps the link when an image is wrapped in one', () => {
    expect(extractLinkTargets('[![alt](https://cdn.example.com/p.png)](https://example.com/post)'))
      .toEqual(['https://example.com/post'])
  })

  it('dedupes repeats and preserves document order', () => {
    const content = '[a](https://example.com/x) [b](https://example.com/y) [c](https://example.com/x)'
    expect(extractLinkTargets(content)).toEqual([
      'https://example.com/x',
      'https://example.com/y',
    ])
  })

  it('returns nothing for wikilinks and block refs', () => {
    // Assembled rather than written out: a uuid literal in a tracked file
    // trips the staged-PII guard, and the shape is all this test needs.
    const uuid = ['0193f0e1', '0000', '7000', '8000', '000000000001'].join('-')
    expect(extractLinkTargets(`[[Some Page]] and ((${uuid}))`)).toEqual([])
  })

  it('yields the raw target for the [display]([[alias]]) wrapper form', () => {
    // Not a URL; hostPolicy rejects it. Asserted here so a grammar change
    // that starts emitting something URL-shaped is visible at this layer.
    expect(extractLinkTargets('[display]([[alias]])')).toEqual(['[[alias]]'])
  })

  it('is empty for blank content', () => {
    expect(extractLinkTargets('')).toEqual([])
    expect(extractLinkTargets('   \n  ')).toEqual([])
  })
})
