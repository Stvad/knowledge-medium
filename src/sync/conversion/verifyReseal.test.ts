import { beforeEach, describe, expect, it } from 'vitest'
import { resealWorkspace } from './reseal.js'
import { ConversionRefusal, contentColumnsOf } from './sealing.js'
import { flipUnder, keyOf, openRow, seedPlaintext, sealFor, WS } from './test/conversionFixtures.js'
import { FakeConversionServer, type FakeBlockRow } from './test/fakeConversionServer.js'
import { sealRecordOf, verifyReseal } from './verifyReseal.js'

let wk: CryptoKey
let server: FakeConversionServer
let seeded: FakeBlockRow[]

beforeEach(async () => {
  wk = await keyOf(1)
  server = new FakeConversionServer()
  seeded = seedPlaintext(server, 5)
})

const flip = () => flipUnder(server, wk)
const reseal = (pageSize?: number) => resealWorkspace({server, workspaceId: WS, wk, pageSize})
const verify = (pageSize?: number) => verifyReseal({server, workspaceId: WS, wk, pageSize})
const patchCalls = () => server.calls.filter(call => call.method === 'applyBlockPatches').length

/** A plaintext write that committed just before the flip, which the re-seal's
 *  read of `id` did not see. */
const writeMissedByTheRead = (id: string, content: string) => {
  server.staleReads.set(id, server.row(id))
  server.write(id, {content})
}

describe('verifyReseal', () => {
  it('passes a clean re-seal without sending anything', async () => {
    await flip()
    await reseal()
    const sentBefore = patchCalls()

    expect(await verify()).toEqual({checked: 5, repaired: 0})
    expect(patchCalls()).toBe(sentBefore)
  })

  it('repairs a swapped column from before_diff', async () => {
    await flip()
    await reseal()
    const sealed = server.row('b01')
    server.write('b01', {content: sealed.properties_json, properties_json: sealed.content})

    expect(await verify()).toEqual({checked: 5, repaired: 1})
    expect(await openRow(wk, server.row('b01'))).toEqual(contentColumnsOf(seeded[1]))
  })

  it('repairs a value that opens but is another row\'s', async () => {
    await flip()
    await reseal()
    const b01 = server.row('b01')
    server.write('b01', await sealFor(wk, b01, {...contentColumnsOf(seeded[1]), content: seeded[2].content}))

    expect(await verify()).toEqual({checked: 5, repaired: 1})
    expect(await openRow(wk, server.row('b01'))).toEqual(contentColumnsOf(seeded[1]))
  })

  it('repairs a stale read that overwrote a write in flight at the flip', async () => {
    writeMissedByTheRead('b02', 'written at the flip')
    await flip()
    await reseal()
    expect((await openRow(wk, server.row('b02'))).content).toBe('text 2')

    expect(await verify()).toEqual({checked: 5, repaired: 1})
    expect(await openRow(wk, server.row('b02'))).toEqual({...contentColumnsOf(seeded[2]), content: 'written at the flip'})
  })

  it('still verifies a row whose commit came just before a crash', async () => {
    writeMissedByTheRead('b00', 'written at the flip')
    await flip()
    server.afterPatch = () => {
      server.afterPatch = undefined
      throw new Error('crash')
    }
    await expect(reseal(2)).rejects.toThrow('crash')

    await reseal(2)
    expect(await verify(2)).toEqual({checked: 5, repaired: 1})
    expect((await openRow(wk, server.row('b00'))).content).toBe('written at the flip')
  })

  it('passes a row whose plaintext merely looked sealed', async () => {
    const looksSealed = `enc:v1:${'A'.repeat(38)}`
    server.write('b01', {content: looksSealed})
    await flip()
    await reseal()

    expect(await verify()).toEqual({checked: 5, repaired: 0})
    expect((await openRow(wk, server.row('b01'))).content).toBe(looksSealed)
  })

  it('does not pass when the session is lost for the whole run', async () => {
    await flip()
    await reseal()
    const readWorkspace = server.readWorkspace.bind(server)
    server.readWorkspace = async workspaceId => {
      const workspace = await readWorkspace(workspaceId)
      server.signedOut = true
      return workspace
    }

    await expect(verify()).rejects.toThrow('not visible to this session')
  })

  it('does not pass over the rows a lost session hid', async () => {
    await flip()
    await reseal()
    const readHistory = server.readContentSealHistory.bind(server)
    server.readContentSealHistory = async (workspaceId, ids) => {
      const rows = await readHistory(workspaceId, ids)
      server.signedOut = true
      return rows
    }
    const countBlocks = server.countBlocks.bind(server)
    server.countBlocks = async workspaceId => {
      server.signedOut = false
      return countBlocks(workspaceId)
    }

    await expect(verify(2)).rejects.toThrow('verify checked 2 of the workspace\'s 5 rows')
  })

  it('refuses a key that does not open the canary, before sending anything', async () => {
    await flip()
    await reseal()
    const sentBefore = patchCalls()

    await expect(verifyReseal({server, workspaceId: WS, wk: await keyOf(2)})).rejects.toEqual(new ConversionRefusal('wrong-key'))
    expect(patchCalls()).toBe(sentBefore)
  })

  it('refuses a row inserted already sealed, even once a re-seal-shaped write followed', async () => {
    await flip()
    await reseal()
    const identity = {id: 'b09', workspace_id: WS}
    const plaintext = {content: 'x', properties_json: '{}', references_json: '[]'}
    server.insert({...identity, ...await sealFor(wk, identity, plaintext)})
    server.write('b09', await sealFor(wk, identity, plaintext))
    const sentBefore = patchCalls()

    await expect(verify()).rejects.toEqual(new ConversionRefusal('no-record', ['b09']))
    expect(patchCalls()).toBe(sentBefore)
  })

  it('refuses a row sealed by a write that also changed other columns', async () => {
    await flip()
    server.write('b03', {
      ...await sealFor(wk, seeded[3], {...contentColumnsOf(seeded[3]), content: 'edited elsewhere'}),
      user_updated_at: 99,
    })
    await reseal()

    await expect(verify()).rejects.toEqual(new ConversionRefusal('no-record', ['b03']))
    expect((await openRow(wk, server.row('b03'))).content).toBe('edited elsewhere')
  })

  it('takes the record from the write into the current sealed state, not an earlier one', async () => {
    const otherKey = await keyOf(2)
    server.write('b01', await sealFor(otherKey, seeded[1], contentColumnsOf(seeded[1])))
    server.write('b01', {content: 'plaintext again', properties_json: '{}', references_json: '[]'})
    await flip()
    await reseal()

    expect(await verify()).toEqual({checked: 5, repaired: 0})
    expect((await openRow(wk, server.row('b01'))).content).toBe('plaintext again')
  })

  it('refuses while rows are still unsealed', async () => {
    await flip()

    await expect(verify()).rejects.toEqual(new ConversionRefusal('unsealed', ['b00', 'b01', 'b02', 'b03', 'b04']))
  })

  it('refuses when a re-sent row still differs from its record', async () => {
    await flip()
    await reseal()
    const sealed = server.row('b01')
    const swap = {content: sealed.properties_json, properties_json: sealed.content}
    server.write('b01', swap)
    server.afterPatch = () => {
      server.afterPatch = undefined
      server.write('b01', swap)
    }

    await expect(verify()).rejects.toEqual(new ConversionRefusal('unrepaired', ['b01']))
  })

  it('refuses a workspace the server still holds as plaintext', async () => {
    await expect(verify()).rejects.toEqual(new ConversionRefusal('not-e2ee'))
  })
})

describe('sealRecordOf', () => {
  const ENVELOPE = `enc:v1:${'A'.repeat(38)}`
  const resealWrite = {
    event_id: 1,
    block_id: 'b',
    before_diff: {content: 'c', properties_json: '{}', references_json: '[]', updated_at: 1},
    after_diff: {content: ENVELOPE, properties_json: ENVELOPE, references_json: ENVELOPE, updated_at: 2},
  }

  it('reads the plaintext of a re-seal write', () => {
    expect(sealRecordOf(resealWrite)).toEqual({content: 'c', properties_json: '{}', references_json: '[]'})
  })

  it('reads a value that only looked sealed as plaintext', () => {
    const write = {...resealWrite, before_diff: {...resealWrite.before_diff, content: ENVELOPE}}
    expect(sealRecordOf(write)).toEqual({content: ENVELOPE, properties_json: '{}', references_json: '[]'})
  })

  it.each([
    ['an insert', {before_diff: null}],
    ['a write that also changed another column', {after_diff: {...resealWrite.after_diff, user_updated_at: 2}}],
    ['a write from one envelope to another', {before_diff: {...resealWrite.after_diff, updated_at: 1}}],
    ['a write that left a column plaintext', {after_diff: {...resealWrite.after_diff, references_json: '[]'}}],
    ['a write that left a column out', {after_diff: {content: ENVELOPE, properties_json: ENVELOPE, updated_at: 2}}],
  ])('reads no record from %s', (_, overrides) => {
    expect(sealRecordOf({...resealWrite, ...overrides})).toBeNull()
  })
})
