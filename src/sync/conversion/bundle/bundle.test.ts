import { beforeEach, describe, expect, it } from 'vitest'
import { resealWorkspace } from '../reseal.js'
import { contentColumnsOf } from '../sealing.js'
import { flipUnder, keyOf, sealFor, seedPlaintext, WS } from '../test/conversionFixtures.js'
import { FakeConversionServer, type FakeBlockRow } from '../test/fakeConversionServer.js'
import { MemoryBundleFolder } from '../test/memoryBundleFolder.js'
import { sha256Hex, type BundleFolder } from './bundleParts.js'
import { BUNDLE_PARTS, type BundleManifest } from './manifest.js'
import { BundleRefusal, takeBundle, type TakeBundleOptions } from './takeBundle.js'
import { BundleInvalid, verifyBundle } from './verifyBundle.js'

let server: FakeConversionServer
let folder: MemoryBundleFolder
let seeded: FakeBlockRow[]
let wk: CryptoKey

const LOCAL_DB = new TextEncoder().encode('SQLite format 3\0 local history')

beforeEach(async () => {
  server = new FakeConversionServer()
  seeded = seedPlaintext(server, 5)
  folder = new MemoryBundleFolder()
  wk = await keyOf(1)
})

const writeLocalDb = async (into: BundleFolder) => {
  const writable = await (await into.getFileHandle(BUNDLE_PARTS.localDb, {create: true})).createWritable()
  await writable.write(LOCAL_DB.slice())
  await writable.close()
}

const take = (options: Partial<TakeBundleOptions> = {}) =>
  takeBundle({server, workspaceId: WS, folder, writeLocalDb, pageSize: 2, now: () => new Date(0), ...options})
const verify = (manifestSha256?: string) => verifyBundle({folder, workspaceId: WS, manifestSha256})

const lines = (name: string) => folder.text(name).split('\n').filter(Boolean).map(line => JSON.parse(line))
const manifestOf = (): BundleManifest => JSON.parse(folder.text(BUNDLE_PARTS.manifest))

/** Rewrites a `.jsonl` part and the manifest to match it, as a self-consistent
 *  but wrong bundle would be. */
const rewrite = (name: typeof BUNDLE_PARTS.blocks | typeof BUNDLE_PARTS.history, change: (rows: Record<string, unknown>[]) => Record<string, unknown>[], manifestChange: (m: BundleManifest) => object = m => m) => {
  const rows = change(lines(name))
  const text = rows.map(row => `${JSON.stringify(row)}\n`).join('')
  folder.setText(name, text)
  const bytes = new TextEncoder().encode(text)
  const manifest = manifestOf()
  folder.setText(BUNDLE_PARTS.manifest, JSON.stringify(manifestChange({
    ...manifest,
    parts: {...manifest.parts, [name]: {sha256: sha256Hex(bytes), bytes: bytes.length, lines: rows.length}},
  })))
}

const problemOf = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => null, (thrown: unknown) => thrown)
  if (!(error instanceof BundleInvalid)) throw new Error(`expected BundleInvalid, got ${String(error)}`)
  return error.problem
}

describe('takeBundle', () => {
  it('archives every block row and every history row verbatim, with matching counts', async () => {
    await flipUnder(server, wk)
    const {manifest} = await take()

    expect(lines(BUNDLE_PARTS.blocks)).toEqual(server.workspaceRows(WS))
    expect(lines(BUNDLE_PARTS.history)).toEqual(server.history(WS))
    expect(manifest).toMatchObject({
      workspaceId: WS,
      through: Math.max(...server.history(WS).map(row => row.event_id)),
      serverBlockCount: 5,
      parts: {[BUNDLE_PARTS.blocks]: {lines: 5}, [BUNDLE_PARTS.history]: {lines: 5}, [BUNDLE_PARTS.localDb]: {bytes: LOCAL_DB.length}},
    })
    expect(manifestOf()).toEqual(manifest)
    expect((await verify()).manifest).toEqual(manifest)
  })

  it('holds plaintext for rows the re-seal already sealed', async () => {
    await flipUnder(server, wk)
    let pages = 0
    server.beforePatch = () => {
      if (++pages > 1) throw new Error('crash mid re-seal')
    }
    await expect(resealWorkspace({server, workspaceId: WS, wk, pageSize: 2})).rejects.toThrow('crash')
    expect(server.workspaceRows(WS).filter(row => row.content.startsWith('enc:v1:'))).toHaveLength(2)

    await take()

    expect(lines(BUNDLE_PARTS.blocks).map(contentColumnsOf)).toEqual(seeded.map(contentColumnsOf))
    await verify()
  })

  it('takes the latest re-seal write as the record, not an older sealed-looking one', async () => {
    const [row] = seeded
    // Before the flip, an import wrote envelope-shaped plaintext, then plaintext again.
    const looksSealed = await sealFor(await keyOf(9), row, contentColumnsOf(row))
    server.write(row.id, {content: 'an older text'})
    server.write(row.id, looksSealed)
    server.write(row.id, contentColumnsOf(row))
    await flipUnder(server, wk)
    await resealWorkspace({server, workspaceId: WS, wk})

    await take()

    expect(contentColumnsOf(lines(BUNDLE_PARTS.blocks)[0])).toEqual(contentColumnsOf(row))
  })

  it('refuses a sealed row that has no re-seal record', async () => {
    await flipUnder(server, wk)
    const sealed = await sealFor(wk, {id: 'outsider', workspace_id: WS}, {content: 'x', properties_json: '{}', references_json: '[]'})
    server.insert({id: 'outsider', workspace_id: WS, ...sealed})

    await expect(take()).rejects.toEqual(new BundleRefusal('no-record', ['outsider']))
  })

  it('reads again when a write lands during the paging', async () => {
    const read = server.readFullBlockPage.bind(server)
    let reads = 0
    server.readFullBlockPage = async (...args) => {
      if (reads++ === 0) server.write('b03', {content: 'written mid-read'})
      return read(...args)
    }

    await take()

    expect(lines(BUNDLE_PARTS.blocks).find(row => row.id === 'b03')?.content).toBe('written mid-read')
    expect(lines(BUNDLE_PARTS.history)).toEqual(server.history(WS))
    await verify()
  })

  it('gives up on a workspace that is written during every read', async () => {
    const read = server.readFullBlockPage.bind(server)
    let writes = 0
    server.readFullBlockPage = async (...args) => {
      server.write('b03', {content: `write ${++writes}`})
      return read(...args)
    }

    await expect(take()).rejects.toEqual(new BundleRefusal('unstable'))
  })

  it('refuses a read that saw fewer rows than the workspace holds', async () => {
    const read = server.readFullBlockPage.bind(server)
    let pages = 0
    // A page that comes back empty early, as a filter or paging bug would.
    server.readFullBlockPage = async (...args) => (++pages > 1 ? [] : read(...args))

    await expect(take()).rejects.toThrow(/read 2 of the workspace's 5 rows/)
  })

  it('treats a session that sees no rows as an error, not an empty workspace', async () => {
    server.signedOut = true
    await expect(take()).rejects.toThrow(/not visible to this session/)
  })
})

describe('verifyBundle', () => {
  beforeEach(async () => {
    await flipUnder(server, wk)
    await take()
  })

  it('refuses a part edited after the bundle was taken', async () => {
    const edited = folder.text(BUNDLE_PARTS.blocks).replace('text 2', 'text X')
    folder.setText(BUNDLE_PARTS.blocks, edited)
    expect(await problemOf(verify())).toBe('part-mismatch')
  })

  it('refuses a local database changed after the bundle was taken', async () => {
    folder.setText(BUNDLE_PARTS.localDb, 'SQLite format 3\0 something else')
    expect(await problemOf(verify())).toBe('part-mismatch')
  })

  it('refuses a bundle whose writing never finished', async () => {
    folder.files.delete(BUNDLE_PARTS.manifest)
    expect(await problemOf(verify())).toBe('missing-part')
  })

  it('refuses a truncated blocks file even when its manifest entry matches it', async () => {
    rewrite(BUNDLE_PARTS.blocks, rows => rows.slice(0, -1))
    expect(await problemOf(verify())).toBe('row-count')
  })

  it('refuses a repeated id that keeps the count', async () => {
    rewrite(BUNDLE_PARTS.blocks, rows => [...rows.slice(0, -1), rows[0]])
    expect(await problemOf(verify())).toBe('duplicate-row')
  })

  it('refuses rows or a manifest of another workspace', async () => {
    rewrite(BUNDLE_PARTS.blocks, rows => rows.map((row, i) => (i === 2 ? {...row, workspace_id: 'ws-other'} : row)))
    expect(await problemOf(verify())).toBe('row-other-workspace')
    expect(await problemOf(verifyBundle({folder, workspaceId: 'ws-other'}))).toBe('other-workspace')
  })

  it('refuses history of another workspace, out of order, or not ending at through', async () => {
    rewrite(BUNDLE_PARTS.history, rows => rows.map((row, i) => (i === 1 ? {...row, workspace_id: 'ws-other'} : row)))
    expect(await problemOf(verify())).toBe('row-other-workspace')

    await take()
    rewrite(BUNDLE_PARTS.history, rows => [rows[1], rows[0], ...rows.slice(2)])
    expect(await problemOf(verify())).toBe('history-order')

    await take()
    rewrite(BUNDLE_PARTS.history, rows => rows.slice(0, -1))
    expect(await problemOf(verify())).toBe('history-through')
  })

  it('refuses a sealed row, which the bundle must never hold', async () => {
    const sealed = await sealFor(wk, seeded[0], contentColumnsOf(seeded[0]))
    rewrite(BUNDLE_PARTS.blocks, rows => rows.map((row, i) => (i === 0 ? {...row, ...sealed} : row)))
    expect(await problemOf(verify())).toBe('sealed-row')
  })

  it('refuses another folder with matching counts in place of the recorded one', async () => {
    const recorded = (await verify()).manifestSha256
    await take({now: () => new Date(1)})
    expect(await problemOf(verify(recorded))).toBe('manifest-changed')
  })

  it('passes a workspace with no history at all', async () => {
    server.dropHistory(WS)

    const {manifest} = await take()

    expect(manifest.through).toBe(0)
    expect(folder.text(BUNDLE_PARTS.history)).toBe('')
    await verify()
  })
})
