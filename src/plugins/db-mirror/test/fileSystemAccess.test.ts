// @vitest-environment node
import {afterEach, describe, expect, it, vi} from 'vitest'
import {
  chooseMirrorDirectory,
  queryDirectoryPermission,
  requestDirectoryPermission,
  supportsDirectoryMirroring,
} from '../fileSystemAccess.js'

const withPicker = (picker: unknown): void => {
  Object.defineProperty(globalThis, 'showDirectoryPicker', {configurable: true, value: picker})
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'showDirectoryPicker')
})

describe('the file system access surface', () => {
  it('offers the feature only where a folder can actually be chosen', () => {
    expect(supportsDirectoryMirroring()).toBe(false)
    withPicker(() => {})
    expect(supportsDirectoryMirroring()).toBe(true)
  })

  it('asks the picker for WRITE access, not read', async () => {
    // A read grant hands back a handle that looks fine and fails on every
    // write, so the mirror would report a chosen folder and never copy into it.
    const picker = vi.fn(async () => ({kind: 'directory'}))
    withPicker(picker)

    await chooseMirrorDirectory()

    expect(picker).toHaveBeenCalledWith(expect.objectContaining({mode: 'readwrite'}))
  })

  it('asks about the same access it would use', async () => {
    const directory = {
      queryPermission: vi.fn(async () => 'granted' as PermissionState),
      requestPermission: vi.fn(async () => 'granted' as PermissionState),
    } as unknown as FileSystemDirectoryHandle

    await queryDirectoryPermission(directory)
    await requestDirectoryPermission(directory)

    const asked = directory as unknown as {
      queryPermission: ReturnType<typeof vi.fn>
      requestPermission: ReturnType<typeof vi.fn>
    }
    expect(asked.queryPermission).toHaveBeenCalledWith({mode: 'readwrite'})
    expect(asked.requestPermission).toHaveBeenCalledWith({mode: 'readwrite'})
  })

  it('answers "granted" where the browser has no permission methods, rather than never mirroring', async () => {
    // Fails OPEN on purpose: such a handle can only have come from a picker in
    // this same session, and a real write failure surfaces on its own. Failing
    // closed would turn a browser that merely lacks the query into one that can
    // never mirror at all.
    const bare = {kind: 'directory'} as unknown as FileSystemDirectoryHandle

    expect(await queryDirectoryPermission(bare)).toBe('granted')
    expect(await requestDirectoryPermission(bare)).toBe('granted')
  })

  it('has nothing to offer when the browser has no picker', async () => {
    expect(await chooseMirrorDirectory()).toBeUndefined()
  })
})
