// @vitest-environment happy-dom
/**
 * ClientContext layout-context claim registry — the localStorage-backed
 * persistence half, which the node-env clientContext.test.ts can't reach.
 * Multiple ClientContext instances in one test stand in for multiple TABS
 * (each tab constructs its own instance over the same localStorage).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { ClientContext } from '@/data/clientContext'

const tab = (name: string) => new ClientContext({user: {id: 'user-1', name}})

beforeEach(() => {
  localStorage.clear()
})

describe('ClientContext layout-context claims (persistence)', () => {
  it('persists claims across constructions (the bootstrap-sees-earlier-boots contract)', () => {
    tab('first-boot').claimLayoutContextKey('ws-1', 'persp')
    expect(tab('next-boot').hasClaimedLayoutContextKey('ws-1', 'persp')).toBe(true)
  })

  it('merges concurrent tabs\' writes instead of last-writer-wins', () => {
    // Both tabs snapshot the (empty) map at construction; each then claims
    // for a different workspace. A whole-map overwrite from either
    // snapshot would drop the other's claim.
    const tabA = tab('a')
    const tabB = tab('b')
    tabA.claimLayoutContextKey('ws-a', 'persp')
    tabB.claimLayoutContextKey('ws-b', 'persp')

    const reboot = tab('reboot')
    expect(reboot.hasClaimedLayoutContextKey('ws-a', 'persp')).toBe(true)
    expect(reboot.hasClaimedLayoutContextKey('ws-b', 'persp')).toBe(true)
  })

  it('release persists and merges the same way', () => {
    const tabA = tab('a')
    tabA.claimLayoutContextKey('ws-a', 'persp')
    tabA.claimLayoutContextKey('ws-a', 'other')
    const tabB = tab('b')
    tabB.claimLayoutContextKey('ws-b', 'persp')
    tabA.releaseLayoutContextKey('ws-a', 'persp')

    const reboot = tab('reboot')
    expect(reboot.hasClaimedLayoutContextKey('ws-a', 'persp')).toBe(false)
    expect(reboot.hasClaimedLayoutContextKey('ws-a', 'other')).toBe(true)
    expect(reboot.hasClaimedLayoutContextKey('ws-b', 'persp')).toBe(true)
  })

  it('a write also absorbs other tabs\' claims into the writer\'s own view', () => {
    const tabA = tab('a')
    const tabB = tab('b')
    tabA.claimLayoutContextKey('ws-a', 'persp')
    tabB.claimLayoutContextKey('ws-b', 'persp')
    // tabB's merge-on-write re-read picked up tabA's claim.
    expect(tabB.hasClaimedLayoutContextKey('ws-a', 'persp')).toBe(true)
  })

  it('a NO-OP re-claim still absorbs the persisted state (the claim postcondition)', () => {
    // Both tabs exist before any claim; A claims first, then B claims the
    // SAME (scope, key) — a no-delta write against the persisted map. B's
    // in-memory view must still learn the key, or hasClaimed lies right
    // after B itself claimed and B's base session applies lane routes.
    const tabA = tab('a')
    const tabB = tab('b')
    tabA.claimLayoutContextKey('ws-1', 'persp')
    tabB.claimLayoutContextKey('ws-1', 'persp')
    expect(tabB.hasClaimedLayoutContextKey('ws-1', 'persp')).toBe(true)
  })

  it('a NO-OP release still absorbs the persisted state', () => {
    const tabA = tab('a')
    tabA.claimLayoutContextKey('ws-1', 'persp')
    const tabB = tab('b') // sees the claim from construction
    tabA.releaseLayoutContextKey('ws-1', 'persp')
    tabB.releaseLayoutContextKey('ws-1', 'persp') // no-delta vs persisted
    expect(tabB.hasClaimedLayoutContextKey('ws-1', 'persp')).toBe(false)
  })
})
