/**
 * Cross-tab propagation of workspace-key changes (design doc §5).
 *
 * When a WK is pasted (or cleared) in one tab, other tabs of the same
 * origin need to learn about it so a locked workspace unlocks everywhere.
 * IndexedDB writes don't emit the `storage` event (that's localStorage
 * only), so we announce changes over a `BroadcastChannel`. The message
 * carries no key material — only the (user, workspace) coordinate and
 * what happened — so a listener re-reads the key store (§5) itself.
 *
 * The routing (filtering + listener fan-out) is factored over a minimal
 * {@link MessageBus} so it can be unit-tested with an in-memory bus: a
 * real `BroadcastChannel` does not deliver between instances under Node,
 * only in a browser.
 */

export type KeyChangeKind = 'added' | 'removed'

export interface KeyChange {
  readonly userId: string
  readonly workspaceId: string
  readonly kind: KeyChangeKind
}

export interface KeyBroadcast {
  /** Announce a change to other tabs. */
  post(change: KeyChange): void
  /** Subscribe to changes from other tabs. Returns an unsubscribe fn. */
  subscribe(listener: (change: KeyChange) => void): () => void
  /** Tear down the underlying channel. */
  close(): void
}

/**
 * Minimal transport this module needs. `addListener` (rather than an
 * `onmessage` property) sidesteps the contravariance mismatch between a
 * real `BroadcastChannel.onmessage` (`MessageEvent`) and our handler, and
 * keeps the in-memory test bus trivial.
 */
export interface MessageBus {
  postMessage(data: unknown): void
  addListener(handler: (data: unknown) => void): void
  close(): void
}

const CHANNEL_NAME = 'km-e2ee-keys'

const isKeyChange = (value: unknown): value is KeyChange => {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.userId === 'string' &&
    typeof candidate.workspaceId === 'string' &&
    (candidate.kind === 'added' || candidate.kind === 'removed')
  )
}

/** No-op broadcast for environments without `BroadcastChannel`. Single-tab
 *  still works; only cross-tab sync is lost. */
const NOOP_BROADCAST: KeyBroadcast = {
  post: () => {},
  subscribe: () => () => {},
  close: () => {},
}

/** Wire key-change routing over any message bus. Exported for unit tests. */
export const createKeyBroadcastOver = (bus: MessageBus): KeyBroadcast => {
  const listeners = new Set<(change: KeyChange) => void>()

  bus.addListener((data) => {
    if (!isKeyChange(data)) return
    for (const listener of listeners) listener(data)
  })

  return {
    post: (change) => bus.postMessage(change),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    close: () => {
      listeners.clear()
      bus.close()
    },
  }
}

/** Adapt a real `BroadcastChannel` to {@link MessageBus}. */
const broadcastChannelBus = (channel: BroadcastChannel): MessageBus => ({
  postMessage: (data) => channel.postMessage(data),
  addListener: (handler) =>
    channel.addEventListener('message', (event) => handler((event as MessageEvent).data)),
  close: () => channel.close(),
})

export const createKeyBroadcast = (): KeyBroadcast => {
  if (typeof BroadcastChannel === 'undefined') return NOOP_BROADCAST
  return createKeyBroadcastOver(broadcastChannelBus(new BroadcastChannel(CHANNEL_NAME)))
}
