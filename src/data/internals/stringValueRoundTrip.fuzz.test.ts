// @vitest-environment node
/** A string property's value survives both directions exactly: typed into its
 *  value block it projects unchanged, and written with `setProperty` it projects
 *  unchanged and its value block reads back as it. The generator favours what a
 *  table query holds: fences, `::` lines, backticks, references, blank and
 *  trailing lines. */
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import fc from 'fast-check'
import {ChangeScope} from '@/data/api'
import {createTestDb, type TestDb} from '@/data/test/createTestDb'
import {createStringValueHarness, queryProperty} from '@/data/test/stringValueHarness'
import {fuzzParams, fuzzTestTimeout} from '@/test/fuzz'

const line = fc.oneof(
  fc.constantFrom('```', '```query', '~~~', '````', '  ```', 'key:: value', '::', '#task status=open',
    '[[Mary]]', '((0190a0c0-0000-7000-8000-000000000001))', '`code`', '\\', '', ' ', '\t'),
  fc.string({maxLength: 12}),
)
const value = fc.tuple(fc.array(line, {minLength: 1, maxLength: 6}), fc.constantFrom('', '\n', '\n\n'), fc.boolean())
  .map(([lines, trailing, crlf]) => lines.join(crlf ? '\r\n' : '\n') + trailing)
  .filter(text => text.trim() !== '')

let db: TestDb
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })

describe('string value round trip', () => {
  it('keeps a multi-line value exactly, in both directions', async () => {
    await fc.assert(fc.asyncProperty(value, value, async (typed, written) => {
      const env = await createStringValueHarness(db)
      try {
        await env.typeIntoValue(typed)
        expect(await env.projected()).toBe(typed)
        await env.repo.tx(tx => tx.setProperty(env.ownerId, queryProperty, written), {scope: ChangeScope.BlockDefault})
        expect(await env.projected()).toBe(written)
        // Verbatim, unless the text alone would read as something else (a bare `((id))`):
        // then it is stored as the JSON-escaped envelope that reads back as the value.
        const [content, ...rest] = await env.valueContents()
        expect(rest).toEqual([])
        if (content !== written) expect(JSON.parse(content!)).toBe(written)
      } finally {
        await env.dispose()
      }
    }), fuzzParams(15))
  }, fuzzTestTimeout())
})
