import { describe, expect, it } from 'vitest'
// @ts-expect-error no declaration file for the script module
import { countAddedLines, countLines } from '../../scripts/comment-density.mjs'

describe('countLines', () => {
  it('counts // lines as comments', () => {
    expect(countLines('// a\n// b\nconst x = 1')).toEqual({ comment: 2, code: 1 })
  })

  it('counts a multi-line /* */ block as comment', () => {
    const text = ['/* start', ' * middle', ' */', 'const x = 1'].join('\n')
    expect(countLines(text)).toEqual({ comment: 3, code: 1 })
  })

  it('counts a single-line /* x */ as one comment line', () => {
    expect(countLines('/* x */\nconst x = 1')).toEqual({ comment: 1, code: 1 })
  })

  it('ignores blank lines', () => {
    expect(countLines('const x = 1\n\n\nconst y = 2')).toEqual({ comment: 0, code: 2 })
  })

  it('counts plain lines as code', () => {
    expect(countLines('const x = 1\nconst y = 2\nconst z = 3')).toEqual({ comment: 0, code: 3 })
  })
})

describe('countAddedLines', () => {
  it('classifies added lines per file, including a block comment spanning lines', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      'index 111..222 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,0 +2,3 @@',
      '+// a comment',
      '+const x = 1',
      '+const y = 2',
      'diff --git a/b.ts b/b.ts',
      'index 333..444 100644',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1,0 +2,4 @@',
      '+/* start',
      '+ * middle',
      '+ */',
      '+const z = 3',
    ].join('\n')

    const result = countAddedLines(diff)
    expect(result.get('a.ts')).toEqual({ comment: 1, code: 2 })
    expect(result.get('b.ts')).toEqual({ comment: 3, code: 1 })
  })
})
