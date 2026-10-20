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

  /** Stands in for the server's page reads: `before(page)` runs ahead of each,
   *  and may answer for it. */
  const onPageRead = (before: (page: number) => Promise<'read' | 'empty'>) => {
    const read = server.readBlockPage.bind(server)
    let pages = 0
    vi.spyOn(server, 'readBlockPage').mockImplementation(async (...args) =>
      (await before(++pages)) === 'empty' ? [] : read(...args))
  }

  const insertSealed = async (id: string) => {
    const row = {id, workspace_id: WS}
    server.insert({...row, ...(await sealFor(wk, row, {content: 'new', properties_json: '{}', references_json: '[]'}))})
  }

  it('takes rows written while it reads, on either side of its cursor, as past the purge they may be', async () => {
    server.maxRows = 2
    onPageRead(async page => {
      // The first page ended at b01.
      if (page === 2) for (const id of ['a-new', 'b01-new']) await insertSealed(id)
      return 'read'
    })

    expect(await serverMediaBlocks(server, WS, wk, fakeMediaHashOf)).toEqual([{blockId: 'media-1', contentHash: 'sha256:aa'}])
  })

  it('fails a read that a page cut short, though rows written meanwhile make up the count', async () => {
    server.maxRows = 2
    onPageRead(async page => {
      if (page === 2) for (const id of ['b01-a', 'b01-b']) await insertSealed(id)
      // A token that lapsed for one request: RLS reads it as an empty page.
      return page === 3 ? 'empty' : 'read'
    })

    await expect(serverMediaBlocks(server, WS, wk, fakeMediaHashOf)).rejects.toThrow('stopped before')
  })

  it('reads a workspace with no rows as one with no media, not as a pass that stopped early', async () => {
    expect(await serverMediaBlocks(server, 'ws-empty', wk, fakeMediaHashOf)).toEqual([])
  })

  it('fails a read that did not see every row', async () => {
    // A lapsed session reads as an empty table rather than as an error.
    vi.spyOn(server, 'readBlockPage').mockResolvedValue([])

    await expect(serverMediaBlocks(server, WS, wk, fakeMediaHashOf)).rejects.toThrow('stopped before')
  })
})
