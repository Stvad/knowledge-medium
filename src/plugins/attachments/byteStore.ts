/**
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
 * Destruction is the coarse platform clear (§7.2) — this store has no per-store
 * wipe role; `purgeWorkspace` is an AUTHORIZATION claw-back (revoke/leave), not
 * a destruction hook.
 */

/** Root directory name under the OPFS root for all asset bytes. */
export const ASSETS_ROOT = 'assets'

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
  /** Write already-verified plaintext bytes (the resolver hash-checks first). */
  put(userId: string, workspaceId: string, contentKey: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>
  /** Is the object present locally? (the §6 down-lane's "already replicated?" probe). */
  has(userId: string, workspaceId: string, contentKey: string): Promise<boolean>
  /** Every stored object's content-key for one (user, workspace) — the down-lane's
   *  ONE-SHOT presence scan (§8): a single directory enumeration in place of a `has()`
   *  per block. Empty when nothing is stored. */
  listWorkspaceKeys(userId: string, workspaceId: string): Promise<Set<string>>
  /** Every workspace id that has bytes stored for this user — a single
   *  `assets/<user>/` directory enumeration. Empty when the user has nothing stored.
   *  The §16 GC's entry point: the stored prefixes it diffs against the user's still-
   *  accessible workspaces to find orphaned (revoked/left) ones to `purgeWorkspace`. */
  listWorkspaceIds(userId: string): Promise<Set<string>>
  /** Drop a single object's bytes — the §9 reconciler's orphan reap (a never-
   *  committed capture's bytes). A no-op when absent. */
  delete(userId: string, workspaceId: string, contentKey: string): Promise<void>
  /** Drop every byte for one (user, workspace) — the §8 revoke/leave claw-back.
   *  A no-op when nothing is stored. */
  purgeWorkspace(userId: string, workspaceId: string): Promise<void>
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
  private readonly blobs = new Map<string, Uint8Array>()

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

  /** The `assets/<user>/` key prefix — one workspace-id enumeration reads the segment
   *  after it. Kept alongside {@link wsPrefix} so both scans encode the user the same way. */
  private userPrefix(userId: string): string {
    return `${ASSETS_ROOT}/${encodeSegment(userId)}/`
  }

  async get(userId: string, workspaceId: string, contentKey: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const hit = this.blobs.get(this.key(userId, workspaceId, contentKey))
    return hit ? new Uint8Array(hit) : null
  }

  async put(userId: string, workspaceId: string, contentKey: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    this.blobs.set(this.key(userId, workspaceId, contentKey), new Uint8Array(bytes))
  }

  async has(userId: string, workspaceId: string, contentKey: string): Promise<boolean> {
    return this.blobs.has(this.key(userId, workspaceId, contentKey))
  }

  async listWorkspaceKeys(userId: string, workspaceId: string): Promise<Set<string>> {
    const prefix = this.wsPrefix(userId, workspaceId)
    const out = new Set<string>()
    for (const k of this.blobs.keys()) {
      if (k.startsWith(prefix)) out.add(decodeSegment(k.slice(prefix.length)))
    }
    return out
  }

  async listWorkspaceIds(userId: string): Promise<Set<string>> {
    const prefix = this.userPrefix(userId)
    const out = new Set<string>()
    for (const k of this.blobs.keys()) {
      if (!k.startsWith(prefix)) continue
      // `k` is `assets/<enc user>/<enc ws>/<enc key>` — encodeSegment escapes any `/`,
      // so the segment up to the next `/` is exactly the (encoded) workspace id.
      const wsSegment = k.slice(prefix.length).split('/', 1)[0]
      if (wsSegment) out.add(decodeSegment(wsSegment))
    }
    return out
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
}

/**
 * OPFS-backed store (the production §8 store). Each `(user, workspace, key)`
 * walks `assets/<user>/<ws>/<key>` as a directory tree, creating dirs on `put`
 * and treating a `NotFoundError` as a miss on read.
 */
export class OpfsByteStore implements ByteStore {
  private readonly getRoot: () => Promise<FileSystemDirectoryHandle>
  /** Cached OPFS root + per-(user,ws) dir handles, so repeated ops (the down-lane's
   *  probes, capture/demand reads+writes) skip re-walking the 3-level chain from the
   *  root each call. Only SUCCESSFUL resolutions are cached. Invalidated on
   *  `purgeWorkspace`; a handle left stale by external eviction is handled per-op
   *  (reads → NotFound miss; `put` invalidates + retries). */
  private rootCache?: Promise<FileSystemDirectoryHandle>
  private readonly wsDirCache = new Map<string, Promise<FileSystemDirectoryHandle>>()

  constructor(deps: OpfsByteStoreDeps = {}) {
    this.getRoot = deps.getRoot ?? (() => navigator.storage.getDirectory())
  }

  private root(): Promise<FileSystemDirectoryHandle> {
    return (this.rootCache ??= this.getRoot())
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

  async put(userId: string, workspaceId: string, contentKey: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    try {
      await this.writeFile(userId, workspaceId, contentKey, bytes)
    } catch {
      // A cached ws-dir handle may be stale (the dir was removed by a purge or evicted
      // out-of-band): drop it and retry once from a fresh resolve, which re-creates the chain.
      this.wsDirCache.delete(this.wsCacheKey(userId, workspaceId))
      await this.writeFile(userId, workspaceId, contentKey, bytes)
    }
  }

  private async writeFile(
    userId: string,
    workspaceId: string,
    contentKey: string,
    bytes: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    const dir = await this.workspaceDir(userId, workspaceId, true)
    const fileHandle = await dir.getFileHandle(encodeSegment(contentKey), { create: true })
    const writable = await fileHandle.createWritable()
    try {
      await writable.write(bytes)
    } finally {
      await writable.close()
    }
  }

  async has(userId: string, workspaceId: string, contentKey: string): Promise<boolean> {
    try {
      const dir = await this.workspaceDir(userId, workspaceId, false)
      await dir.getFileHandle(encodeSegment(contentKey))
      return true
    } catch (err) {
      if (isNotFound(err)) return false
      throw err
    }
  }

  async listWorkspaceKeys(userId: string, workspaceId: string): Promise<Set<string>> {
    try {
      const dir = await this.workspaceDir(userId, workspaceId, false)
      const keys = new Set<string>()
      for await (const name of dir.keys()) keys.add(decodeSegment(name))
      return keys
    } catch (err) {
      if (isNotFound(err)) return new Set() // no objects stored for this (user, workspace) yet
      throw err
    }
  }

  async listWorkspaceIds(userId: string): Promise<Set<string>> {
    try {
      const userDir = await this.walk([ASSETS_ROOT, encodeSegment(userId)], false)
      const ids = new Set<string>()
      // Under the user dir every entry is a workspace directory (put only ever creates
      // `assets/<user>/<ws>/`), so each name decodes back to a workspace id.
      for await (const name of userDir.keys()) ids.add(decodeSegment(name))
      return ids
    } catch (err) {
      if (isNotFound(err)) return new Set() // nothing stored for this user yet
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
    // COORDINATION CAVEAT for the §16 reference-GC job (its sole caller, `assetGc.
    // runMediaGcSweep`): a purge that races a concurrent down-lane `put` for the same
    // workspace can lose, because `put`'s retry re-creates the ws dir from a fresh resolve
    // after this `removeEntry`. So the GC runs with the workspace quiescent — it holds the
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
