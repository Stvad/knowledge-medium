// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { pasteDecisionVerb, type PasteDecision, type PasteRequest } from '@/paste/decision'
import { richPasteDecisionContribution } from '../pasteDecision'

const runtime = resolveFacetRuntimeSync([richPasteDecisionContribution])
const decide = (request: PasteRequest) => pasteDecisionVerb.runSync(runtime, request)

const editor = (over: Partial<Pick<PasteRequest, 'text' | 'html' | 'intent' | 'files'>>): PasteRequest => ({
  text: 'plain text',
  intent: 'split',
  surface: 'editor',
  caret: {line: 1, lineCount: 1, from: 0, to: 0},
  ...over,
})
const shell = (over: Partial<Pick<PasteRequest, 'text' | 'html'>>): PasteRequest => ({
  text: 'plain text',
  intent: 'split',
  surface: 'shell',
  ...over,
})

const STRUCTURED = '<h2>Title</h2><p>Body</p>'
const LINK = '<a href="https://example.com/">site</a>'

describe('rich paste decision', () => {
  it('pastes structured HTML as a block tree', () => {
    expect(decide(editor({text: 'Title\nBody', html: STRUCTURED}))).toEqual({
      kind: 'split',
      blocks: [{content: '## Title', children: [{content: 'Body', children: []}]}],
    })
  })

  it('pastes a single formatted line as markdown at the caret in the editor', () => {
    expect(decide(editor({text: 'site', html: LINK})))
      .toEqual({kind: 'single-block', text: '[site](https://example.com/)'})
  })

  it('pastes a single formatted line as a block from the shell', () => {
    expect(decide(shell({text: 'site', html: LINK})))
      .toEqual({kind: 'split', text: '[site](https://example.com/)'})
  })

  it.each([
    ['no html', {text: 'a\nb'}],
    ['html with nothing the text lacks', {text: 'a\nb', html: '<p>a</p><p>b</p>'}],
    ['the plain-text chord', {text: 'a\nb', html: STRUCTURED, intent: 'single-block' as const}],
    ['outliner reference syntax in the text', {text: '- [[Page]]\n- b', html: STRUCTURED}],
  ])('leaves the paste to the rest of the chain for %s', (_, over) => {
    const request = editor(over)
    expect(decide(request)).toEqual(pasteDecisionVerb.runSync(resolveFacetRuntimeSync([]), request))
  })

  describe('with files on the clipboard', () => {
    const withFiles = editor({text: 'Title\nBody', html: STRUCTURED, files: [new File(['x'], 'x.png')]})
    const mediaWhenFiles = pasteDecisionVerb.decorator(
      next => req => (req.files?.length ? {kind: 'media'} : next(req)) as PasteDecision,
    )

    it('still converts the html when nothing in the chain captures them', () => {
      expect(decide(withFiles)).toMatchObject({kind: 'split', blocks: [{content: '## Title'}]})
    })

    it.each([
      ['inside', [richPasteDecisionContribution, mediaWhenFiles]],
      ['outside', [mediaWhenFiles, richPasteDecisionContribution]],
    ])('yields to a media capture registered %s it', (_, contributions) => {
      expect(pasteDecisionVerb.runSync(resolveFacetRuntimeSync(contributions), withFiles)).toEqual({kind: 'media'})
    })
  })
})
