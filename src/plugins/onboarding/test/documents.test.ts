// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { HTML_DOCUMENT_TYPE } from '@/data/blockTypes'
import { hasScripts } from '@/plugins/html-document/useDocumentScripts'
import { renderKeys } from '../documents/cheatSheet'
import { tutorialOutline, type TutorialNode, type TutorialVariant } from '../outline'

const htmlDocumentsIn = (nodes: readonly TutorialNode[]): string[] =>
  nodes.flatMap(node => [
    ...(node.type === HTML_DOCUMENT_TYPE ? [node.content] : []),
    ...htmlDocumentsIn(node.children ?? []),
  ])

describe.each<TutorialVariant>(['default', 'vim'])('the %s tutorial\'s HTML documents', variant => {
  // A document with scripts renders behind a "Run scripts" offer; the
  // diagrams and cheat sheet must show on first open.
  it('hold scripts only in the one demo that is there to show the prompt', () => {
    const documents = htmlDocumentsIn(tutorialOutline(variant))
    expect(documents.length).toBeGreaterThan(1)
    expect(documents.filter(hasScripts).map(source => source.match(/<title>(.*?)<\/title>/)?.[1]))
      .toEqual(['Focus timer'])
  })
})

describe('renderKeys', () => {
  it('turns each key of a chord into a key cap and leaves text as text', () => {
    expect(renderKeys('`Cmd+Shift+L` then click'))
      .toBe('<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> then click')
  })

  it('keeps a trailing + as the key itself and splits key sequences on spaces', () => {
    expect(renderKeys('`Cmd++`')).toBe('<kbd>Cmd</kbd>+<kbd>+</kbd>')
    expect(renderKeys('`d d`')).toBe('<kbd>d</kbd> <kbd>d</kbd>')
  })

  it('reads a double-backtick span holding a lone backtick', () => {
    expect(renderKeys('`` Ctrl+Shift+` ``')).toBe('<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>`</kbd>')
  })

  it('escapes markup in keys and text', () => {
    expect(renderKeys('`<` & more')).toBe('<kbd>&lt;</kbd> &amp; more')
  })
})
