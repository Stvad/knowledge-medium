import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryByteStore } from './byteStore.js'
import { EMPTY_ENTRY_MIN_AGE_MS, repairByteStoreOnce, resetByteStoreRepairForTests } from './byteStoreRepair.js'

const U = 'user-1'
const WS = 'ws-A'

describe('repairByteStoreOnce', () => {
  beforeEach(() => resetByteStoreRepairForTests())

  it('sweeps the (user, workspace) once per page — a later call is a no-op', async () => {
    const store = new InMemoryByteStore()
    const sweep = vi.spyOn(store, 'sweepEmpty')
    await repairByteStoreOnce(store, U, WS)
    await repairByteStoreOnce(store, U, WS)
    expect(sweep).toHaveBeenCalledTimes(1)
    expect(sweep).toHaveBeenCalledWith(U, WS, { minAgeMs: EMPTY_ENTRY_MIN_AGE_MS })
  })

  it('is keyed by (user, workspace): another workspace or user gets its own sweep', async () => {
    const store = new InMemoryByteStore()
    const sweep = vi.spyOn(store, 'sweepEmpty')
    await repairByteStoreOnce(store, U, WS)
    await repairByteStoreOnce(store, U, 'ws-B')
    await repairByteStoreOnce(store, 'user-2', WS)
    expect(sweep).toHaveBeenCalledTimes(3)
  })

  it('removes the empty entries past the age floor (an older build’s poison), so they stop existing', async () => {
    const store = new InMemoryByteStore({ now: () => Date.now() - EMPTY_ENTRY_MIN_AGE_MS - 1 })
    await store.put(U, WS, 'poisoned', new Uint8Array(0))
    await store.put(U, WS, 'fine', new Uint8Array([1]))
    await repairByteStoreOnce(store, U, WS)
    expect(await store.stat(U, WS, 'poisoned')).toBeNull()
    expect(await store.listWorkspaceKeys(U, WS)).toEqual(new Set(['fine']))
  })

  it('spares a YOUNG empty entry — a put still filling it', async () => {
    const store = new InMemoryByteStore() // stamps "now"
    await store.put(U, WS, 'in-flight', new Uint8Array(0))
    await repairByteStoreOnce(store, U, WS)
    expect(await store.stat(U, WS, 'in-flight')).not.toBeNull()
  })

  it('a failed sweep never throws, and is retried on the next call', async () => {
    const store = new InMemoryByteStore()
    const sweep = vi.spyOn(store, 'sweepEmpty').mockRejectedValueOnce(new Error('locked'))
    await expect(repairByteStoreOnce(store, U, WS)).resolves.toBeUndefined()
    await repairByteStoreOnce(store, U, WS)
    expect(sweep).toHaveBeenCalledTimes(2)
  })
})
