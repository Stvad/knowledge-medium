import {describe, expect, it} from 'vitest'
import type {BlockResolveContext} from '@/extensions/blockInteraction.js'
import {
  CONTRIBUTOR_CARD_MODE_KEY,
  contributorBadgeItemContribution,
  contributorCardDecoratorContribution,
} from '../ContributorBadges'

const ctx = (blockId: string, blockContext?: Record<string, unknown>) =>
  ({block: {id: blockId}, blockContext} as unknown as BlockResolveContext)

describe('contributor card mode', () => {
  const card = {[CONTRIBUTOR_CARD_MODE_KEY]: 'T', scopeRootId: 'T'}

  it('shows author lines for the blocks under the card root, in place of the badge', () => {
    expect(contributorCardDecoratorContribution(ctx('C', card))).toBeTruthy()
    expect(contributorBadgeItemContribution(ctx('C', card))).toBeNull()
  })

  it('leaves the card root, its header, with the plain badge', () => {
    expect(contributorCardDecoratorContribution(ctx('T', card))).toBeNull()
    expect(contributorBadgeItemContribution(ctx('T', card))).toBeTruthy()
  })

  it('stops at a nested surface inside the card', () => {
    const nested = ctx('X', {...card, scopeRootId: 'X'})
    expect(contributorCardDecoratorContribution(nested)).toBeNull()
    expect(contributorBadgeItemContribution(nested)).toBeTruthy()
  })

  it('outside card mode only the badge attaches', () => {
    expect(contributorCardDecoratorContribution(ctx('C'))).toBeNull()
    expect(contributorBadgeItemContribution(ctx('C'))).toBeTruthy()
  })
})
