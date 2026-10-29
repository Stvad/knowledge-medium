// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest'
import type {BlockResolveContext} from '@/extensions/blockInteraction.js'
import {THREAD_TYPE} from './schema'
import {
  COMMENT_CARD_KEY,
  commentActionsContribution,
  commentContextMenuItem,
  commentPillContribution,
  commentsFooterContribution,
} from './ui'

/** The contributions decide from the resolve context alone, so a context with
 *  just the fields they read is enough. */
const ctx = (fields: {types?: string[]; isTopLevel?: boolean; blockContext?: Record<string, unknown>}) =>
  ({types: fields.types ?? [], isTopLevel: fields.isTopLevel ?? false, blockContext: fields.blockContext} as unknown as BlockResolveContext)

describe('where the comments UI attaches', () => {
  it('puts the pill and the inline threads on outline blocks, the focal one included, but not on nested surfaces', () => {
    expect(commentPillContribution(ctx({}))).toBeTruthy()
    expect(commentsFooterContribution(ctx({}))).toBeTruthy()
    // Unlike the reference pill: nothing else shows a focal block's comments.
    expect(commentPillContribution(ctx({isTopLevel: true}))).toBeTruthy()
    expect(commentsFooterContribution(ctx({isTopLevel: true}))).toBeTruthy()
    expect(commentContextMenuItem(ctx({blockContext: {isNestedSurface: true}}))).toBeNull()
    expect(commentPillContribution(ctx({blockContext: {isNestedSurface: true}}))).toBeNull()
    expect(commentsFooterContribution(ctx({blockContext: {isNestedSurface: true}}))).toBeNull()
  })

  it('gives Reply and Delete to comments inside a card, not to the root or to blocks outside one', () => {
    const card = {[COMMENT_CARD_KEY]: 'T', scopeRootId: 'T', isNestedSurface: true}
    expect(commentActionsContribution(ctx({blockContext: card}))).toBeTruthy()
    expect(commentActionsContribution(ctx({types: [THREAD_TYPE], blockContext: card}))).toBeNull()
    expect(commentActionsContribution(ctx({}))).toBeNull()
  })

  it('stops at a nested surface inside a card, such as a note embedded in a comment', () => {
    // The embed inherits the card's keys but resets the scope root.
    const embedInCard = {[COMMENT_CARD_KEY]: 'T', scopeRootId: 'X', isNestedSurface: true, isEmbedded: true}
    expect(commentActionsContribution(ctx({blockContext: embedInCard}))).toBeNull()
  })

})
