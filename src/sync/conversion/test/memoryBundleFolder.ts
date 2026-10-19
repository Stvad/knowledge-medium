import type { BundleFile, BundleFolder, BundleWritable } from '../bundle/bundleParts.js'

/** An in-memory folder with the File System Access semantics the bundle relies
 *  on: a writable replaces the file only on `close`, and `abort` discards it. */
export class MemoryBundleFolder implements BundleFolder {
  readonly files = new Map<string, Uint8Array<ArrayBuffer>>()
  readonly folders = new Map<string, MemoryBundleFolder>()

  constructor(readonly name = 'bundle') {}

  async getFileHandle(name: string, options?: {create?: boolean}): Promise<BundleFile> {
    if (!this.files.has(name)) {
      if (!options?.create) throw new DOMException(`${name} not found`, 'NotFoundError')
      this.files.set(name, new Uint8Array())
    }
    return {
      getFile: async () => {
        const bytes = this.files.get(name)
        if (!bytes) throw new DOMException(`${name} not found`, 'NotFoundError')
        return new Blob([bytes])
      },
      createWritable: async (): Promise<BundleWritable> => {
        const chunks: Uint8Array[] = []
        return {
          write: async data => void chunks.push(data.slice()),
          close: async () => {
            const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
            const bytes = new Uint8Array(total)
            let offset = 0
            for (const chunk of chunks) {
              bytes.set(chunk, offset)
              offset += chunk.length
            }
            this.files.set(name, bytes)
          },
          abort: async () => {},
        }
      },
    }
  }

  async getDirectoryHandle(name: string, options?: {create?: boolean}): Promise<MemoryBundleFolder> {
    let folder = this.folders.get(name)
    if (!folder) {
      if (!options?.create) throw new DOMException(`${name} not found`, 'NotFoundError')
      folder = new MemoryBundleFolder(name)
      this.folders.set(name, folder)
    }
    return folder
  }

  text(name: string): string {
    return new TextDecoder().decode(this.files.get(name))
  }

  setText(name: string, text: string): void {
    this.files.set(name, new TextEncoder().encode(text))
  }
}
