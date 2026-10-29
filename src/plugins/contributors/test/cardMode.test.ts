// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest'
import type {BlockResolveContext} from '@/extensions/blockInteraction.js'
import {CONTRIBUTOR_CARD_MODE_KEY, contributorBadgesDecoratorContribution} from '../ContributorBadges'

const ctx = (blockId: string, blockContext?: Record<string, unknown>) =>
  ({block: {id: blockId}, blockContext} as unknown as BlockResolveContext)

describe('contributor card mode', () => {
  const plain = contributorBadgesDecoratorContribution(ctx('C'))
  const card = {[CONTRIBUTOR_CARD_MODE_KEY]: 'T', scopeRootId: 'T'}

  it('shows author lines for the blocks under the card root', () => {
    expect(contributorBadgesDecoratorContribution(ctx('C', card))).not.toBe(plain)
  })

  it('leaves the card root, its header, with the plain badges', () => {
    expect(contributorBadgesDecoratorContribution(ctx('T', card))).toBe(plain)
  })

  it('stops at a nested surface inside the card', () => {
    expect(contributorBadgesDecoratorContribution(ctx('X', {...card, scopeRootId: 'X'}))).toBe(plain)
  })
})
