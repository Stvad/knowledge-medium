/**
 * Property: a re-sealed page opens, under the workspace key and each row's own
 * AAD, to exactly its input, at any page size; a row the server already holds
 * sealed is left byte for byte as it was. See `src/test/fuzz.ts` for the
 * smoke/deep tiers.
 *
 * Plaintext is drawn from well-formed Unicode only (`unit: 'binary'`): the
 * server's TEXT columns cannot hold a lone surrogate, and `seal` would replace
 * one with U+FFFD for reasons unrelated to the re-seal (aead.fuzz.test.ts).
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import { resealWorkspace } from './reseal.js'
import type { ContentColumns } from './conversionServer.js'
import { contentColumnsOf } from './sealing.js'
import { flipUnder, keyOf, openRow, sealFor, WS } from './test/conversionFixtures.js'
import { FakeConversionServer } from './test/fakeConversionServer.js'

const rowArb = fc.record({
  content: fc.string({unit: 'binary'}),
  properties_json: fc.string({unit: 'binary'}),
  references_json: fc.string({unit: 'binary'}),
  deleted: fc.boolean(),
  alreadySealed: fc.boolean(),
})

describe('resealWorkspace (property)', () => {
  it('seals every page to exactly its input and leaves sealed rows alone', async () => {
    const wk = await keyOf(1)
    await fc.assert(
      fc.asyncProperty(fc.array(rowArb, {maxLength: 9}), fc.integer({min: 1, max: 4}), async (rows, pageSize) => {
        const server = new FakeConversionServer()
        const plaintext = new Map<string, ContentColumns>()
        for (const [i, {alreadySealed, deleted, ...columns}] of rows.entries()) {
          const identity = {id: `b${String(i).padStart(2, '0')}`, workspace_id: WS}
          server.insert({...identity, deleted, ...alreadySealed ? await sealFor(wk, identity, columns) : columns})
          if (!alreadySealed) plaintext.set(identity.id, columns)
        }
        await flipUnder(server, wk)
        const before = server.workspaceRows(WS)

        const result = await resealWorkspace({server, workspaceId: WS, wk, pageSize})

        expect(result).toEqual({scanned: rows.length, sealed: plaintext.size})
        for (const row of before) {
          const expected = plaintext.get(row.id)
          if (expected) expect(await openRow(wk, server.row(row.id))).toEqual(contentColumnsOf(expected))
          else expect(server.row(row.id)).toEqual(row)
        }
      }),
      fuzzParams(25),
    )
  }, fuzzTestTimeout())
})
