/**
 * A minimal File System Access API stand-in for the mirror tests.
 *
 * Models the one behaviour the real write path leans on: a
 * `FileSystemWritableFileStream` writes into a swap file, and the entry's
 * bytes only change when the stream CLOSES. An aborted pipe therefore leaves
 * whatever was there before — which is what makes an interrupted mirror run
 * safe for the copies already on disk.
 */

export interface FakeEntry {
  name: string
  bytes: Uint8Array
}

class FakeFileHandle {
  readonly kind = 'file' as const

  constructor(
    readonly name: string,
    private readonly entry: FakeEntry,
    private readonly onWriteChunk?: (chunk: Uint8Array) => void,
    private readonly onRead?: () => boolean,
  ) {}

  async getFile(): Promise<File> {
    if (this.onRead?.()) throw new DOMException(`cannot read ${this.name}`, 'NotReadableError')
    // A fresh copy: callers read `size` off this, and the entry can be
    // rewritten afterwards.
    return new File([this.entry.bytes.slice()], this.name)
  }

  async createWritable(): Promise<WritableStream<Uint8Array>> {
    const chunks: Uint8Array[] = []
    return new WritableStream<Uint8Array>({
      write: (chunk) => {
        this.onWriteChunk?.(chunk)
        chunks.push(chunk)
      },
      // Only `close` commits — an abort leaves `entry.bytes` untouched.
      close: () => {
        const total = chunks.reduce((n, c) => n + c.byteLength, 0)
        const merged = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
          merged.set(chunk, offset)
          offset += chunk.byteLength
        }
        this.entry.bytes = merged
      },
    })
  }
}

export class FakeDirectoryHandle {
  readonly kind = 'directory' as const
  readonly entries = new Map<string, FakeEntry>()
  /** What `queryPermission` reports. Flip it to model a revoked grant. */
  permission: PermissionState = 'granted'
  /** Names passed to `removeEntry`, in order — the pruning assertions read this. */
  readonly removed: string[] = []
  /** Set to make the next `createWritable().write()` throw, modelling a
   *  quota / IO failure partway through a copy. */
  failWrites: Error | null = null
  /** Names whose `getFile()` rejects — an offline cloud placeholder, or an
   *  OS-level read error on one entry of an otherwise fine folder. */
  readonly unreadable = new Set<string>()

  constructor(readonly name = 'Backups') {}

  seed(name: string, bytes: number | Uint8Array): void {
    const value = typeof bytes === 'number' ? new Uint8Array(bytes) : bytes
    this.entries.set(name, {name, bytes: value})
  }

  names(): string[] {
    return [...this.entries.keys()].sort()
  }

  async queryPermission(): Promise<PermissionState> {
    return this.permission
  }

  async requestPermission(): Promise<PermissionState> {
    this.permission = 'granted'
    return this.permission
  }

  async getFileHandle(
    name: string,
    options?: {create?: boolean},
  ): Promise<FileSystemFileHandle> {
    let entry = this.entries.get(name)
    if (!entry) {
      if (!options?.create) {
        throw new DOMException(`no entry ${name}`, 'NotFoundError')
      }
      // Matches the real API: creating the handle creates an EMPTY entry, well
      // before any bytes are written.
      entry = {name, bytes: new Uint8Array()}
      this.entries.set(name, entry)
    }
    const handle = new FakeFileHandle(
      name,
      entry,
      () => { if (this.failWrites) throw this.failWrites },
      () => this.unreadable.has(name),
    )
    return handle as unknown as FileSystemFileHandle
  }

  async removeEntry(name: string): Promise<void> {
    this.removed.push(name)
    if (!this.entries.delete(name)) {
      throw new DOMException(`no entry ${name}`, 'NotFoundError')
    }
  }

  async *values(): AsyncGenerator<FileSystemFileHandle> {
    for (const [name, entry] of [...this.entries.entries()]) {
      yield new FakeFileHandle(
        name,
        entry,
        undefined,
        () => this.unreadable.has(name),
      ) as unknown as FileSystemFileHandle
    }
  }

  /** The narrowed type the mirror code accepts. */
  asHandle(): FileSystemDirectoryHandle {
    return this as unknown as FileSystemDirectoryHandle
  }
}
