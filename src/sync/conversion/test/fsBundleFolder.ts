import { randomUUID } from 'node:crypto'
import { openAsBlob } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { BundleFile, BundleFolder, BundleWritable } from '../bundle/bundleParts.js'

const notFound = (path: string) => new DOMException(`${path} not found`, 'NotFoundError')

/** A filesystem error as File System Access reports it: a moved or deleted
 *  folder, or a path inside one, is a NotFoundError. */
const rethrowAt = (path: string) => (error: unknown): never => {
  const code = (error as NodeJS.ErrnoException).code
  throw code === 'ENOENT' || code === 'ENOTDIR' ? notFound(path) : error
}

const kindOf = (path: string): Promise<'file' | 'directory' | null> =>
  stat(path).then(
    stats => (stats.isDirectory() ? 'directory' : 'file'),
    error => ((error as NodeJS.ErrnoException).code === 'ENOENT' ? null : Promise.reject(error)),
  )

/** A directory on disk with the File System Access semantics the bundle relies
 *  on, as Chromium implements them: a handle names a path, so a moved folder's
 *  handle finds nothing; a writable goes to a swap file that replaces the file
 *  only on `close`, and `abort` discards it. */
export class FsBundleFolder implements BundleFolder {
  constructor(readonly path: string) {}

  get name(): string {
    return basename(this.path)
  }

  async getFileHandle(name: string, options?: {create?: boolean}): Promise<BundleFile> {
    const path = join(this.path, name)
    const kind = await kindOf(path)
    if (kind === 'directory') throw new DOMException(`${path} is a folder`, 'TypeMismatchError')
    if (kind === null) {
      if (!options?.create) throw notFound(path)
      await (await open(path, 'wx').catch(rethrowAt(path))).close()
    }
    return {
      getFile: () => openAsBlob(path).catch(rethrowAt(path)),
      createWritable: async (): Promise<BundleWritable> => {
        const swap = join(this.path, `.${name}.${randomUUID()}.crswap`)
        const handle = await open(swap, 'w').catch(rethrowAt(swap))
        return {
          write: async data => void (await handle.write(data)),
          close: async () => {
            await handle.close()
            await rename(swap, path)
          },
          abort: async () => {
            await handle.close().catch(() => {})
            await rm(swap, {force: true})
          },
        }
      },
    }
  }

  async getDirectoryHandle(name: string, options?: {create?: boolean}): Promise<FsBundleFolder> {
    const path = join(this.path, name)
    const kind = await kindOf(path)
    if (kind === 'file') throw new DOMException(`${path} is a file`, 'TypeMismatchError')
    if (kind === null) {
      if (!options?.create) throw notFound(path)
      await mkdir(path).catch(rethrowAt(path))
    }
    return new FsBundleFolder(path)
  }

  async removeEntry(name: string, options?: {recursive?: boolean}): Promise<void> {
    const path = join(this.path, name)
    await rm(path, {recursive: options?.recursive ?? false}).catch(rethrowAt(path))
  }
}
