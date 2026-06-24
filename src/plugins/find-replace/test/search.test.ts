import { describe, expect, it } from 'vitest'
import {
  buildContentSearchMatch,
  findLiteralMatches,
  previewForMatch,
  replaceLiteralMatches,
} from '../search.ts'

const insensitive = {matchCase: false, wholeWord: false}

describe('find/replace literal matching', () => {
  it('matches case-insensitively by default', () => {
    expect(findLiteralMatches('Alpha alpha ALPHA', 'alpha', insensitive))
      .toEqual([
        {index: 0, length: 5},
        {index: 6, length: 5},
        {index: 12, length: 5},
      ])
  })

  it('can require matching case', () => {
    expect(findLiteralMatches('Alpha alpha ALPHA', 'alpha', {
      matchCase: true,
      wholeWord: false,
    })).toEqual([{index: 6, length: 5}])
  })

  it('can require whole-word boundaries', () => {
    expect(findLiteralMatches('task tasks pretask task_done task-done', 'task', {
      matchCase: false,
      wholeWord: true,
    })).toEqual([
      {index: 0, length: 4},
      {index: 29, length: 4},
    ])
  })

  it('replaces each literal match without treating the find text as regex', () => {
    expect(replaceLiteralMatches('a.b a?b a.b', 'a.b', 'x', insensitive)).toEqual({
      content: 'x a?b x',
      replacementCount: 2,
    })
  })
})

describe('previewForMatch', () => {
  it('returns the surrounding text verbatim when it fits inside the context window', () => {
    // 'world' at index 6; default context (48) covers the whole string, so no
    // ellipsis on either side.
    expect(previewForMatch('hello world', {index: 6, length: 5})).toBe('hello world')
  })

  it('windows long content and marks both truncated sides with ellipses', () => {
    const content = 'left padding here MATCH right padding here'
    const index = content.indexOf('MATCH')
    const preview = previewForMatch(content, {index, length: 5}, 4)
    expect(preview.startsWith('...')).toBe(true)
    expect(preview.endsWith('...')).toBe(true)
    expect(preview).toContain('MATCH')
  })

  it('collapses runs of whitespace so multi-line content previews on one line', () => {
    expect(previewForMatch('a\n\n  b  MATCH  c\t\td', {index: 8, length: 5}))
      .toBe('a b MATCH c d')
  })
})

describe('buildContentSearchMatch', () => {
  it('summarizes the first hit with the total match count and a preview', () => {
    const match = buildContentSearchMatch('b1', 'find me and me again', 'me', insensitive)
    expect(match).toEqual({
      blockId: 'b1',
      originalContent: 'find me and me again',
      matchCount: 2,
      preview: 'find me and me again',
    })
  })

  it('returns null when the query does not occur in the content', () => {
    expect(buildContentSearchMatch('b1', 'nothing here', 'zzz', insensitive)).toBeNull()
  })

  it('short-circuits an empty query to null (no match, no preview)', () => {
    expect(buildContentSearchMatch('b1', 'any content', '', insensitive)).toBeNull()
  })
})
