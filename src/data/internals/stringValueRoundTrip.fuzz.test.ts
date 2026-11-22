// @vitest-environment node
/** A string property's value survives both directions exactly: typed into its
 *  value block it projects unchanged, and written with `setProperty` it projects
 *  unchanged and its value block reads back as it. The generator favours what a
 *  table query holds: fences, `::` lines, backticks, references, blank and
 *  trailing lines. */
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import fc from 'fast-check'
import {ChangeScope} from '@/data/api'
import {isWholeContentReference} from '@/data/referenceBlock'
import {createTestDb, type TestDb} from '@/data/test/createTestDb'
import {createStringValueHarness, queryProperty} from '@/data/test/stringValueHarness'
import {fuzzParams, fuzzTestTimeout, statefulFuzzGuard} from '@/test/fuzz'

const line = fc.oneof(
  fc.constantFrom('```', '```query', '~~~', '````', '  ```', 'key:: value', '::', '#task status=open',
    '[[Mary]]', '((0190a0c0-0000-7000-8000-000000000001))', '`code`', '\\', '', ' ', '\t'),
  fc.string({maxLength: 12}),
)
const multiLine = fc.tuple(fc.array(line, {minLength: 1, maxLength: 6}), fc.constantFrom('', '\n', '\n\n'), fc.boolean())
  .map(([lines, trailing, crlf]) => lines.join(crlf ? '\r\n' : '\n') + trailing)
  .filter(text => text.trim() !== '')
/** Whole values that cannot be stored verbatim, which the line mix rarely builds. */
const unstorable = fc.constantFrom('((0190a0c0-0000-7000-8000-000000000001))', '!((0190a0c0-0000-7000-8000-000000000001))',
  '[[Mary]]', ' "quoted" ', '"[[Mary]]"')
const value = fc.oneof({weight: 5, arbitrary: multiLine}, {weight: 1, arbitrary: unstorable})

/** Text the encoder may not store verbatim: a whole-content reference, or the
 *  quoted form of text that is one. */
const mustEscape = (text: string): boolean => {
  if (isWholeContentReference(text)) return true
  try {
    const inner: unknown = JSON.parse(text.trim())
    return typeof inner === 'string' && mustEscape(inner)
  } catch {
    return false
  }
}

let db: TestDb
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })

describe('string value round trip', () => {
  const guard = statefulFuzzGuard()
  it('keeps a multi-line value exactly, in both directions', async () => {
    await fc.assert(fc.asyncProperty(value, value, (typed, written) => guard.run(null, async () => {
      const env = await createStringValueHarness(db)
      try {
        await env.typeIntoValue(typed)
        expect(await env.projected()).toBe(typed)
        await env.repo.tx(tx => tx.setProperty(env.ownerId, queryProperty, written), {scope: ChangeScope.BlockDefault})
        expect(await env.projected()).toBe(written)
        // Verbatim, or, only for text the encoder must escape, the JSON envelope of the value.
        const [content, ...rest] = await env.valueContents()
        expect(rest).toEqual([])
        if (content !== written) {
          expect(mustEscape(written)).toBe(true)
          expect(JSON.parse(content!)).toBe(written)
        }
      } finally {
        await env.dispose()
      }
    })), fuzzParams(15))
  }, fuzzTestTimeout())
})
