import { mintCanary } from '../../crypto/canary.js'
import { computeContentHash } from '../../crypto/contentHash.js'
import { importWorkspaceKey } from '../../crypto/workspaceKey.js'
import { decodeFromWire, encodeForWire, type WireBlockColumns } from '../../transform.js'
import type { ContentColumns, ServerBlockRow } from '../conversionServer.js'
import { contentColumnsOf } from '../sealing.js'
import { rawNameOf } from '../bundle/attachmentParts.js'
import type { FakeAttachmentStorage } from './fakeAttachmentStorage.js'
import type { FakeBlockRow, FakeConversionServer } from './fakeConversionServer.js'

export const WS = 'ws-1'

export const keyOf = (fill: number): Promise<CryptoKey> => importWorkspaceKey(new Uint8Array(32).fill(fill))

/** The flip, with a canary minted under `wk`. */
export const flipUnder = async (server: FakeConversionServer, wk: CryptoKey): Promise<void> =>
  server.flip(WS, await mintCanary(wk, WS))

export const openRow = async (wk: CryptoKey, row: WireBlockColumns): Promise<ContentColumns> =>
  contentColumnsOf(await decodeFromWire(row, 'e2ee', async () => wk))

export const sealFor = async (
  wk: CryptoKey,
  row: Pick<ServerBlockRow, 'id' | 'workspace_id'>,
  columns: ContentColumns,
): Promise<ContentColumns> =>
  contentColumnsOf(await encodeForWire({id: row.id, workspace_id: row.workspace_id, ...columns}, 'e2ee', async () => wk))

/** Plaintext rows `b00`, `b01`, … in workspace {@link WS}, inserted while the
 *  workspace is still plaintext. */
export const seedPlaintext = (server: FakeConversionServer, count: number): FakeBlockRow[] =>
  Array.from({length: count}, (_, i) => server.insert({
    id: `b${String(i).padStart(2, '0')}`,
    workspace_id: WS,
    content: `text ${i}`,
    properties_json: `{"n":${i}}`,
    references_json: `["r${i}"]`,
  }))

export const mediaPropertiesJson = (contentHash: string): string =>
  JSON.stringify({types: ['media'], 'media:hash': contentHash})

/** A plaintext media block of {@link WS} whose bytes are `bytes`, on the server
 *  and on this device, with those bytes wherever `at` says. Returns its hash. */
export const seedMedia = async (
  server: FakeConversionServer,
  storage: FakeAttachmentStorage,
  {id, bytes, at}: {id: string; bytes: Uint8Array<ArrayBuffer>; at: {local?: boolean; remote?: boolean}},
): Promise<string> => {
  const contentHash = await computeContentHash(bytes)
  server.insert({id, workspace_id: WS, properties_json: mediaPropertiesJson(contentHash)})
  storage.media.push({blockId: id, contentHash})
  if (at.local) storage.local.set(rawNameOf(contentHash), bytes.slice())
  if (at.remote) storage.objects.set(rawNameOf(contentHash), bytes.slice())
  return contentHash
}
