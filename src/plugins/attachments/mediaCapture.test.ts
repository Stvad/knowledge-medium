// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { kernelPageBlockId } from '@/data/kernelPage'
import { hasBlockType } from '@/data/properties'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { isBlockRefId, parseBlockRefs } from '@/plugins/references/referenceParser'
import { computeContentHash } from '@/sync/crypto/contentHash.js'
import { deriveContentKey } from '@/sync/crypto/contentKey.js'
import { deriveContentKeyHmac } from '@/sync/crypto/contentKey.js'
import type { GetMaterializability, Materializability } from '@/sync/transform.js'
import { InMemoryByteStore } from './byteStore.js'
import {
  ASSETS_NS,
  ASSETS_TYPE,
  MEDIA_PROPERTY_SCHEMAS,
  MEDIA_TYPE,
  MEDIA_TYPE_CONTRIBUTION,
  ASSETS_TYPE_CONTRIBUTION,
  mediaFilenameProp,
  mediaHashProp,
  mediaMimeProp,
  mediaSizeProp,
} from './mediaBlock.js'
import { captureMedia, mediaBlockId } from './mediaCapture.js'
import { InMemoryByteUploadStore } from './uploadStore.js'

const WS = 'ws-1'
const USER = 'user-1'
const bytesOf = (n: number, seed = 0) =>
  new Uint8Array(Array.from({ length: n }, (_, i) => (i + seed) & 0xff)) as Uint8Array<ArrayBuffer>

const mat = (m: Materializability): GetMaterializability => async () => m

interface Harness {
  h: TestDb
  repo: Repo
  byteStore: InMemoryByteStore
  uploadStore: InMemoryByteUploadStore
  drained: string[]
  parentId: string
}

let sharedDb: TestDb
let env: Harness

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const repo = new Repo({ db: sharedDb.db, cache: new BlockCache(), user: { id: USER } })
  repo.setFacetRuntime(
    resolveFacetRuntimeSync([
      kernelDataExtension,
      typeSeedsFacet.of(MEDIA_TYPE_CONTRIBUTION, { source: 'test' }),
      typeSeedsFacet.of(ASSETS_TYPE_CONTRIBUTION, { source: 'test' }),
      ...MEDIA_PROPERTY_SCHEMAS.map((s) => definitionSeedsFacet.of(s, { source: 'test' })),
    ]),
  )
  repo.setActiveWorkspaceId(WS)
  // A normal block to embed the !((id)) under.
  let parentId = ''
  await repo.tx(
    async (tx) => {
      parentId = await tx.create({ workspaceId: WS, parentId: null, orderKey: 'm0', content: 'note' })
    },
    { scope: ChangeScope.BlockDefault },
  )
  const drained: string[] = []
  return {
    h: sharedDb,
    repo,
    byteStore: new InMemoryByteStore(),
    uploadStore: new InMemoryByteUploadStore(() => 1000),
    drained,
    parentId,
  }
}

const deps = (over: Partial<Parameters<typeof captureMedia>[1]> = {}) => ({
  repo: env.repo,
  byteStore: env.byteStore,
  uploadStore: env.uploadStore,
  getUserId: () => USER as string | null,
  getMaterializability: mat('copy'),
  getContentKeyHmac: async () => null,
  drain: (u: string) => env.drained.push(u),
  ...over,
})

const expectedIds = async (
  bytes: Uint8Array<ArrayBuffer>,
  mode: 'none' | 'e2ee',
  hmac: CryptoKey | null,
  ws: string = WS,
) => {
  const contentHash = await computeContentHash(bytes)
  const contentKey = await deriveContentKey({ contentHash, mode, contentKeyHmac: hmac })
  return { contentHash, contentKey, assetBlockId: mediaBlockId(ws, contentKey) }
}

beforeAll(async () => {
  sharedDb = await createTestDb()
})
afterAll(async () => {
  await sharedDb.cleanup()
})
beforeEach(async () => {
  env = await setup()
})
afterEach(() => {
  env.repo.stopSyncObserver()
})

describe('captureMedia (Phase 5c — capture, plaintext)', () => {
  it('mints the asset block, stores bytes, promotes the record, arms the drain', async () => {
    const bytes = bytesOf(64)
    const { contentHash, contentKey, assetBlockId } = await expectedIds(bytes, 'none', null)

    const result = await captureMedia(
      { workspaceId: WS, source: { bytes, mime: 'image/png', filename: 'cat.png' } },
      deps(),
    )

    expect(result).toEqual({ ok: true, assetBlockId, deduped: false })

    // bytes are in the OPFS replica under the content-key
    expect([...((await env.byteStore.get(USER, WS, contentKey)) ?? [])]).toEqual([...bytes])
    // record was staged THEN promoted (it's drainable now)
    expect((await env.uploadStore.get(USER, assetBlockId))?.status).toBe('pending')
    // the drain was armed
    expect(env.drained).toEqual([USER])

    // the asset block lives under the workspace ASSETS container, typed + propped
    const asset = await env.repo.load(assetBlockId)
    expect(asset).not.toBeNull()
    expect(asset!.parentId).toBe(kernelPageBlockId(WS, ASSETS_NS))
    expect(hasBlockType(asset!, MEDIA_TYPE)).toBe(true)
    expect(mediaHashProp.codec.decode(asset!.properties[mediaHashProp.name])).toBe(contentHash)
    expect(mediaMimeProp.codec.decode(asset!.properties[mediaMimeProp.name])).toBe('image/png')
    expect(mediaSizeProp.codec.decode(asset!.properties[mediaSizeProp.name])).toBe(64)
    expect(mediaFilenameProp.codec.decode(asset!.properties[mediaFilenameProp.name])).toBe('cat.png')

    // the ASSETS container exists + is tagged
    const container = await env.repo.load(kernelPageBlockId(WS, ASSETS_NS))
    expect(hasBlockType(container!, ASSETS_TYPE)).toBe(true)
  })

  it('mints a UUID-shaped asset id, so the renderer’s ((id)) reference parses — not literal text', async () => {
    // The block-ref grammar only matches UUID-shaped targets, so the asset id MUST
    // be a UUID or the `((id))` reference renders as literal text, not the media block.
    const bytes = bytesOf(20)
    const { assetBlockId } = await expectedIds(bytes, 'none', null)
    expect(isBlockRefId(assetBlockId)).toBe(true)

    const result = await captureMedia({ workspaceId: WS, source: { bytes, mime: 'image/png' } }, deps())
    expect(result.ok && result.assetBlockId).toBe(assetBlockId)

    // The reference the renderer builds for this asset is block-ref-parseable.
    const refs = parseBlockRefs(`((${assetBlockId}))`)
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ blockId: assetBlockId, embed: false })
  })

  it('STAGE happens before the block tx and PROMOTE only after commit (crash recovery)', async () => {
    const bytes = bytesOf(32)
    const { contentKey, assetBlockId } = await expectedIds(bytes, 'none', null)

    // Fail the asset-block tx (its addType step) to model a crash mid-mint, AFTER the
    // durable pre-tx writes. (Pre-Phase-5c-ii this was triggered via a bad embed parent;
    // the embed is now the renderer's job, so fail the asset tx directly.) The bytes +
    // staged record must survive, and the record must NOT be promoted, nor the drain armed.
    vi.spyOn(env.repo, 'addTypeInTx').mockRejectedValueOnce(new Error('simulated mid-mint crash'))

    await expect(
      captureMedia({ workspaceId: WS, source: { bytes, mime: 'image/png' } }, deps()),
    ).rejects.toThrow()

    expect([...((await env.byteStore.get(USER, WS, contentKey)) ?? [])]).toEqual([...bytes])
    expect((await env.uploadStore.get(USER, assetBlockId))?.status).toBe('staged')
    expect(env.drained).toEqual([])
    // the asset block tx rolled back — nothing persisted
    expect(await env.repo.load(assetBlockId)).toBeNull()
  })

  it('dedups identical content to one asset block', async () => {
    const bytes = bytesOf(48, 7)
    const first = await captureMedia(
      { workspaceId: WS, source: { bytes, mime: 'image/png' } },
      deps(),
    )
    const second = await captureMedia(
      { workspaceId: WS, source: { bytes, mime: 'image/png' } },
      deps(),
    )

    expect(first.ok && second.ok).toBe(true)
    expect(first.ok && second.ok && first.assetBlockId).toBe(second.ok ? second.assetBlockId : '')
    expect(second.ok && second.deduped).toBe(true)
  })

  it('captures the same plaintext content in TWO workspaces as distinct blocks (no cross-workspace collision)', async () => {
    const bytes = bytesOf(24, 3)
    const WS2 = 'ws-2'

    const a = await captureMedia({ workspaceId: WS, source: { bytes, mime: 'image/png' } }, deps())
    const b = await captureMedia({ workspaceId: WS2, source: { bytes, mime: 'image/png' } }, deps())

    expect(a.ok && b.ok).toBe(true)
    // distinct ids (workspace-scoped) — neither the block create nor the upload
    // queue collides, even though the raw-sha256 content-key is identical.
    expect(a.ok ? a.assetBlockId : '').not.toBe(b.ok ? b.assetBlockId : '')
    expect((await env.uploadStore.get(USER, a.ok ? a.assetBlockId : ''))?.status).toBe('pending')
    expect((await env.uploadStore.get(USER, b.ok ? b.assetBlockId : ''))?.status).toBe('pending')
    expect((await env.repo.load(a.ok ? a.assetBlockId : ''))?.workspaceId).toBe(WS)
    expect((await env.repo.load(b.ok ? b.assetBlockId : ''))?.workspaceId).toBe(WS2)
  })
})

describe('captureMedia — e2ee + guards', () => {
  it('derives a KEYED content-key for an e2ee workspace (≠ the plaintext id)', async () => {
    const bytes = bytesOf(40)
    const kId = await deriveContentKeyHmac(new Uint8Array(32) as Uint8Array<ArrayBuffer>)
    const e2ee = await expectedIds(bytes, 'e2ee', kId)
    const plain = await expectedIds(bytes, 'none', null)
    expect(e2ee.assetBlockId).not.toBe(plain.assetBlockId)

    const result = await captureMedia(
      { workspaceId: WS, source: { bytes, mime: 'image/png' } },
      deps({ getMaterializability: mat('decrypt'), getContentKeyHmac: async () => kId }),
    )

    expect(result).toMatchObject({ ok: true, assetBlockId: e2ee.assetBlockId })
    expect(await env.byteStore.get(USER, WS, e2ee.contentKey)).not.toBeNull()
  })

  it.each([
    ['empty', bytesOf(0), { maxBytes: 1024 }, 'image/png'],
    ['too-large', bytesOf(2048), { maxBytes: 1024 }, 'image/png'],
  ] as const)('rejects %s without any durable write', async (reason, bytes, over, mime) => {
    const result = await captureMedia(
      { workspaceId: WS, source: { bytes, mime } },
      deps(over),
    )
    expect(result).toEqual({ ok: false, reason })
    expect(await env.uploadStore.listByStatus(USER, 'staged')).toHaveLength(0)
    expect(await env.uploadStore.listByStatus(USER, 'pending')).toHaveLength(0)
    expect(env.drained).toEqual([])
  })

  it('rejects an e2ee file whose ENCODED size exceeds the cap, but allows it as plaintext', async () => {
    const kId = await deriveContentKeyHmac(new Uint8Array(32) as Uint8Array<ArrayBuffer>)
    // Exactly at the cap as plaintext: passthrough fits, but the e2ee envelope
    // (magic+nonce+GCM tag) pushes the uploaded object over the bucket file_size_limit.
    const atCap = bytesOf(1024)

    const e2ee = await captureMedia(
      { workspaceId: WS, source: { bytes: atCap, mime: 'image/png' } },
      deps({ maxBytes: 1024, getMaterializability: mat('decrypt'), getContentKeyHmac: async () => kId }),
    )
    expect(e2ee).toEqual({ ok: false, reason: 'too-large' }) // would 413 at upload otherwise
    expect(await env.uploadStore.listByStatus(USER, 'staged')).toHaveLength(0)

    const plain = await captureMedia(
      { workspaceId: WS, source: { bytes: atCap, mime: 'image/png' } },
      deps({ maxBytes: 1024 }), // copy mode (default) — passthrough, no envelope overhead
    )
    expect(plain).toMatchObject({ ok: true })
  })

  it('rejects an unsupported MIME when an allow-list is supplied', async () => {
    const result = await captureMedia(
      { workspaceId: WS, source: { bytes: bytesOf(8), mime: 'application/x-evil' } },
      deps({ isAllowedMime: (m) => m.startsWith('image/') }),
    )
    expect(result).toEqual({ ok: false, reason: 'unsupported-mime' })
  })

  it('rejects capture into a locked (defer) workspace', async () => {
    const result = await captureMedia(
      { workspaceId: WS, source: { bytes: bytesOf(8), mime: 'image/png' } },
      deps({ getMaterializability: mat('defer') }),
    )
    expect(result).toEqual({ ok: false, reason: 'workspace-locked' })
  })

  it('rejects an e2ee capture with no K_id on this device (the §10 re-paste migration)', async () => {
    const result = await captureMedia(
      { workspaceId: WS, source: { bytes: bytesOf(8), mime: 'image/png' } },
      deps({ getMaterializability: mat('decrypt'), getContentKeyHmac: async () => null }),
    )
    expect(result).toEqual({ ok: false, reason: 'no-content-key' })
  })

  it('rejects when signed out', async () => {
    const result = await captureMedia(
      { workspaceId: WS, source: { bytes: bytesOf(8), mime: 'image/png' } },
      deps({ getUserId: () => null }),
    )
    expect(result).toEqual({ ok: false, reason: 'no-user' })
  })
})
