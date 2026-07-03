/**
 * Device-local, per-extension record of "I've seen this prompt and don't
 * want to be nudged about it (for now)."
 *
 * Keyed by `blockId → the live source hash that was dismissed`. Two
 * properties matter, and both are the fix for the reported bug (dismissing
 * one extension's prompt hid a different one, and didn't survive a reload):
 *
 *   - **Per-blockId.** Dismissing extension A records only A. B is never
 *     touched, so the two prompts are independent.
 *   - **Persisted + hash-scoped.** The dismissal is written to localStorage
 *     so it survives a reload, but it's pinned to the *source version* that
 *     was showing. If the extension's live source later changes (new hash),
 *     the dismissal no longer matches and the prompt re-surfaces — a fresh
 *     update still nudges, an already-declined one stays quiet.
 *
 * Device-local (localStorage), matching where the underlying approval trust
 * grant lives — a dismissal is a per-device UI choice, not synced intent.
 *
 * Mirrors the settings surface: the extension still appears in Extensions
 * settings with a working Enable/Update button regardless of dismissal —
 * dismissing only silences the *global* toast + status-chip nudge.
 */
import {useSyncExternalStore} from 'react'
import {CallbackSet} from '@/utils/callbackSet.js'
import {
  clientLocalSettings,
  type ClientLocalSettings,
} from '@/utils/ClientLocalSettings.js'

const STORAGE_KEY = 'extensions.prompt-dismissals'

/** blockId → dismissed live-source hash. */
export type DismissalMap = Readonly<Record<string, string>>

const decode = (raw: unknown): Record<string, string> => {
  const out: Record<string, string> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [blockId, hash] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof hash === 'string') out[blockId] = hash
  }
  return out
}

export class ExtensionPromptDismissalStore {
  private state: DismissalMap
  private readonly listeners = new CallbackSet('ExtensionPromptDismissals')

  constructor(private readonly storage: ClientLocalSettings = clientLocalSettings) {
    this.state = decode(storage.get<unknown>(STORAGE_KEY, null))
  }

  getSnapshot = (): DismissalMap => this.state

  subscribe = (listener: () => void): (() => void) => this.listeners.add(listener)

  /** True only when this exact (blockId, liveHash) has been dismissed. A
   *  changed source (different liveHash) is NOT dismissed. */
  isDismissed = (blockId: string, liveHash: string): boolean =>
    this.state[blockId] === liveHash

  /** Record a dismissal for one extension, pinned to its current live hash.
   *  Per-blockId — never affects another extension's prompt. */
  dismiss = (blockId: string, liveHash: string): void => {
    if (this.state[blockId] === liveHash) return
    this.state = {...this.state, [blockId]: liveHash}
    this.persist()
    this.notify()
  }

  /** Drop a dismissal — e.g. once the extension is enabled/approved, so a
   *  later update can nudge again and localStorage doesn't accumulate stale
   *  entries. No-op when nothing was dismissed. */
  clear = (blockId: string): void => {
    if (!(blockId in this.state)) return
    const next = {...this.state}
    delete next[blockId]
    this.state = next
    this.persist()
    this.notify()
  }

  /** Re-read from storage. Used by the cross-tab `storage` listener (and
   *  tests) so a dismissal in another tab reflects here. */
  reloadFromStorage = (): void => {
    this.state = decode(this.storage.get<unknown>(STORAGE_KEY, null))
    this.notify()
  }

  private persist(): void {
    this.storage.set(STORAGE_KEY, this.state)
  }

  private notify(): void {
    this.listeners.notify()
  }
}

export const extensionPromptDismissals = new ExtensionPromptDismissalStore()

// Cross-tab consistency: the `storage` event fires only in OTHER tabs, so a
// dismissal made elsewhere reloads our in-memory copy and re-renders.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) extensionPromptDismissals.reloadFromStorage()
  })
}

export const useExtensionPromptDismissals = (): DismissalMap =>
  useSyncExternalStore(
    extensionPromptDismissals.subscribe,
    extensionPromptDismissals.getSnapshot,
    extensionPromptDismissals.getSnapshot,
  )
