import {mkdtempSync, readdirSync, readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
import {assetPathSegments} from '@/plugins/attachments/byteStore'
import {describeByteStoreContract} from '@/plugins/attachments/test/byteStoreContract'
import {FsByteStore} from './byteStore'

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
