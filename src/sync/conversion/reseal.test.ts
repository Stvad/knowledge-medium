import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeForWire } from '../transform.js'
import type { ConversionServer, ResealPatch } from './conversionServer.js'
import { resealWorkspace, type PlaintextSource } from './reseal.js'
import { ConversionRefusal, contentColumnsOf, isSealedRow } from './sealing.js'
import { keyOf, openRow, seedPlaintext, sealFor, WS } from './test/conversionFixtures.js'
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

const flip = () => server.setMode(WS, 'e2ee')

const plaintextIds = () => server.workspaceRows(WS).filter(row => !isSealedRow(row)).map(row => row.id)

describe('resealWorkspace', () => {
  it('resuming re-sends exactly the rows still plaintext on the server', async () => {
    const seeded = seedPlaintext(server, 7)
    flip()
    let rpcs = 0
    server.beforePatch = () => {
      if (++rpcs === 3) throw new Error('crash')
    }
    await expect(resealWorkspace({server, workspaceId: WS, wk, pageSize: 2})).rejects.toThrow('crash')
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
    flip()
    const pagesSeen: number[] = []
    const source: PlaintextSource = async page => {
      pagesSeen.push(page.length)
      return new Map(page.map(row => [row.id, contentColumnsOf(row)]))
    }

    await resealWorkspace({server, workspaceId: WS, wk, pageSize: 3, source})

    expect(pagesSeen).toEqual([3, 3, 1])
    expect(server.calls).toEqual([
      {method: 'readEncryptionMode', count: 1},
      {method: 'readBlockPage', count: 3},
      {method: 'applyBlockPatches', count: 3},
      {method: 'readBlockPage', count: 3},
      {method: 'applyBlockPatches', count: 3},
      {method: 'readBlockPage', count: 1},
      {method: 'applyBlockPatches', count: 1},
      {method: 'readBlockPage', count: 0},
    ])
  })

  it('reads on past a page the API cut short', async () => {
    seedPlaintext(server, 7)
    flip()
    server.maxRows = 2

    await resealWorkspace({server, workspaceId: WS, wk, pageSize: 5})

    expect(plaintextIds()).toEqual([])
  })

  it('refuses a page sealed under another key before sending it', async () => {
    seedPlaintext(server, 3)
    flip()
    const otherKey = await keyOf(2)
    const actual = await vi.importActual<typeof import('../transform.js')>('../transform.js')
    vi.mocked(encodeForWire).mockImplementationOnce((row, mode) => actual.encodeForWire(row, mode, async () => otherKey))

    const run = resealWorkspace({server, workspaceId: WS, wk})

    await expect(run).rejects.toEqual(new ConversionRefusal('open-check', ['b00']))
    expect(server.calls.map(call => call.method)).not.toContain('applyBlockPatches')
    expect(plaintextIds()).toEqual(['b00', 'b01', 'b02'])
  })

  it('refuses a workspace the server still holds as plaintext, before reading a row', async () => {
    seedPlaintext(server, 2)

    await expect(resealWorkspace({server, workspaceId: WS, wk})).rejects.toEqual(new ConversionRefusal('not-e2ee'))
    expect(server.calls.map(call => call.method)).toEqual(['readEncryptionMode'])
  })

  it('refuses a row from another workspace rather than sealing it', async () => {
    seedPlaintext(server, 1)
    flip()
    server.insert({id: 'x00', workspace_id: 'ws-other', content: 'not ours'})
    const leaky: ConversionServer = {
      readEncryptionMode: workspaceId => server.readEncryptionMode(workspaceId),
      readBlockPage: async (workspaceId, afterId, limit) =>
        afterId === null ? [...await server.readBlockPage(workspaceId, null, limit), server.row('x00')] : [],
      readBlocks: (workspaceId, ids) => server.readBlocks(workspaceId, ids),
      readContentSealHistory: (workspaceId, ids) => server.readContentSealHistory(workspaceId, ids),
      applyBlockPatches: patches => server.applyBlockPatches(patches),
    }

    await expect(resealWorkspace({server: leaky, workspaceId: WS, wk})).rejects.toThrow('no workspace key available for ws-other')
    expect(server.row('x00').content).toBe('not ours')
    expect(plaintextIds()).toEqual(['b00'])
  })

  it('seals what the source supplies, over rows already sealed under another key', async () => {
    const oldKey = await keyOf(3)
    flip()
    const recoveryPoint = new Map<string, ReturnType<typeof contentColumnsOf>>()
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
