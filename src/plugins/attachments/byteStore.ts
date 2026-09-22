/*
 * The local DECRYPTED byte store (design §8) — the single on-disk replica + the
 * render source for asset bytes.
 *
 * One store holding PLAINTEXT bytes (raw for a plaintext workspace, decrypted
 * with the WK for E2EE), keyed by the content-addressed path
 * `assets/<user_id>/<workspace_id>/<content-key>` (§7.3/§8):
 *   - `<user_id>` is the account-isolation boundary (§7) — the store is shared
 *     across the profile's accounts, so every op is user-scoped.
 *   - `<workspace_id>` makes leave/revoke purge only the affected bytes
 *     (`purgeWorkspace`, the §8 one-shot claw-back primitive).
 *   - `<content-key>` is the §10 object path segment the resolver derives.
 *
 * Bytes are written ONCE, already verified (the resolver hash-checks before
 * `put`, §5.1/§7.3), so the store is a dumb content-addressed blob cache — it
 * holds no keys and makes no trust decisions. The backing store is OPFS
 * (`OpfsByteStore`); `InMemoryByteStore` is the test double + no-OPFS fallback.
 *
 * Two write invariants the store DOES own, because OPFS gives neither for free:
 *   - a failed `put` leaves NO INCOMPLETE entry at the key. `getFileHandle(create)`
 *     mints an empty file before any byte lands, so a write that then fails must
 *     remove it — otherwise the empty file reads as a local hit forever. An entry
 *     whose size already equals the bytes being written is a PEER's complete copy of
 *     the same content-addressed bytes (another tab / the PWA / this page's other
 *     resolver) and is never deleted; a peer's open handle is waited for, not failed
 *     on (byteStoreWriter.ts);
 *   - a `put` works on every engine with OPFS: through `createWritable` where the
 *     engine has it, else through a worker + sync access handle (WebKit before
 *     Safari 26 — every iOS 18 browser — has only the latter; byteStoreWriter.ts).
 * The store still does not VERIFY what it reads back: the resolver hashes every
 * local hit against the block (§5.1) and deletes a bad entry once it is old enough
 * to not be a write in flight (`ENTRY_SETTLE_MS`), presence probes (`has`,
 * `listWorkspaceKeys`) report only non-empty entries, and `sweepEmpty` reaps the
 * empty entries an older build left behind.
 *
 * Destruction is the coarse platform clear (§7.2) — this store has no per-store
 * wipe role; `purgeWorkspace` is an AUTHORIZATION claw-back (revoke/leave), not
 * a destruction hook.
 */

import {
  createWorkerFileWriter,
  removeUnlessComplete,
  type WorkerFileWriter,
  type WriterWorkerLike,
} from './byteStoreWriter.js'

/** Root directory name under the OPFS root for all asset bytes. */
export const ASSETS_ROOT = 'assets'

/** An entry younger than this may be a `put` still in flight: the entry is minted
 *  before its bytes land, and a peer's write can be read mid-way. A defective read of
 *  a young entry is a miss but not grounds to delete it; the sweep leaves it alone. */
export const ENTRY_SETTLE_MS = 60_000

// All path-segment encoding routes through here. `encodeURIComponent` turns a `/`
// (or other reserved char) in an id into one inert directory name, but it leaves
// '', '.', '..' UNCHANGED — and the File System API rejects those three as names.
// A UUID/hex id never is one, but a LOCAL account id is the user's typed name
// (Login.tsx: `id` = the typed username), so it can be. Remap exactly those three to
// a `%2E`-built sentinel: `encodeURIComponent` never EMITS `%2E` ('.' is unreserved —
// the only source of a literal dot, and it's left bare), so the sentinel collides
// with no normal segment AND needs no migration (every other id encodes as before).
const encodeComponent = encodeURIComponent
const encodeSegment = (s: string): string => {
  const e = encodeComponent(s)
  if (e === '') return '%2Eempty'
  if (e === '.') return '%2Edot'
  if (e === '..') return '%2Edotdot'
  return e
}

/** Inverse of {@link encodeSegment}: reverse the three sentinels, else
 *  `decodeURIComponent`. Maps an OPFS filename back to the content-key it encodes,
 *  for enumerating a workspace's stored objects ({@link ByteStore.listWorkspaceKeys}). */
const decodeSegment = (s: string): string => {
  if (s === '%2Eempty') return ''
  if (s === '%2Edot') return '.'
  if (s === '%2Edotdot') return '..'
  return decodeURIComponent(s)
}

export interface ByteStore {
  /** The stored plaintext bytes, or `null` on a miss. */
  get(userId: string, workspaceId: string, contentKey: string): Promise<Uint8Array<ArrayBuffer> | null>
  /** Write already-verified plaintext bytes (the resolver hash-checks first).
   *  Resolves once the bytes are durable; rejects — leaving NO entry — when they aren't. */
  put(userId: string, workspaceId: string, contentKey: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>
  /** Is the object present locally, with bytes? (the §6 down-lane's "already replicated?"
   *  probe). An EMPTY entry is not present — nothing was replicated into it. */
  has(userId: string, workspaceId: string, contentKey: string): Promise<boolean>
  /** The entry's size + modification time, or `null` when absent — what the resolver
   *  needs to tell a write in flight from a poisoned entry. */
  stat(userId: string, workspaceId: string, contentKey: string): Promise<ByteStoreEntryStat | null>
  /** Every stored NON-EMPTY object's content-key for one (user, workspace) — the
   *  down-lane's ONE-SHOT presence scan (§8): a single directory enumeration in place
   *  of a `has()` per block, and it agrees with `has()`: an empty entry is not listed.
   *  Empty when nothing is stored. */
  listWorkspaceKeys(userId: string, workspaceId: string): Promise<Set<string>>
  /** Drop a single object's bytes — the §9 reconciler's orphan reap (a never-
   *  committed capture's bytes). A no-op when absent. */
  delete(userId: string, workspaceId: string, contentKey: string): Promise<void>
  /** Drop every byte for one (user, workspace) — the §8 revoke/leave claw-back.
   *  A no-op when nothing is stored. */
  purgeWorkspace(userId: string, workspaceId: string): Promise<void>
  /** Remove every EMPTY entry for one (user, workspace) that is older than `minAgeMs`
   *  — the repair for a store an older build poisoned (a `put` that created the entry
   *  and then failed to write it). The age floor spares an entry a concurrent `put` is
   *  still filling. Idempotent; per-entry failures are skipped. */
  sweepEmpty(userId: string, workspaceId: string, opts: SweepOptions): Promise<SweepResult>
}

export interface SweepOptions {
  /** An empty entry younger than this may be a write in progress — left alone. */
  readonly minAgeMs: number
  /** The clock the age is measured against; injectable for tests. */
  readonly now?: () => number
}

export interface SweepResult {
  readonly scanned: number
  readonly removed: number
}

export interface ByteStoreEntryStat {
  readonly size: number
  /** Epoch ms; `0` when the backing store doesn't track it. */
  readonly lastModified: number
}

/** Path segments under the OPFS root for one object. Each is {@link encodeSegment}-
 *  escaped so a `/` (or other reserved char) in an id becomes one inert directory
 *  name — it can't introduce extra tree levels or alias two distinct ids — and so a
 *  `.`/`..`/empty id (reachable: a local account id is the typed username) is remapped
 *  to a collision-free sentinel the File System API accepts, rather than throwing. */
export const assetPathSegments = (userId: string, workspaceId: string, contentKey: string): string[] => [
  ASSETS_ROOT,
  encodeSegment(userId),
  encodeSegment(workspaceId),
  encodeSegment(contentKey),
]

const isNotFound = (err: unknown): boolean =>
  err instanceof DOMException && err.name === 'NotFoundError'

/**
 * In-memory store: the test double and the fallback when OPFS is unavailable
 * (the bytes then live only for the page's lifetime, which the re-fetchable
 * replica model tolerates — §8). Copies on `put`/`get` so a caller mutating its
 * buffer can't corrupt the cache, matching OPFS's read-a-fresh-File semantics.
 */
export class InMemoryByteStore implements ByteStore {
  private readonly blobs = new Map<string, { bytes: Uint8Array; lastModified: number }>()
  private readonly now: () => number

  /** `now` stamps each put's `lastModified` (the sweep's age floor and the resolver's
   *  settle window read it); injectable so a test can age an entry. */
  constructor(deps: { now?: () => number } = {}) {
    this.now = deps.now ?? Date.now
  }

  private key(userId: string, workspaceId: string, contentKey: string): string {
    return assetPathSegments(userId, workspaceId, contentKey).join('/')
  }

  /** The `assets/<user>/<ws>/` key prefix shared by the workspace-wide scans
   *  (`listWorkspaceKeys` enumerate, `purgeWorkspace` reap) — one source of truth so
   *  the two can't drift. The remainder after it is the {@link encodeSegment}-escaped
   *  content-key. */
  private wsPrefix(userId: string, workspaceId: string): string {
    return `${ASSETS_ROOT}/${encodeSegment(userId)}/${encodeSegment(workspaceId)}/`
  }

  async get(userId: string, workspaceId: string, contentKey: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const hit = this.blobs.get(this.key(userId, workspaceId, contentKey))
    return hit ? new Uint8Array(hit.bytes) : null
  }

  async put(userId: string, workspaceId: string, contentKey: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    this.blobs.set(this.key(userId, workspaceId, contentKey), { bytes: new Uint8Array(bytes), lastModified: this.now() })
  }

  async has(userId: string, workspaceId: string, contentKey: string): Promise<boolean> {
    const hit = this.blobs.get(this.key(userId, workspaceId, contentKey))
    return hit !== undefined && hit.bytes.byteLength > 0
  }

  async stat(userId: string, workspaceId: string, contentKey: string): Promise<ByteStoreEntryStat | null> {
    const hit = this.blobs.get(this.key(userId, workspaceId, contentKey))
    return hit ? { size: hit.bytes.byteLength, lastModified: hit.lastModified } : null
  }

  async listWorkspaceKeys(userId: string, workspaceId: string): Promise<Set<string>> {
    const prefix = this.wsPrefix(userId, workspaceId)
    const out = new Set<string>()
    for (const [k, v] of this.blobs) {
      if (k.startsWith(prefix) && v.bytes.byteLength > 0) out.add(decodeSegment(k.slice(prefix.length)))
    }
    return out
  }

  async sweepEmpty(userId: string, workspaceId: string, opts: SweepOptions): Promise<SweepResult> {
    const prefix = this.wsPrefix(userId, workspaceId)
    const now = opts.now ?? Date.now // wall time, like OPFS's lastModified — `this.now` only stamps
    let scanned = 0
    let removed = 0
    for (const [k, v] of [...this.blobs]) {
      if (!k.startsWith(prefix)) continue
      scanned++
      if (v.bytes.byteLength === 0 && now() - v.lastModified >= opts.minAgeMs) {
        this.blobs.delete(k)
        removed++
      }
    }
    return { scanned, removed }
  }

  async delete(userId: string, workspaceId: string, contentKey: string): Promise<void> {
    this.blobs.delete(this.key(userId, workspaceId, contentKey))
  }

  async purgeWorkspace(userId: string, workspaceId: string): Promise<void> {
    const prefix = this.wsPrefix(userId, workspaceId)
    for (const k of [...this.blobs.keys()]) {
      if (k.startsWith(prefix)) this.blobs.delete(k)
    }
  }
}

export interface OpfsByteStoreDeps {
  /** The OPFS root; injectable for tests. Defaults to the real origin root. */
  getRoot?: () => Promise<FileSystemDirectoryHandle>
  /** Does this engine's `FileSystemFileHandle` have `createWritable`? Decides the
   *  write path ONCE per store; injectable to force the worker path in tests. */
  hasWritableStream?: () => boolean
  /** Spawns the writer worker (byteStoreWriter.worker.ts); injectable for tests. */
  spawnWriterWorker?: () => WriterWorkerLike
  /** How long a worker write may take before it is abandoned; injectable for tests. */
  writeTimeoutMs?: number
}

/** The engine has the stream write API on the main thread (Chromium, Firefox,
 *  Safari 26+); without it (Safari 16.4–18) only a worker's sync access handle
 *  can write. Read off the prototype, not a probe: `createWritable` on a handle
 *  either exists or is `undefined` — there's no runtime feature switch. */
const engineHasWritableStream = (): boolean =>
  typeof FileSystemFileHandle !== 'undefined' &&
  typeof (FileSystemFileHandle.prototype as { createWritable?: unknown }).createWritable === 'function'

const spawnRealWriterWorker = (): WriterWorkerLike =>
  new Worker(new URL('./byteStoreWriter.worker.ts', import.meta.url), { type: 'module' })

/**
 * OPFS-backed store (the production §8 store). Each `(user, workspace, key)`
 * walks `assets/<user>/<ws>/<key>` as a directory tree, creating dirs on `put`
 * and treating a `NotFoundError` as a miss on read.
 */
export class OpfsByteStore implements ByteStore {
  private readonly getRoot: () => Promise<FileSystemDirectoryHandle>
  /** Decided once: the engine's write API doesn't change under a running page. */
  private readonly hasWritableStream: boolean
  /** The worker write path, built on first use (never on an engine with the stream API). */
  private workerWriter?: WorkerFileWriter
  private readonly spawnWriterWorker: () => WriterWorkerLike
  /** Cached OPFS root + per-(user,ws) dir handles, so repeated ops (the down-lane's
   *  probes, capture/demand reads+writes) skip re-walking the 3-level chain from the
   *  root each call. Only SUCCESSFUL resolutions are cached. Invalidated on
   *  `purgeWorkspace`; a handle left stale by external eviction is handled per-op
   *  (reads → NotFound miss; `put` invalidates + retries). */
  private rootCache?: Promise<FileSystemDirectoryHandle>
  private readonly wsDirCache = new Map<string, Promise<FileSystemDirectoryHandle>>()

  private readonly writeTimeoutMs?: number

  constructor(deps: OpfsByteStoreDeps = {}) {
    this.getRoot = deps.getRoot ?? (() => navigator.storage.getDirectory())
    this.hasWritableStream = (deps.hasWritableStream ?? engineHasWritableStream)()
    this.spawnWriterWorker = deps.spawnWriterWorker ?? spawnRealWriterWorker
    this.writeTimeoutMs = deps.writeTimeoutMs
  }

  private root(): Promise<FileSystemDirectoryHandle> {
    return (this.rootCache ??= this.getRoot())
  }

  /** The clean-up for a write the worker was killed in the middle of (a timeout):
   *  drop the entry unless it is already a complete copy (a peer's, or ours before the
   *  reply was lost). Walks with `create: false` — never mints anything. */
  private async removeIfIncomplete(path: readonly string[], byteLength: number): Promise<void> {
    try {
      let dir = await this.root()
      for (const name of path.slice(0, -1)) dir = await dir.getDirectoryHandle(name)
      const name = path[path.length - 1]
      const size = (await (await dir.getFileHandle(name)).getFile()).size
      if (size !== byteLength) await dir.removeEntry(name)
    } catch {
      // absent already, or a peer holds the handle (it is writing the complete copy)
    }
  }

  /** Walk a chain of (already-encoded) directory names from the cached OPFS root.
   *  `create: false` throws `NotFoundError` at the first missing dir (a read
   *  miss); `create: true` makes them (a write). */
  private async walk(names: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
    let dir = await this.root()
    for (const name of names) {
      dir = await dir.getDirectoryHandle(name, { create })
    }
    return dir
  }

  private wsCacheKey(userId: string, workspaceId: string): string {
    return `${encodeSegment(userId)}/${encodeSegment(workspaceId)}`
  }

  /** The `assets/<user>/<ws>` directory holding one workspace's object files, memoized
   *  (see {@link wsDirCache}). When cached the `create` flag is moot — the dir exists. */
  private workspaceDir(userId: string, workspaceId: string, create: boolean): Promise<FileSystemDirectoryHandle> {
    const cacheKey = this.wsCacheKey(userId, workspaceId)
    const cached = this.wsDirCache.get(cacheKey)
    if (cached) return cached
    // Don't cache a FAILED resolve (e.g. a create:false miss on a not-yet-created dir),
    // so a later put() with create:true still gets to make it.
    const pending = this.walk([ASSETS_ROOT, encodeSegment(userId), encodeSegment(workspaceId)], create).catch(
      (err) => {
        this.wsDirCache.delete(cacheKey)
        throw err
      },
    )
    this.wsDirCache.set(cacheKey, pending)
    return pending
  }

  async get(userId: string, workspaceId: string, contentKey: string): Promise<Uint8Array<ArrayBuffer> | null> {
    try {
      const dir = await this.workspaceDir(userId, workspaceId, false)
      const fileHandle = await dir.getFileHandle(encodeSegment(contentKey))
      const file = await fileHandle.getFile()
      return new Uint8Array(await file.arrayBuffer())
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  /** Either write path resolves only once the bytes are durable, and on failure
   *  removes an incomplete entry (see the module header): the stream path via
   *  `abort` + `removeUnlessComplete` here, the worker path inside the worker. */
  async put(userId: string, workspaceId: string, contentKey: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    if (!this.hasWritableStream) {
      // The worker re-walks the path from the root itself — no dir handle to hand it,
      // and none to go stale.
      this.workerWriter ??= createWorkerFileWriter(this.spawnWriterWorker, {
        timeoutMs: this.writeTimeoutMs,
        onAbandoned: (path, byteLength) => this.removeIfIncomplete(path, byteLength),
      })
      await this.workerWriter.write(assetPathSegments(userId, workspaceId, contentKey), bytes)
      return
    }
    try {
      await this.writeViaStream(userId, workspaceId, contentKey, bytes)
    } catch {
      // A cached ws-dir handle may be stale (the dir was removed by a purge or evicted
      // out-of-band): drop it and retry once from a fresh resolve, which re-creates the chain.
      this.wsDirCache.delete(this.wsCacheKey(userId, workspaceId))
      await this.writeViaStream(userId, workspaceId, contentKey, bytes)
    }
  }

  private async writeViaStream(
    userId: string,
    workspaceId: string,
    contentKey: string,
    bytes: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    const dir = await this.workspaceDir(userId, workspaceId, true)
    const name = encodeSegment(contentKey)
    const fileHandle = await dir.getFileHandle(name, { create: true })
    try {
      const writable = await fileHandle.createWritable()
      try {
        await writable.write(bytes)
      } catch (err) {
        await writable.abort().catch(() => {})
        throw err
      }
      await writable.close() // the commit — a failure here leaves the entry as it was, i.e. possibly empty
    } catch (err) {
      // A peer (another tab / this page's other resolver) may hold the file or have
      // just finished it: a complete copy is these same content-addressed bytes, so
      // it is never deleted — and counts as our write having landed.
      await removeUnlessComplete(dir, name, fileHandle, bytes.byteLength)
      if ((await fileHandle.getFile().then((f) => f.size, () => null)) === bytes.byteLength) return
      throw err
    }
  }

  async stat(userId: string, workspaceId: string, contentKey: string): Promise<ByteStoreEntryStat | null> {
    try {
      const dir = await this.workspaceDir(userId, workspaceId, false)
      const file = await (await dir.getFileHandle(encodeSegment(contentKey))).getFile()
      return { size: file.size, lastModified: file.lastModified }
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  async has(userId: string, workspaceId: string, contentKey: string): Promise<boolean> {
    try {
      const dir = await this.workspaceDir(userId, workspaceId, false)
      const fileHandle = await dir.getFileHandle(encodeSegment(contentKey))
      return (await fileHandle.getFile()).size > 0
    } catch (err) {
      if (isNotFound(err)) return false
      throw err
    }
  }

  async sweepEmpty(userId: string, workspaceId: string, opts: SweepOptions): Promise<SweepResult> {
    let scanned = 0
    let removed = 0
    let dir: FileSystemDirectoryHandle
    try {
      dir = await this.workspaceDir(userId, workspaceId, false)
    } catch (err) {
      if (isNotFound(err)) return { scanned, removed } // nothing stored — nothing to repair
      throw err
    }
    const now = opts.now ?? Date.now
    // Snapshot the names first: removing while iterating a live directory listing is
    // engine-defined behaviour.
    const names: string[] = []
    for await (const name of dir.keys()) names.push(name)
    for (const name of names) {
      scanned++
      try {
        const file = await (await dir.getFileHandle(name)).getFile()
        if (file.size !== 0 || now() - file.lastModified < opts.minAgeMs) continue
        await dir.removeEntry(name)
        removed++
      } catch {
        // a directory, an entry that vanished, or one a writer holds open — next sweep
      }
    }
    return { scanned, removed }
  }

  async listWorkspaceKeys(userId: string, workspaceId: string): Promise<Set<string>> {
    try {
      const dir = await this.workspaceDir(userId, workspaceId, false)
      const keys = new Set<string>()
      for await (const [name, entry] of dir.entries()) {
        if (entry.kind !== 'file') continue
        // Only an entry with bytes is present (agreeing with `has()`): an empty one is
        // a poisoned or in-flight write, and one a peer holds open (getFile refused)
        // is in flight — either way not replicated yet, so the down-lane re-checks it.
        const size = await (entry as FileSystemFileHandle).getFile().then((f) => f.size, () => 0)
        if (size > 0) keys.add(decodeSegment(name))
      }
      return keys
    } catch (err) {
      if (isNotFound(err)) return new Set() // no objects stored for this (user, workspace) yet
      throw err
    }
  }

  async delete(userId: string, workspaceId: string, contentKey: string): Promise<void> {
    try {
      const dir = await this.workspaceDir(userId, workspaceId, false)
      await dir.removeEntry(encodeSegment(contentKey))
    } catch (err) {
      if (isNotFound(err)) return // already gone — fine
      throw err
    }
  }

  async purgeWorkspace(userId: string, workspaceId: string): Promise<void> {
    // COORDINATION CAVEAT for the deferred §16 reference-GC job (the only intended caller —
    // there is none today): a purge that races a concurrent down-lane `put` for the same
    // workspace can lose, because `put`'s retry re-creates the ws dir from a fresh resolve
    // after this `removeEntry`. The GC job must run with the workspace quiescent — hold the
    // per-(user,workspace) down-lane lock (laneLock.runSingleOwner) so no `put` is in flight.
    this.wsDirCache.delete(this.wsCacheKey(userId, workspaceId)) // the cached handle is about to go stale
    try {
      // Walk to the USER dir, then remove the workspace subtree from it.
      const userDir = await this.walk([ASSETS_ROOT, encodeSegment(userId)], false)
      await userDir.removeEntry(encodeSegment(workspaceId), { recursive: true })
    } catch (err) {
      if (isNotFound(err)) return // nothing stored for this (user, workspace) — fine
      throw err
    }
  }
}

/** Pick the OPFS store when available, else the in-memory fallback. */
export const createByteStore = (): ByteStore => {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function') {
      return new OpfsByteStore()
    }
  } catch {
    // fall through
  }
  return new InMemoryByteStore()
}

// Process-wide singleton. The read resolver (§7.3), the capture path, the up-lane
// drain, and the reconciler must share ONE store: OPFS is shared backing, but a
// single instance also keeps the in-memory fallback coherent within a session
// (otherwise a write through one instance is invisible to a read through another).
// Tests construct their own store and never touch this.
let sharedByteStore: ByteStore | null = null
export const getByteStore = (): ByteStore => (sharedByteStore ??= createByteStore())
