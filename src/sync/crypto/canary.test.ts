import { describe, expect, it } from 'vitest'
import { mintCanary, validateCanary } from './canary.js'
import { importWorkspaceKey } from './workspaceKey.js'

const keyFrom = (fill: number) => importWorkspaceKey(new Uint8Array(32).fill(fill))

describe('workspace key canary', () => {
  it('validates the minting key against its own workspace', async () => {
    const key = await keyFrom(0x01)
    const canary = await mintCanary(key, 'ws-A')
    expect(await validateCanary(key, canary, 'ws-A')).toBe(true)
  })

  it('rejects a different key (wrong key)', async () => {
    const canary = await mintCanary(await keyFrom(0x01), 'ws-A')
    expect(await validateCanary(await keyFrom(0x02), canary, 'ws-A')).toBe(false)
  })

  it('rejects the right key against the wrong workspace id', async () => {
    const key = await keyFrom(0x01)
    const canary = await mintCanary(key, 'ws-A')
    expect(await validateCanary(key, canary, 'ws-B')).toBe(false)
  })

  it('rejects a malformed canary without throwing', async () => {
    const key = await keyFrom(0x01)
    expect(await validateCanary(key, 'not-an-envelope', 'ws-A')).toBe(false)
  })
})
