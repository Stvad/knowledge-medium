import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { bootKey, bootKeyPrefix, idbBootStore } from './bootStore'

describe('idbBootStore', () => {
  it('round-trips entries by build-scoped key and reaps a generation by prefix', async () => {
    const store = idbBootStore()
    const body = new TextEncoder().encode('export const x = 1').buffer
    await store.putAll([
      [bootKey('gen1', 'https://app/a.js'), {status: 200, contentType: 'text/javascript', body}],
      [bootKey('gen2', 'https://app/a.js'), {status: 200, contentType: 'text/javascript', body}],
    ])
    const hit = await store.get(bootKey('gen1', 'https://app/a.js'))
    expect(hit?.contentType).toBe('text/javascript')
    expect(new TextDecoder().decode(hit!.body)).toBe('export const x = 1')
    expect(await store.get(bootKey('gen1', 'https://app/missing.js'))).toBeUndefined()

    await store.deletePrefix(bootKeyPrefix('gen1'))
    expect(await store.get(bootKey('gen1', 'https://app/a.js'))).toBeUndefined()
    expect(await store.get(bootKey('gen2', 'https://app/a.js'))).toBeDefined()
  })
})
