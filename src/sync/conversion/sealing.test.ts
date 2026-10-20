import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resealWorkspace } from './reseal.js'
import { serverMediaBlocks } from './sealing.js'
import { flipUnder, keyOf, mediaPropertiesJson, sealFor, seedPlaintext, WS } from './test/conversionFixtures.js'
import { fakeMediaHashOf } from './test/fakeAttachmentStorage.js'
import { FakeConversionServer } from './test/fakeConversionServer.js'

let wk: CryptoKey
let server: FakeConversionServer

beforeEach(async () => {
  wk = await keyOf(1)
  server = new FakeConversionServer()
  seedPlaintext(server, 3)
  server.insert({id: 'media-1', workspace_id: WS, properties_json: mediaPropertiesJson('sha256:aa')})
  await flipUnder(server, wk)
  await resealWorkspace({server, workspaceId: WS, wk})
})

describe('serverMediaBlocks', () => {
  it("reads the media blocks from the server's rows, each opened under the key", async () => {
    expect(await serverMediaBlocks(server, WS, wk, fakeMediaHashOf)).toEqual([{blockId: 'media-1', contentHash: 'sha256:aa'}])
  })

  it('fails on a row that does not open under the key, rather than leave it out', async () => {
    const row = {id: 'other-key', workspace_id: WS}
    const columns = {content: 'x', properties_json: mediaPropertiesJson('sha256:bb'), references_json: '[]'}
    server.insert({...row, ...(await sealFor(await keyOf(2), row, columns))})

    await expect(serverMediaBlocks(server, WS, wk, fakeMediaHashOf)).rejects.toThrow('other-key does not open')
  })

  it('fails a read that did not see every row', async () => {
    // A lapsed session reads as an empty table rather than as an error.
    vi.spyOn(server, 'readBlockPage').mockResolvedValue([])

    await expect(serverMediaBlocks(server, WS, wk, fakeMediaHashOf)).rejects.toThrow('saw 0 of')
  })
})
