import { randomUUID } from 'node:crypto'
import { openAsBlob } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { BundleFile, BundleFolder, BundleWritable } from '../bundle/bundleParts.js'

const notFound = (path: string) => new DOMException(`${path} not found`, 'NotFoundError')

const kindOf = async (path: string): Promise<'file' | 'directory' | null> => {
  try {
    return (await stat(path)).isDirectory() ? 'directory' : 'file'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

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
      if (!options?.create || (await kindOf(this.path)) !== 'directory') throw notFound(path)
      await (await open(path, 'wx')).close()
    }
    return {
      getFile: async (): Promise<Blob> => {
        try {
          return await openAsBlob(path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw notFound(path)
          throw error
        }
      },
      createWritable: async (): Promise<BundleWritable> => {
        const swap = join(this.path, `.${name}.${randomUUID()}.crswap`)
        const handle = await open(swap, 'w')
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
      if (!options?.create || (await kindOf(this.path)) !== 'directory') throw notFound(path)
      await mkdir(path)
    }
    return new FsBundleFolder(path)
  }

  async removeEntry(name: string, options?: {recursive?: boolean}): Promise<void> {
    const path = join(this.path, name)
    if ((await kindOf(path)) === null) throw notFound(path)
    await rm(path, {recursive: options?.recursive ?? false})
  }
}
