import {describe, expect, it} from 'vitest'
import {createDeliveryDedup} from '../src/deliveryDedup'

describe('delivery dedup', () => {
  it('claims an id once, so a retry during a slow dispatch is recognised', () => {
    const dedup = createDeliveryDedup()
    // The claim is the point: it happens before the caller awaits delivery,
    // so an id is spoken for while the first dispatch is still in flight.
    expect(dedup.claim('e-1')).toBe(true)
    expect(dedup.claim('e-1')).toBe(false)
  })

  it('lets an unidentified event through rather than collapsing them all', () => {
    const dedup = createDeliveryDedup()
    expect(dedup.claim(undefined)).toBe(true)
    expect(dedup.claim(undefined)).toBe(true)
  })

  it('bounds what it remembers, oldest first', () => {
    const dedup = createDeliveryDedup(2)
    dedup.claim('a')
    dedup.claim('b')
    dedup.claim('c')            // evicts 'a'
    expect(dedup.size).toBe(2)
    expect(dedup.claim('a')).toBe(true)   // forgotten, so claimable again
    expect(dedup.claim('c')).toBe(false)  // still remembered
  })
})
