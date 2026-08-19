import { describe, expect, it, vi } from 'vitest'
import { releasePowerSyncConnection } from './releasePowerSyncConnection'

describe('releasePowerSyncConnection', () => {
  it('uses the high-level close when it succeeds (no adapter fallback)', async () => {
    const adapterClose = vi.fn(async () => {})
    const close = vi.fn(async () => {})

    await releasePowerSyncConnection({ close, database: { close: adapterClose } })

    expect(close).toHaveBeenCalledOnce()
    expect(adapterClose).not.toHaveBeenCalled()
  })

  it('falls back to the adapter close when high-level close rejects (failed init)', async () => {
    // PowerSyncDatabase.close() awaits waitForReady(), which re-throws a rejected
    // init — so on a corrupt DB it never reaches the adapter close that releases
    // the OPFS handle. The adapter close (constructed pre-init) must still run.
    const adapterClose = vi.fn(async () => {})
    const close = vi.fn(async () => {
      throw new Error('waitForReady rejected: database disk image is malformed')
    })

    await releasePowerSyncConnection({ close, database: { close: adapterClose } })

    expect(adapterClose).toHaveBeenCalledOnce()
  })

  it('does not throw when both closes fail (best-effort handle release)', async () => {
    const close = vi.fn(async () => {
      throw new Error('high-level close failed')
    })
    const adapterClose = vi.fn(async () => {
      throw new Error('adapter close failed')
    })

    await expect(
      releasePowerSyncConnection({ close, database: { close: adapterClose } }),
    ).resolves.toBeUndefined()
  })
})
