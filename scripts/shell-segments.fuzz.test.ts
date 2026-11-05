// @vitest-environment node
/**
 * Fuzz suite for the shell tokenizer the Bash hooks build their verb-position
 * guards on (`shell-segments.mjs`).
 *
 * Oracle: bash's own quoting rules. Each property generates simple commands
 * as lists of arbitrary words (shell metacharacters, quotes, newlines and
 * empty words included), writes each word with one of bash's lossless
 * quotings, joins the commands with list operators, and expects the tokenizer
 * to hand back exactly those words, one segment per command. The quoting
 * functions below are written from the bash manual (QUOTING), not from the
 * tokenizer, so a word that leaks out of its quotes, splits, or loses a
 * character is a real divergence from what bash would run.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import { shellCommandsWithDepth, shellSegments } from './shell-segments.mjs'

// Characters the tokenizer treats specially somewhere, plus plain ones.
const UNITS = [...'aZ09-_./= \t\n;&|()<>$`"\'\\#*?![]{}~%@', 'é', '😀']
const word = fc.string({ unit: fc.constantFrom(...UNITS), maxLength: 12 })

/** Inside '…' every character is literal; a `'` is written as `'\''`. */
const singleQuoted = (w: string) => `'${w.replaceAll("'", `'\\''`)}'`
/** Inside "…" a backslash escapes exactly $ ` " \ (and newline, which a word never needs escaped). */
const doubleQuoted = (w: string) => `"${w.replace(/[$`"\\]/g, ch => `\\${ch}`)}"`
/** The same, with a backslash left bare where bash keeps it: before any character it cannot escape. */
const doubleQuotedBare = (w: string) => {
  const chars = [...w]
  const bare = (ch: string, next: string | undefined) => ch === '\\' && next !== undefined && !'$`"\\\n'.includes(next)
  return `"${chars.map((ch, i) => (bare(ch, chars[i + 1]) ? ch : doubleQuoted(ch).slice(1, -1))).join('')}"`
}
/** Outside quotes a backslash makes any character literal, except a newline, which it deletes. */
const backslashed = (w: string) => (w === '' ? "''" : [...w].map(ch => (ch === '\n' ? "'\n'" : `\\${ch}`)).join(''))

const QUOTINGS = [singleQuoted, doubleQuoted, doubleQuotedBare, backslashed]
/** One word written as adjacent spans, each in its own quoting: bash concatenates them into one word. */
const quotedWord = fc
  .tuple(word, fc.array(fc.tuple(fc.nat(), fc.nat({ max: QUOTINGS.length - 1 })), { minLength: 1, maxLength: 3 }))
  .map(([w, cuts]) => {
    const bounds = [0, ...new Set(cuts.map(([at]) => at % (w.length + 1))), w.length].sort((a, b) => a - b)
    const spans = bounds.slice(1).map((end, i) => w.slice(bounds[i], end))
    const written = spans.map((span, i) => QUOTINGS[cuts[i % cuts.length][1]](span)).join('')
    return { word: w, written }
  })

const command = fc.array(quotedWord, { minLength: 1, maxLength: 5 })
const commands = fc.array(command, { minLength: 1, maxLength: 4 })
const OPERATORS = [' ; ', ' && ', ' || ', ' | ', '\n', ' & ']
const operators = fc.array(fc.constantFrom(...OPERATORS), { minLength: 3, maxLength: 3 })
// Redirections are neither boundaries nor words, wherever they sit after the verb.
const REDIRECTIONS = [' 2>&1', ' >/dev/null', ' > out.txt', ' &> log', ' 2>> err', ' < in.txt']
const redirection = fc.option(fc.constantFrom(...REDIRECTIONS), { nil: undefined })

const script = (cmds: { word: string, written: string }[][], ops: string[], redirects: (string | undefined)[] = []) =>
  cmds.map((cmd, i) => cmd.map(w => w.written).join(' ') + (redirects[i] ?? '') + (i < cmds.length - 1 ? ops[i] : '')).join('')

const tokensOf = (cmds: { word: string }[][]) => cmds.map(cmd => cmd.map(w => w.word))

describe('shellSegments', () => {
  it('hands back each quoted word exactly, one segment per simple command', { timeout: fuzzTestTimeout() }, () => {
    fc.assert(
      fc.property(commands, operators, (cmds, ops) => {
        const text = script(cmds, ops)
        expect(shellSegments(text), text).toEqual(tokensOf(cmds))
      }),
      fuzzParams(300),
    )
  })

  it('drops redirections and their targets without ending the command', { timeout: fuzzTestTimeout() }, () => {
    fc.assert(
      fc.property(commands, operators, fc.array(redirection, { minLength: 4, maxLength: 4 }), (cmds, ops, redirects) => {
        const text = script(cmds, ops, redirects)
        expect(shellSegments(text), text).toEqual(tokensOf(cmds))
      }),
      fuzzParams(300),
    )
  })

  it('reads the same commands whole when there is no substitution to keep inside one', { timeout: fuzzTestTimeout() }, () => {
    fc.assert(
      fc.property(commands, operators, (cmds, ops) => {
        const text = script(cmds, ops)
        expect(shellCommandsWithDepth(text).map(s => s.tokens), text).toEqual(tokensOf(cmds))
      }),
      fuzzParams(300),
    )
  })
})
