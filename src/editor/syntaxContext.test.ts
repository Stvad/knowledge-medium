// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import { isLiteralTextAt, literalDocument } from './syntaxContext'

const at = (doc: string, literal: boolean) => {
  const state = EditorState.create({doc, extensions: [markdown({base: markdownLanguage}), ...literal ? [literalDocument.of(true)] : []]})
  ensureSyntaxTree(state, state.doc.length, 1000)
  return (needle: string) => isLiteralTextAt(state, doc.indexOf(needle) + needle.length)
}

describe('isLiteralTextAt', () => {
  it('reads prose as prose and a code span as literal', () => {
    const text = at('call #bo and `#code`', false)
    expect(text('#bo')).toBe(false)
    expect(text('#cod')).toBe(true)
  })

  it('reads all of a literal document as literal', () => {
    expect(at('call #bo', true)('#bo')).toBe(true)
  })
})
