import {describe, expect, it} from 'vitest'
import {createDeliveryDedup} from '../src/deliveryDedup'

describe('delivery dedup', () => {
  it('claims an id once, so a retry during a slow dispatch is recognised', () => {
    const dedup = createDeliveryDedup()
    expect(dedup.claim('e-1')).toBe('dispatch')
    expect(dedup.claim('e-1')).not.toBe('dispatch')
  })

  it('separates "the session has it" from "someone tried"', () => {
    // The distinction is the whole point. A sender told `duplicate` treats
    // its delivery as done — a query sender then advances its cursor past
    // rows nothing ever ran, with no block left for a sweep to find.
    const dedup = createDeliveryDedup()
    dedup.claim('e-1')
    expect(dedup.claim('e-1')).toBe('unconfirmed')   // still in flight
    dedup.confirm('e-1')
    expect(dedup.claim('e-1')).toBe('delivered')     // now it is a true duplicate
  })

  it('lets a retry through once a failed dispatch releases its claim', () => {
    const dedup = createDeliveryDedup()
    dedup.claim('e-1')
    dedup.release('e-1')
    expect(dedup.claim('e-1')).toBe('dispatch')
  })

  it('lets an unidentified event through rather than collapsing them all', () => {
    const dedup = createDeliveryDedup()
    expect(dedup.claim(undefined)).toBe('dispatch')
    expect(dedup.claim(undefined)).toBe('dispatch')
  })

  it('restarts a delivery\'s window when it is CONFIRMED, not when claimed', () => {
    // `Map.set` on an existing key leaves the key where it was, so a claim
    // that stayed pending while the window filled would be evicted right
    // after confirming — and its retry, if the ack was lost, runs the work
    // again.
    const dedup = createDeliveryDedup(3)
    dedup.claim('slow')                 // claimed first, confirmed last
    dedup.claim('a'); dedup.claim('b')
    dedup.confirm('slow')               // must move to the newest position
    dedup.claim('c')                    // evicts the oldest, which is now 'a'
    expect(dedup.claim('slow')).toBe('delivered')
  })

  it('bounds what it remembers, oldest first', () => {
    const dedup = createDeliveryDedup(2)
    dedup.claim('a')
    dedup.claim('b')
    dedup.claim('c')            // evicts 'a'
    expect(dedup.size).toBe(2)
    expect(dedup.claim('a')).toBe('dispatch')       // forgotten, claimable again
    expect(dedup.claim('c')).not.toBe('dispatch')   // still remembered
  })
})
