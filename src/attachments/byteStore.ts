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

export interface ByteStore {
  /** The stored plaintext bytes, or `null` on a miss. */
  get(userId: string, workspaceId: string, contentKey: string): Promise<Uint8Array<ArrayBuffer> | null>
  /** Write already-verified plaintext bytes (the resolver hash-checks first). */
  put(userId: string, workspaceId: string, contentKey: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>
  /** Is the object present locally? (the §6 down-lane's "already replicated?" probe). */
  has(userId: string, workspaceId: string, contentKey: string): Promise<boolean>
  /** Drop a single object's bytes — the §9 reconciler's orphan reap (a never-
   *  committed capture's bytes). A no-op when absent. */
  delete(userId: string, workspaceId: string, contentKey: string): Promise<void>
  /** Drop every byte for one (user, workspace) — the §8 revoke/leave claw-back.
   *  A no-op when nothing is stored. */
  purgeWorkspace(userId: string, workspaceId: string): Promise<void>
}

/** Path segments under the OPFS root for one object. Each segment is
 *  `encodeURIComponent`-escaped so a `/` (or other reserved character) in an id
 *  becomes one inert directory name — it can't introduce extra tree levels or
 *  alias two distinct ids (a content-key is hex, but a workspace/account id is
 *  not guaranteed safe). Note `encodeURIComponent` does NOT alter `.`/`..`/empty;
 *  those aren't produced by real ids (UUID account/workspace, hex key), and the
 *  File System API rejects such names with a `TypeError` that the resolver's
 *  outer fail-closed guard turns into a placeholder (never a tree escape). */
export const assetPathSegments = (userId: string, workspaceId: string, contentKey: string): string[] => [
  ASSETS_ROOT,
  encodeURIComponent(userId),
  encodeURIComponent(workspaceId),
  encodeURIComponent(contentKey),
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

  async delete(userId: string, workspaceId: string, contentKey: string): Promise<void> {
    this.blobs.delete(this.key(userId, workspaceId, contentKey))
  }

  async purgeWorkspace(userId: string, workspaceId: string): Promise<void> {
    const prefix = `${ASSETS_ROOT}/${encodeURIComponent(userId)}/${encodeURIComponent(workspaceId)}/`
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

  constructor(deps: OpfsByteStoreDeps = {}) {
    this.getRoot = deps.getRoot ?? (() => navigator.storage.getDirectory())
  }

  /** Walk a chain of (already-encoded) directory names from the OPFS root.
   *  `create: false` throws `NotFoundError` at the first missing dir (a read
   *  miss); `create: true` makes them (a write). */
  private async walk(names: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
    let dir = await this.getRoot()
    for (const name of names) {
      dir = await dir.getDirectoryHandle(name, { create })
    }
    return dir
  }

  /** The `assets/<user>/<ws>` directory holding one workspace's object files. */
  private workspaceDir(userId: string, workspaceId: string, create: boolean): Promise<FileSystemDirectoryHandle> {
    return this.walk([ASSETS_ROOT, encodeURIComponent(userId), encodeURIComponent(workspaceId)], create)
  }

  async get(userId: string, workspaceId: string, contentKey: string): Promise<Uint8Array<ArrayBuffer> | null> {
    try {
      const dir = await this.workspaceDir(userId, workspaceId, false)
      const fileHandle = await dir.getFileHandle(encodeURIComponent(contentKey))
      const file = await fileHandle.getFile()
      return new Uint8Array(await file.arrayBuffer())
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  async put(userId: string, workspaceId: string, contentKey: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    const dir = await this.workspaceDir(userId, workspaceId, true)
    const fileHandle = await dir.getFileHandle(encodeURIComponent(contentKey), { create: true })
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
      await dir.getFileHandle(encodeURIComponent(contentKey))
      return true
    } catch (err) {
      if (isNotFound(err)) return false
      throw err
    }
  }

  async delete(userId: string, workspaceId: string, contentKey: string): Promise<void> {
    try {
      const dir = await this.workspaceDir(userId, workspaceId, false)
      await dir.removeEntry(encodeURIComponent(contentKey))
    } catch (err) {
      if (isNotFound(err)) return // already gone — fine
      throw err
    }
  }

  async purgeWorkspace(userId: string, workspaceId: string): Promise<void> {
    try {
      // Walk to the USER dir, then remove the workspace subtree from it.
      const userDir = await this.walk([ASSETS_ROOT, encodeURIComponent(userId)], false)
      await userDir.removeEntry(encodeURIComponent(workspaceId), { recursive: true })
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
