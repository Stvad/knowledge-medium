import { describe, expect, it } from 'vitest'
// @ts-expect-error no declaration file for the script module
import { addedLineNumbers, classifyLines, countAddedLines, countLines } from '../../scripts/comment-density.mjs'

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

  it('counts a JSX comment container as comment, across lines', () => {
    expect(classifyLines('<div>\n  {/* one */}\n  {/* two\n     lines */}\n</div>')).toEqual(['code', 'comment', 'comment', 'comment', 'code'])
  })

  it('classifies per line', () => {
    expect(classifyLines('/**\n * doc\n */\n\nconst x = 1')).toEqual(['comment', 'comment', 'comment', 'blank', 'code'])
  })
})

describe('addedLineNumbers', () => {
  it('reads added ranges from hunk headers, including the one-line form', () => {
    const diff = ['index 111..aaa 100644', '+++ b/a.ts', '@@ -1,2 +1,3 @@', '+x', '@@ -10 +11 @@', '+y', 'index 222..bbb 100644', '+++ b/b.ts', '@@ -0,0 +1,2 @@', '+z', '+w'].join('\n')
    expect(addedLineNumbers(diff)).toEqual(new Map([['a.ts', { lines: [1, 2, 3, 11], blob: 'aaa' }], ['b.ts', { lines: [1, 2], blob: 'bbb' }]]))
  })

  it('does not attach a deleted file\'s hunk to the file before it', () => {
    const diff = ['index 0..a', '+++ b/a.ts', '@@ -0,0 +1 @@', '+x', 'index b..0', '+++ /dev/null', '@@ -1,3 +0,0 @@', '-gone', 'index 0..c', '+++ b/c.ts', '@@ -0,0 +1 @@', '+y'].join('\n')
    expect(addedLineNumbers(diff)).toEqual(new Map([['a.ts', { lines: [1], blob: 'a' }], ['c.ts', { lines: [1], blob: 'c' }]]))
  })
})

describe('countAddedLines', () => {
  const files: Record<string, string> = {
    'a.ts': ['/* opened earlier', ' * added inside the block', ' */', '++counter', 'const x = 1'].join('\n'),
    'b.ts': ['// note', 'const y = 2'].join('\n'),
  }
  const read = (file: string) => files[file]

  it('classifies added lines against the postimage, so block state and ++ lines are right', () => {
    const diff = [
      'index 1..2 100644', '+++ b/a.ts', '@@ -1,0 +2,1 @@', '+ * added inside the block', '@@ -3,0 +4,1 @@', '+++counter',
      'index 3..4 100644', '+++ b/b.ts', '@@ -0,0 +1,2 @@', '+// note', '+const y = 2',
    ].join('\n')
    expect(countAddedLines(diff, read)).toEqual(new Map([
      ['a.ts', { comment: 1, code: 1 }],
      ['b.ts', { comment: 1, code: 1 }],
    ]))
  })

  it('skips files whose hunks add nothing', () => {
    const diff = ['index 3..4 100644', '+++ b/b.ts', '@@ -1,1 +1,0 @@', '-// gone'].join('\n')
    expect(countAddedLines(diff, read)).toEqual(new Map())
  })
})
