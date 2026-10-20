import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'

const TEXT_SOURCE = /\.(?:[cm]?[jt]sx?|json|md)$/

// A raw NUL makes grep/ripgrep classify the whole file as binary, so searches
// silently skip it. Write `\u0000` in a string literal instead.
describe('tracked text sources', () => {
  it('contain no raw NUL bytes', () => {
    const files = execFileSync('git', ['ls-files', '-z'], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024})
      .split('\0')
      .filter(f => TEXT_SOURCE.test(f))
    const offenders = files.filter(f => {
      try {
        return readFileSync(f).includes(0)
      } catch {
        return false // listed but deleted in the working tree
      }
    })
    expect(offenders).toEqual([])
  }, 30_000)
})
