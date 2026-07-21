// @vitest-environment happy-dom
import {beforeEach, describe, expect, it} from 'vitest'
import {ClientLocalSettings} from '@/utils/ClientLocalSettings.js'
import {ExtensionPromptDismissalStore} from '@/extensions/extensionPromptDismissals.js'

/** In-memory localStorage stand-in so the store's persistence is observable
 *  without touching a real (jsdom) localStorage. */
const makeStorage = () => {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  } as unknown as Storage
}

describe('ExtensionPromptDismissalStore', () => {
  let storage: Storage
  let store: ExtensionPromptDismissalStore

  beforeEach(() => {
    storage = makeStorage()
    store = new ExtensionPromptDismissalStore(new ClientLocalSettings(storage))
  })

  it('records a dismissal keyed per blockId + hash', () => {
    store.dismiss('matrix', 'hm')

    expect(store.isDismissed('matrix', 'hm')).toBe(true)
    // A different extension is untouched.
    expect(store.isDismissed('readwise', 'hr')).toBe(false)
    // The same extension at a different source version is NOT dismissed.
    expect(store.isDismissed('matrix', 'other')).toBe(false)
  })

  it('persists across a reload (new store reading the same storage)', () => {
    store.dismiss('matrix', 'hm')

    const reloaded = new ExtensionPromptDismissalStore(
      new ClientLocalSettings(storage),
    )
    expect(reloaded.isDismissed('matrix', 'hm')).toBe(true)
  })

  it('clear() drops a dismissal so a later prompt can nudge again', () => {
    store.dismiss('matrix', 'hm')
    store.clear('matrix')

    expect(store.isDismissed('matrix', 'hm')).toBe(false)
    expect(new ExtensionPromptDismissalStore(new ClientLocalSettings(storage))
      .isDismissed('matrix', 'hm')).toBe(false)
  })

  it('notifies subscribers on change and keeps a stable snapshot otherwise', () => {
    let fired = 0
    store.subscribe(() => fired++)

    const before = store.getSnapshot()
    store.dismiss('matrix', 'hm')
    expect(fired).toBe(1)
    expect(store.getSnapshot()).not.toBe(before)

    // No-op dismiss (same key + hash) doesn't notify.
    store.dismiss('matrix', 'hm')
    expect(fired).toBe(1)
  })

  it('reloadFromStorage notifies only when the stored value actually changed', () => {
    store.dismiss('matrix', 'hm')
    let fired = 0
    store.subscribe(() => fired++)

    // A cross-tab `storage` event that wrote an identical value must not churn.
    store.reloadFromStorage()
    expect(fired).toBe(0)

    // A genuine external change does notify.
    storage.setItem(
      'extensions.prompt-dismissals',
      JSON.stringify({matrix: 'hm', readwise: 'hr'}),
    )
    store.reloadFromStorage()
    expect(fired).toBe(1)
    expect(store.isDismissed('readwise', 'hr')).toBe(true)
  })
})
