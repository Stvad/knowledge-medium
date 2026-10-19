import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeForWire } from '../transform.js'
import type { ContentColumns, ResealPatch } from './conversionServer.js'
import { resealWorkspace, type PlaintextSource } from './reseal.js'
import { ConversionRefusal, contentColumnsOf, isSealedRow } from './sealing.js'
import { flipUnder, keyOf, openRow, seedPlaintext, sealFor, WS } from './test/conversionFixtures.js'
import { FakeConversionServer } from './test/fakeConversionServer.js'

vi.mock('../transform.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../transform.js')>()
  return {...actual, encodeForWire: vi.fn(actual.encodeForWire)}
})

let wk: CryptoKey
let server: FakeConversionServer

beforeEach(async () => {
  wk = await keyOf(1)
  server = new FakeConversionServer()
})

const flip = () => flipUnder(server, wk)

const plaintextIds = () => server.workspaceRows(WS).filter(row => !isSealedRow(row)).map(row => row.id)

describe('resealWorkspace', () => {
  it('resuming re-sends exactly the rows still plaintext on the server', async () => {
    const seeded = seedPlaintext(server, 7)
    await flip()
    let rpcs = 0
    server.afterPatch = () => {
      if (++rpcs === 2) throw new Error('response lost')
    }
    await expect(resealWorkspace({server, workspaceId: WS, wk, pageSize: 2})).rejects.toThrow('response lost')
    server.afterPatch = undefined
    const stillPlaintext = plaintextIds()
    expect(stillPlaintext).toEqual(['b04', 'b05', 'b06'])

    const sent: string[] = []
    server.beforePatch = patches => sent.push(...patches.map(patch => patch.id))
    expect(await resealWorkspace({server, workspaceId: WS, wk, pageSize: 2})).toEqual({scanned: 7, sealed: 3})

    expect(sent).toEqual(stillPlaintext)
    for (const row of seeded) expect(await openRow(wk, server.row(row.id))).toEqual(contentColumnsOf(row))
  })

  it('reads a page only once the previous one is sent, so memory is bounded by the page size', async () => {
    seedPlaintext(server, 7)
    await flip()
    const pagesSeen: number[] = []
    const source: PlaintextSource = async page => {
      pagesSeen.push(page.length)
      return new Map(page.map(row => [row.id, contentColumnsOf(row)]))
    }

    await resealWorkspace({server, workspaceId: WS, wk, pageSize: 3, source})

    expect(pagesSeen).toEqual([3, 3, 1])
    expect(server.calls).toEqual([
      {method: 'readWorkspace', count: 1},
      {method: 'readBlockPage', count: 3},
      {method: 'applyBlockPatches', count: 3},
      {method: 'readBlockPage', count: 3},
      {method: 'applyBlockPatches', count: 3},
      {method: 'readBlockPage', count: 1},
      {method: 'applyBlockPatches', count: 1},
      {method: 'readBlockPage', count: 0},
      {method: 'countBlocks', count: 1},
      {method: 'readWorkspace', count: 1},
    ])
  })

  it('reads on past a page the API cut short', async () => {
    seedPlaintext(server, 7)
    await flip()
    server.maxRows = 2

    await resealWorkspace({server, workspaceId: WS, wk, pageSize: 5})

    expect(plaintextIds()).toEqual([])
  })

  it('refuses a page sealed under another key before sending it', async () => {
    seedPlaintext(server, 3)
    await flip()
    const otherKey = await keyOf(2)
    const actual = await vi.importActual<typeof import('../transform.js')>('../transform.js')
    vi.mocked(encodeForWire).mockImplementationOnce(async (row, mode) => ({
      ...await actual.encodeForWire(row, mode, async () => wk),
      references_json: (await actual.encodeForWire(row, mode, async () => otherKey)).references_json,
    }))

    const run = resealWorkspace({server, workspaceId: WS, wk})

    await expect(run).rejects.toEqual(new ConversionRefusal('open-check', ['b00']))
    expect(server.calls.map(call => call.method)).not.toContain('applyBlockPatches')
    expect(plaintextIds()).toEqual(['b00', 'b01', 'b02'])
  })

  it('splits a page of large rows across calls by sealed size', async () => {
    const big = (i: number) => server.insert({id: `b0${i}`, workspace_id: WS, content: String(i).repeat(300_000)})
    const seeded = [0, 1, 2].map(big)
    await flip()

    await resealWorkspace({server, workspaceId: WS, wk})

    const calls = server.calls.filter(call => call.method === 'applyBlockPatches').map(call => call.count)
    expect(calls).toEqual([2, 1])
    for (const row of seeded) expect(await openRow(wk, server.row(row.id))).toEqual(contentColumnsOf(row))
  })

  it('sends at most 200 patches per call, whatever the page size', async () => {
    seedPlaintext(server, 250)
    await flip()

    await resealWorkspace({server, workspaceId: WS, wk, pageSize: 250})

    expect(server.calls.filter(call => call.method === 'applyBlockPatches').map(call => call.count)).toEqual([200, 50])
    expect(plaintextIds()).toEqual([])
  })

  it('resumes past a sealed value of several megabytes', async () => {
    server.insert({id: 'b00', workspace_id: WS, content: 'x'.repeat(2_700_000)})
    await flip()
    await resealWorkspace({server, workspaceId: WS, wk})
    expect(server.row('b00').content.length).toBeGreaterThan(3_600_000)

    expect(await resealWorkspace({server, workspaceId: WS, wk})).toEqual({scanned: 1, sealed: 0})
  })

  it('refuses a key that does not open the canary, before reading a row', async () => {
    seedPlaintext(server, 2)
    await flip()

    await expect(resealWorkspace({server, workspaceId: WS, wk: await keyOf(2)})).rejects.toEqual(new ConversionRefusal('wrong-key'))
    expect(server.calls.map(call => call.method)).toEqual(['readWorkspace'])
  })

  it('does not report success over the rows a lost session hid', async () => {
    seedPlaintext(server, 5)
    await flip()
    server.afterPatch = () => {
      server.afterPatch = undefined
      server.signedOut = true
    }
    const countBlocks = server.countBlocks.bind(server)
    server.countBlocks = async workspaceId => {
      server.signedOut = false
      return countBlocks(workspaceId)
    }

    await expect(resealWorkspace({server, workspaceId: WS, wk, pageSize: 2})).rejects.toThrow('the pass saw 2 of the workspace\'s 5 rows')
  })

  it('stops on a workspace this session cannot see', async () => {
    seedPlaintext(server, 2)
    await flip()
    server.signedOut = true

    await expect(resealWorkspace({server, workspaceId: WS, wk})).rejects.toThrow('not visible to this session')
  })

  it('refuses a workspace the server still holds as plaintext, before reading a row', async () => {
    seedPlaintext(server, 2)

    await expect(resealWorkspace({server, workspaceId: WS, wk})).rejects.toEqual(new ConversionRefusal('not-e2ee'))
    expect(server.calls.map(call => call.method)).toEqual(['readWorkspace'])
  })

  it('refuses a row from another workspace rather than sealing it', async () => {
    seedPlaintext(server, 1)
    await flip()
    server.insert({id: 'x00', workspace_id: 'ws-other', content: 'not ours'})
    const readBlockPage = server.readBlockPage.bind(server)
    server.readBlockPage = async (workspaceId, afterId, limit) =>
      afterId === null ? [...await readBlockPage(workspaceId, null, limit), server.row('x00')] : []

    await expect(resealWorkspace({server, workspaceId: WS, wk})).rejects.toThrow('no workspace key available for ws-other')
    expect(server.row('x00').content).toBe('not ours')
    expect(plaintextIds()).toEqual(['b00'])
  })

  it('seals what the source supplies, over rows already sealed under another key', async () => {
    const oldKey = await keyOf(3)
    await flip()
    const recoveryPoint = new Map<string, ContentColumns>()
    for (let i = 0; i < 3; i++) {
      const identity = {id: `b0${i}`, workspace_id: WS}
      server.insert({...identity, ...await sealFor(oldKey, identity, {content: `lost ${i}`, properties_json: '{}', references_json: '[]'})})
      if (i !== 1) recoveryPoint.set(identity.id, {content: `restored ${i}`, properties_json: `{"i":${i}}`, references_json: '[]'})
    }
    const untouched = server.row('b01')
    const sent: ResealPatch[] = []
    server.beforePatch = patches => sent.push(...patches)

    const result = await resealWorkspace({server, workspaceId: WS, wk, source: async () => recoveryPoint})

    expect(result).toEqual({scanned: 3, sealed: 2})
    expect(sent.map(patch => patch.id)).toEqual(['b00', 'b02'])
    for (const id of ['b00', 'b02']) expect(await openRow(wk, server.row(id))).toEqual(recoveryPoint.get(id))
    expect(server.row('b01')).toEqual(untouched)
  })
})
