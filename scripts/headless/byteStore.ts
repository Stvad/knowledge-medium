import {randomUUID} from 'node:crypto'
import {mkdir, readdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises'
import {dirname, join} from 'node:path'
import {assetPathSegments, decodeSegment, type ByteStore} from '@/plugins/attachments/byteStore'

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

/** The host's plaintext asset bytes, as files under `root` laid out like the
 *  browser's OPFS store. The resolver serves a stored file as already verified, so
 *  an object path only ever holds a complete file: each write lands in `partial/`
 *  and is renamed into place. The directory is not fsynced after the rename: on a
 *  power loss a capture's file can be missing, which fails its upload record
 *  visibly, and adding the same bytes again re-arms it. */
export class FsByteStore implements ByteStore {
  private readonly partial: string
  /** One process owns a state directory, so what `partial/` holds at the first
   *  write is an earlier process's interrupted write. */
  private swept?: Promise<void>

  constructor(private readonly root: string) {
    this.partial = join(root, 'partial')
  }

  private object(userId: string, workspaceId: string, contentKey: string) {
    return join(this.root, ...assetPathSegments(userId, workspaceId, contentKey))
  }

  private workspace(userId: string, workspaceId: string) {
    return dirname(this.object(userId, workspaceId, ''))
  }

  async get(userId: string, workspaceId: string, contentKey: string): Promise<Uint8Array<ArrayBuffer> | null> {
    try {
      return new Uint8Array(await readFile(this.object(userId, workspaceId, contentKey)))
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  async put(userId: string, workspaceId: string, contentKey: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    const target = this.object(userId, workspaceId, contentKey)
    await (this.swept ??= rm(this.partial, {recursive: true, force: true}))
    const partial = join(this.partial, randomUUID())
    await mkdir(this.partial, {recursive: true})
    await mkdir(dirname(target), {recursive: true})
    try {
      await writeFile(partial, bytes, {flush: true})
      await rename(partial, target)
    } catch (error) {
      await rm(partial, {force: true})
      throw error
    }
  }

  async has(userId: string, workspaceId: string, contentKey: string): Promise<boolean> {
    try {
      return (await stat(this.object(userId, workspaceId, contentKey))).isFile()
    } catch (error) {
      if (isMissing(error)) return false
      throw error
    }
  }

  async listWorkspaceKeys(userId: string, workspaceId: string): Promise<Set<string>> {
    try {
      return new Set((await readdir(this.workspace(userId, workspaceId))).map(decodeSegment))
    } catch (error) {
      if (isMissing(error)) return new Set()
      throw error
    }
  }

  async delete(userId: string, workspaceId: string, contentKey: string): Promise<void> {
    await rm(this.object(userId, workspaceId, contentKey), {force: true})
  }

  async purgeWorkspace(userId: string, workspaceId: string): Promise<void> {
    await rm(this.workspace(userId, workspaceId), {recursive: true, force: true})
  }
}
