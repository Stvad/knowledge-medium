import { describe, expect, it } from 'vitest'
import {
  findLiteralMatches,
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
