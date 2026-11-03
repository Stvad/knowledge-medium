import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'

// Deny-list, not allow-list: a new text format is covered by default, and a new
// binary asset fails loudly here until its extension is added.
const BINARY_ASSET = /\.(?:png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|wasm|pdf|zip|gz|sqlite3?)$/i

// A raw NUL makes grep/ripgrep classify the whole file as binary, so searches
// silently skip it. Write `\u0000` in a string literal instead.
describe('tracked text files', () => {
  it('contain no raw NUL bytes', () => {
    const files = execFileSync('git', ['ls-files', '-z'], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024})
      .split('\0')
      .filter(f => f && !BINARY_ASSET.test(f))
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
