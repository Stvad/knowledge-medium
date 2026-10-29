// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest'
import type {BlockResolveContext} from '@/extensions/blockInteraction.js'
import {THREAD_TYPE} from './schema'
import {
  COMMENT_CARD_KEY,
  commentActionsContribution,
  commentPillContribution,
  commentsFooterContribution,
  threadRootContentContribution,
} from './ui'

/** The contributions decide from the resolve context alone, so a context with
 *  just the fields they read is enough. */
const ctx = (fields: {types?: string[]; blockContext?: Record<string, unknown>}) =>
  ({types: fields.types ?? [], blockContext: fields.blockContext} as unknown as BlockResolveContext)

describe('where the comments UI attaches', () => {
  it('puts the pill and the inline threads on outline blocks, the focal one included, but not on nested surfaces', () => {
    expect(commentPillContribution(ctx({}))).toBeTruthy()
    expect(commentsFooterContribution(ctx({}))).toBeTruthy()
    expect(commentPillContribution(ctx({blockContext: {isNestedSurface: true}}))).toBeNull()
    expect(commentsFooterContribution(ctx({blockContext: {isNestedSurface: true}}))).toBeNull()
  })

  it('gives Reply and Delete to comments inside a card, not to the root or to blocks outside one', () => {
    expect(commentActionsContribution(ctx({blockContext: {[COMMENT_CARD_KEY]: true}}))).toBeTruthy()
    expect(commentActionsContribution(ctx({types: [THREAD_TYPE], blockContext: {[COMMENT_CARD_KEY]: true}}))).toBeNull()
    expect(commentActionsContribution(ctx({}))).toBeNull()
  })

  it('renders only thread roots with the display-only root renderer', () => {
    expect(threadRootContentContribution(ctx({types: [THREAD_TYPE]}))).toMatchObject({id: 'annotations.thread-root'})
    expect(threadRootContentContribution(ctx({types: ['page']}))).toBeNull()
  })
})
