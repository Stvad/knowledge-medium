import {mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync} from 'node:fs'
import {rename} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it, vi} from 'vitest'
import {assetPathSegments} from '@/plugins/attachments/byteStore'
import {describeByteStoreContract} from '@/plugins/attachments/test/byteStoreContract'
import {FsByteStore} from './byteStore'

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {...actual, rename: vi.fn(actual.rename)}
})

const freshRoot = () => mkdtempSync(join(tmpdir(), 'km-media-'))

describeByteStoreContract('FsByteStore', () => new FsByteStore(freshRoot()))

describe('FsByteStore on disk', () => {
  it('stores an object at the browser store’s path, and leaves no temporary file', async () => {
    const root = freshRoot()
    await new FsByteStore(root).put('u/1', 'ws', 'k', new Uint8Array([7, 8]))
    expect([...readFileSync(join(root, ...assetPathSegments('u/1', 'ws', 'k')))]).toEqual([7, 8])
    expect(readdirSync(join(root, 'partial'))).toEqual([])
  })

  it('serves what an earlier instance stored', async () => {
    const root = freshRoot()
    await new FsByteStore(root).put('u', 'ws', 'k', new Uint8Array([1]))
    expect(await new FsByteStore(root).get('u', 'ws', 'k')).toEqual(new Uint8Array([1]))
  })
})

describe('FsByteStore writes', () => {
  it('leaves nothing at the object path when a write fails before it is published', async () => {
    const store = new FsByteStore(freshRoot())
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('no space'), {code: 'ENOSPC'}))
    await expect(store.put('u', 'ws', 'k', new Uint8Array([1, 2]))).rejects.toThrow('no space')
    expect(await store.get('u', 'ws', 'k')).toBeNull()
    expect(await store.listWorkspaceKeys('u', 'ws')).toEqual(new Set())
  })

  it('clears a write an earlier process left unpublished', async () => {
    const root = freshRoot()
    mkdirSync(join(root, 'partial'))
    writeFileSync(join(root, 'partial', 'left-by-a-crash'), 'plaintext')
    await new FsByteStore(root).put('u', 'ws', 'k', new Uint8Array([1]))
    expect(readdirSync(join(root, 'partial'))).toEqual([])
  })
})
