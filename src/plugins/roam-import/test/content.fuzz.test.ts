// @vitest-environment node
/**
 * Fuzz suite for the Roam → our-markdown content rewrite in `../content.ts`.
 * See `src/test/fuzz.ts` for smoke/deep tier mechanics and `docs/fuzzing.md`
 * for conventions.
 *
 * The importer writes the rewrite's output as the block's content, so these
 * are the properties that keep an import from changing what a user wrote:
 *
 * 1. With nothing to resolve, the rewrite only changes markup: the text minus
 *    `[`, `]` and `#` is unchanged, so no word of a note is lost or added.
 * 2. The planner mints a placeholder for every uid `collectContentRefUids`
 *    reports; the rewrite must look up no uid outside that set, and given
 *    those it leaves nothing unresolved.
 * 3. Code spans and fences pass through verbatim, whatever they hold.
 */
import fc from 'fast-check'
import {describe, expect, it} from 'vitest'
import {fuzzParams, fuzzTestTimeout} from '@/test/fuzz'
import {collectContentRefUids, rewriteRoamContent} from '../content'

const PROSE_TOKENS = [
  'a', 'b', 'word', ' ', ' ', '\n', ':', '/', '\\', '!', '-',
  '#', '##', '#tag', '#a/b', '#[[two words]]', 'x#y', '[[', ']]', '[', ']', '(', ')', '((', '))',
  '[[Page]]', '[[Promo #L6]]', '[lbl](', '](', 'https://x.io/#frag', '[l](https://x.io/#f)',
  '((uidA))', '((uid-B_2))', '[label](((uidA)))', '[a]((uidC))',
]
const DIRECTIVE_TOKENS = [
  '{{embed: ((uidA))}}', '{{[[embed]]: ((uidD))}}', '{{ embed-path :: ((uidE)) }}',
  '{{[[embed-path]]: ((uidA))}}', '{{', '}}', '{', '}',
]
const CODE_TOKENS = ['`', '```', '`#tag`', '`((uidF))`']

const textOf = (tokens: readonly string[]) =>
  fc.array(fc.constantFrom(...tokens), {maxLength: 30, size: 'medium'}).map(parts => parts.join(''))

const stripMarkup = (s: string) => s.replace(/[[\]#]/g, '')

/** A uid map that records every uid the rewrite asks it about. */
class RecordingMap extends Map<string, string> {
  readonly asked = new Set<string>()
  override get(key: string): string | undefined {
    this.asked.add(key)
    return super.get(key)
  }
}

const uuidFor = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`

describe('rewriteRoamContent fuzz', () => {
  it('changes only markup when there is nothing to resolve', () => {
    fc.assert(fc.property(textOf([...PROSE_TOKENS, ...CODE_TOKENS]), raw => {
      const {content} = rewriteRoamContent(raw, new Map())
      expect(stripMarkup(content)).toBe(stripMarkup(raw))
    }), fuzzParams(300))
  }, fuzzTestTimeout())

  it('looks up only the uids the planner collects, and resolves all of them', () => {
    fc.assert(fc.property(textOf([...PROSE_TOKENS, ...DIRECTIVE_TOKENS, ...CODE_TOKENS]), raw => {
      const collected = collectContentRefUids(raw)
      const uidMap = new RecordingMap(collected.map((uid, i) => [uid, uuidFor(i)]))
      const {unresolvedBlockUids, embedPathTargets} = rewriteRoamContent(raw, uidMap)
      expect([...uidMap.asked].filter(uid => !collected.includes(uid))).toEqual([])
      expect(unresolvedBlockUids).toEqual([])
      const minted = new Set(uidMap.values())
      expect(embedPathTargets.filter(target => !minted.has(target))).toEqual([])
    }), fuzzParams(300))
  }, fuzzTestTimeout())

  it('passes code spans and fences through verbatim', () => {
    const noBackticks = textOf([...PROSE_TOKENS, ...DIRECTIVE_TOKENS])
    const arb = fc.record({
      before: noBackticks,
      code: noBackticks,
      after: noBackticks,
      fence: fc.constantFrom('`', '```'),
    })
    fc.assert(fc.property(arb, ({before, code, after, fence}) => {
      // An inline span closes at the first backtick, so a fence's opening
      // must not abut one; the text arbitraries hold none.
      const span = `${fence}${code}${fence}`
      const raw = `${before}${span}${after}`
      const collected = collectContentRefUids(raw)
      const uidMap = new Map(collected.map((uid, i) => [uid, uuidFor(i)]))
      expect(rewriteRoamContent(raw, uidMap).content).toContain(span)
    }), fuzzParams(300))
  }, fuzzTestTimeout())
})
