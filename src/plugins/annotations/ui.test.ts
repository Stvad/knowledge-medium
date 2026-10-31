// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest'
import type {BlockResolveContext} from '@/extensions/blockInteraction.js'
import {quotedInFooterContribution} from './quotedIn'
import {nestedReadSelectionMenuContribution} from './readSelectionUi'
import {THREAD_TYPE} from './schema'
import type {ThreadSummary} from './summaries'
import {
  COMMENT_CARD_KEY,
  commentActionsContribution,
  commentContextMenuItem,
  commentPillContribution,
  commentsFooterContribution,
  inCard,
  pillClick,
  threadsUnderComment,
} from './ui'

const thread = (id: string, open = true): ThreadSummary =>
  ({id, open, anchor: {kind: 'block'}, commentCount: 1, quoterCount: 0, createdAt: 0})

/** The contributions decide from the resolve context alone, so a context with
 *  just the fields they read is enough. */
const ctx = (fields: {types?: string[]; isTopLevel?: boolean; blockContext?: Record<string, unknown>}) =>
  ({types: fields.types ?? [], isTopLevel: fields.isTopLevel ?? false, blockContext: fields.blockContext} as unknown as BlockResolveContext)

describe('where the comments UI attaches', () => {
  it('adds a separate selection menu only to full nested block surfaces', () => {
    expect(nestedReadSelectionMenuContribution(ctx({}))).toBeNull()
    expect(nestedReadSelectionMenuContribution(ctx({blockContext: {}}))).toBeNull()
    for (const surface of [{isEmbedded: true}, {isBacklink: true}, {[COMMENT_CARD_KEY]: 'card:T'}]) {
      expect(nestedReadSelectionMenuContribution(ctx({blockContext: {isNestedSurface: true, ...surface}}))).toBeTruthy()
    }
    expect(nestedReadSelectionMenuContribution(ctx({blockContext: {isNestedSurface: true, isReference: true}}))).toBeNull()
    expect(nestedReadSelectionMenuContribution(ctx({blockContext: {isNestedSurface: true, isBacklink: true, isBreadcrumb: true}}))).toBeNull()
  })

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
    const card = {[COMMENT_CARD_KEY]: 'card:T', renderScopeId: 'card:T', scopeRootId: 'T', isNestedSurface: true}
    expect(commentActionsContribution(ctx({blockContext: card}))).toBeTruthy()
    expect(commentActionsContribution(ctx({types: [THREAD_TYPE], blockContext: card}))).toBeNull()
    expect(commentActionsContribution(ctx({}))).toBeNull()
  })

  it('stops at a nested surface inside a card, such as a note embedded in a comment', () => {
    // The embed inherits the card's keys but sets a render scope of its own.
    const embedInCard = {[COMMENT_CARD_KEY]: 'card:T', renderScopeId: 'embed:X', scopeRootId: 'X', isNestedSurface: true, isEmbedded: true}
    expect(commentActionsContribution(ctx({blockContext: embedInCard}))).toBeNull()
  })

  it('stops at a surface nested in the card that shows the card’s own thread again', () => {
    const root = {[COMMENT_CARD_KEY]: 'card:T', renderScopeId: 'card:T', scopeRootId: 'T'}
    expect(quotedInFooterContribution(ctx({types: [THREAD_TYPE], blockContext: root}))).toBeTruthy()
    // A comment embedding its thread, or a quoter listed under "Quoted in".
    expect(inCard({...root, renderScopeId: 'embed:T', isNestedSurface: true, isEmbedded: true})).toBe(false)
    // A quoter that is a comment of the thread, with its breadcrumb promoted
    // to the root inside its backlink entry.
    expect(inCard({...root, renderScopeId: 'backlink:X', isNestedSurface: true, isBacklink: true})).toBe(false)
    // That entry's breadcrumb, which keeps the card's scope.
    expect(inCard({...root, isBreadcrumb: true})).toBe(false)
  })

  it('shows a comment\u2019s open threads under it, but never a thread whose card already encloses it', () => {
    const onComment = [thread('T'), thread('U'), thread('V', false)]
    // A thread anchored to a comment of itself would otherwise render itself
    // inside its own card, forever.
    expect(threadsUnderComment(onComment, ['T']).map(t => t.id)).toEqual(['U'])
  })

  it('pins a card from the pill when the margin is drawn, revealing closed threads when they are all there is', () => {
    expect(pillClick([thread('R', false), thread('O')], true)).toEqual({kind: 'activate', threadId: 'O', revealClosed: false})
    expect(pillClick([thread('R', false)], true)).toEqual({kind: 'activate', threadId: 'R', revealClosed: true})
    expect(pillClick([thread('O')], false)).toEqual({kind: 'expand-inline'})
  })
})
