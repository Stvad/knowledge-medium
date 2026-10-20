import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resealWorkspace } from '../reseal.js'
import { contentColumnsOf } from '../sealing.js'
import { flipUnder, keyOf, sealFor, seedPlaintext, WS } from '../test/conversionFixtures.js'
import { FakeConversionServer, type FakeBlockRow } from '../test/fakeConversionServer.js'
import { MemoryBundleFolder } from '../test/memoryBundleFolder.js'
import { scanPart, sha256Hex, writeBytesPart, type BundleWritable } from './bundleParts.js'
import { FAKE_LOCAL_DB, writeFakeLocalDb } from '../test/flowFixtures.js'
import { BUNDLE_PARTS, type BundleManifest } from './manifest.js'
import { BundleRefusal, takeBundle, type TakeBundleOptions } from './takeBundle.js'
import { BundleInvalid, verifyBundle } from './verifyBundle.js'

let server: FakeConversionServer
let folder: MemoryBundleFolder
let seeded: FakeBlockRow[]
let wk: CryptoKey


beforeEach(async () => {
  server = new FakeConversionServer()
  seeded = seedPlaintext(server, 5)
  folder = new MemoryBundleFolder()
  wk = await keyOf(1)
})

const take = (options: Partial<TakeBundleOptions> = {}) =>
  takeBundle({server, workspaceId: WS, folder, writeLocalDb: writeFakeLocalDb, pageSize: 2, now: () => new Date(0), ...options})
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

describe('stoppableFolder', () => {
  const stopped = () => new DOMException('stopped', 'AbortError')

  it('ends a part write on Stop while the drive is slow to open the file', async () => {
    const stop = new AbortController()
    folder.getFileHandle = () => new Promise(() => {})
    const writing = writeBytesPart(folder, 'part', new Uint8Array([1]), stop.signal)

    stop.abort(stopped())
    await expect(writing).rejects.toThrow('stopped')
  })

  it('aborts a writable that opens only after the Stop', async () => {
    const stop = new AbortController()
    let open!: (writable: BundleWritable) => void
    const aborted = vi.fn(async () => {})
    folder.getFileHandle = async () => ({
      getFile: async () => new Blob([]),
      createWritable: () => new Promise<BundleWritable>(resolve => (open = resolve)),
    })
    const writing = writeBytesPart(folder, 'part', new Uint8Array([1]), stop.signal)
    await vi.waitFor(() => expect(open).toBeDefined())

    stop.abort(stopped())
    await expect(writing).rejects.toThrow('stopped')
    open({write: async () => {}, close: async () => {}, abort: aborted})
    await vi.waitFor(() => expect(aborted).toHaveBeenCalled())
  })

  it('ends a bundle check on Stop while the drive is slow to answer, as a stop and not a bad bundle', async () => {
    const stop = new AbortController()
    folder.getFileHandle = () => new Promise(() => {})
    const checking = verifyBundle({folder, workspaceId: WS, signal: stop.signal})

    stop.abort(stopped())
    await expect(checking).rejects.toThrow('stopped')
    await expect(checking).rejects.not.toBeInstanceOf(BundleInvalid)
  })
})

describe('scanPart', () => {
  it('ends on Stop even while the drive is slow to give a read', async () => {
    const stop = new AbortController()
    const stalled = {stream: () => new ReadableStream<Uint8Array>({pull: () => new Promise<void>(() => {})})} as unknown as Blob
    const scanning = scanPart(stalled, undefined, stop.signal)

    stop.abort(new DOMException('stopped', 'AbortError'))
    await expect(scanning).rejects.toThrow('stopped')
  })
})

describe('takeBundle', () => {
  it('stops at once on Stop while the destination is slow to take a write', async () => {
    await flipUnder(server, wk)
    const stop = new AbortController()
    const open = folder.getFileHandle.bind(folder)
    let writing = false
    // The drive stops answering partway through the history.
    folder.getFileHandle = async (name, options) => {
      const file = await open(name, options)
      if (name !== BUNDLE_PARTS.history) return file
      return {
        getFile: file.getFile,
        createWritable: async () => ({
          write: () => { writing = true; return new Promise<void>(() => {}) },
          close: async () => {},
          abort: async () => {},
        }),
      }
    }

    const taking = take({signal: stop.signal})
    await vi.waitFor(() => expect(writing).toBe(true))
    stop.abort(new DOMException('stopped', 'AbortError'))

    await expect(taking).rejects.toThrow('stopped')
    // Opening the part made an empty file; nothing was written into it.
    expect(folder.files.get(BUNDLE_PARTS.history)).toEqual(new Uint8Array())
    expect(folder.files.has(BUNDLE_PARTS.manifest)).toBe(false)
  })

  it('archives every block row and every history row verbatim, with matching counts', async () => {
    await flipUnder(server, wk)
    const {manifest} = await take()

    expect(lines(BUNDLE_PARTS.blocks)).toEqual(server.workspaceRows(WS))
    expect(lines(BUNDLE_PARTS.history)).toEqual(server.history(WS))
    expect(manifest).toMatchObject({
      workspaceId: WS,
      through: Math.max(...server.history(WS).map(row => row.event_id)),
      serverBlockCount: 5,
      parts: {[BUNDLE_PARTS.blocks]: {lines: 5}, [BUNDLE_PARTS.history]: {lines: 5}, [BUNDLE_PARTS.localDb]: {bytes: FAKE_LOCAL_DB.length}},
    })
    expect(manifest.propertiesMigration).toBe('children')
    expect(manifestOf()).toEqual(manifest)
    expect(await verify()).toMatchObject({manifest, counted: {blockRows: 5, historyRows: 5, through: manifest.through}})
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

  it('copies this device\'s database before the long server read, so a slow folder fails first', async () => {
    await expect(take({writeLocalDb: async () => { throw new Error('too slow') }})).rejects.toThrow('too slow')
    expect(server.calls.some(call => call.method === 'readFullBlockPage' || call.method === 'readHistoryPage')).toBe(false)
  })

  it('hands the run\'s signal to the database copy, so Stop releases the database lock', async () => {
    const run = new AbortController()
    let seen: AbortSignal | undefined
    await take({signal: run.signal, writeLocalDb: async (into, signal) => ((seen = signal), writeFakeLocalDb(into))})

    expect(seen).toBe(run.signal)
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

  it('refuses a history read that skipped a row', async () => {
    const read = server.readHistoryPage.bind(server)
    server.readHistoryPage = async (...args) => (await read(...args)).filter(row => row.event_id !== 2)

    await expect(take()).rejects.toThrow(/4 of its 5 history rows/)
  })

  it('treats a session that sees no rows as an error, not an empty workspace', async () => {
    server.signedOut = true
    await expect(take()).rejects.toThrow(/permission denied|not visible to this session/)
    expect(folder.files.has(BUNDLE_PARTS.manifest)).toBe(false)
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
    expect(await problemOf(verify())).toBe('unreadable')
  })

  it('refuses a bundle missing one of its parts', async () => {
    folder.files.delete(BUNDLE_PARTS.history)
    expect(await problemOf(verify())).toBe('part-unreadable')
  })

  it('refuses a manifest that claims a line count its parts do not hold', async () => {
    for (const name of [BUNDLE_PARTS.blocks, BUNDLE_PARTS.history]) {
      await take()
      const manifest = manifestOf()
      folder.setText(BUNDLE_PARTS.manifest, JSON.stringify({
        ...manifest,
        parts: {...manifest.parts, [name]: {...manifest.parts[name], lines: manifest.parts[name].lines + 1}},
      }))
      expect(await problemOf(verify())).toBe('row-count')
    }
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
