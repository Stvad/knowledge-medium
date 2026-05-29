import { describe, expect, it } from 'vitest'
import {
  createKeyBroadcastOver,
  type MessageBus,
  type KeyChange,
} from './keyBroadcast.js'

/** In-memory stand-in for a BroadcastChannel: buses sharing a hub deliver
 *  to each OTHER (never to the poster), matching real semantics. A real
 *  BroadcastChannel doesn't deliver between instances under Node. */
class FakeBus implements MessageBus {
  private handlers: Array<(data: unknown) => void> = []
  constructor(private readonly hub: Set<FakeBus>) {
    hub.add(this)
  }
  postMessage(data: unknown): void {
    for (const peer of this.hub) {
      if (peer !== this) for (const h of peer.handlers) h(data)
    }
  }
  addListener(handler: (data: unknown) => void): void {
    this.handlers.push(handler)
  }
  close(): void {
    this.hub.delete(this)
  }
}

const connectedPair = () => {
  const hub = new Set<FakeBus>()
  return [new FakeBus(hub), new FakeBus(hub)] as const
}

describe('key broadcast routing', () => {
  it('delivers a change from one channel to another (cross-tab)', () => {
    const [sendBus, recvBus] = connectedPair()
    const sender = createKeyBroadcastOver(sendBus)
    const receiver = createKeyBroadcastOver(recvBus)
    const received: KeyChange[] = []
    receiver.subscribe(c => received.push(c))

    sender.post({ userId: 'u', workspaceId: 'w', kind: 'added' })

    expect(received).toEqual([{ userId: 'u', workspaceId: 'w', kind: 'added' }])
  })

  it('does not echo a change back to the posting tab', () => {
    const [sendBus, recvBus] = connectedPair()
    const sender = createKeyBroadcastOver(sendBus)
    createKeyBroadcastOver(recvBus)
    const echoed: KeyChange[] = []
    sender.subscribe(c => echoed.push(c))

    sender.post({ userId: 'u', workspaceId: 'w', kind: 'added' })

    expect(echoed).toEqual([])
  })

  it('unsubscribe stops further delivery', () => {
    const [sendBus, recvBus] = connectedPair()
    const sender = createKeyBroadcastOver(sendBus)
    const receiver = createKeyBroadcastOver(recvBus)
    let count = 0
    const unsub = receiver.subscribe(() => { count++ })
    unsub()

    sender.post({ userId: 'u', workspaceId: 'w', kind: 'removed' })

    expect(count).toBe(0)
  })

  it('ignores malformed messages off the bus', () => {
    const hub = new Set<FakeBus>()
    const evil = new FakeBus(hub)
    const recvBus = new FakeBus(hub)
    const receiver = createKeyBroadcastOver(recvBus)
    const received: KeyChange[] = []
    receiver.subscribe(c => received.push(c))

    evil.postMessage({ not: 'a key change' })
    evil.postMessage(null)
    evil.postMessage({ userId: 'u', workspaceId: 'w', kind: 'bogus' })

    expect(received).toEqual([])
  })
})
