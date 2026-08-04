import { describe, expect, it } from 'vitest'
import type { BlockTextClassContext } from '@/extensions/blockInteraction'
import { aliasPageStyling } from '../pageStyling.ts'

const ctx = (over: Partial<BlockTextClassContext>): BlockTextClassContext =>
  ({aliases: [], isFocal: false, ...over}) as BlockTextClassContext

describe('aliasPageStyling', () => {
  it('gives the open page the title treatment', () => {
    expect(aliasPageStyling(ctx({aliases: ['Inbox'], isFocal: true})))
      .toBe('page-title-text')
  })

  it('marks a page seen anywhere else without resizing it', () => {
    // The outline case: one row among siblings. A size change here would break
    // the vertical rhythm that makes the hierarchy scannable, so the marker is
    // weight-only — a different class, not the title one.
    expect(aliasPageStyling(ctx({aliases: ['Inbox']}))).toBe('page-name-text')
  })

  it('contributes nothing for a block that is not a page', () => {
    // Returning null (rather than an empty className) is what keeps the merged
    // class string identical to the pre-plugin one for ordinary blocks.
    expect(aliasPageStyling(ctx({isFocal: true}))).toBeNull()
    expect(aliasPageStyling(ctx({}))).toBeNull()
  })

  it('treats a non-focal render as not-the-open-page', () => {
    // `isFocal` already folds in the nested-surface rule (useIsFocalRender), so
    // an embed or backlink entry of the page arrives here as isFocal:false and
    // reads as a page reference rather than sprouting a title mid-outline.
    expect(aliasPageStyling(ctx({aliases: ['Inbox'], isFocal: false})))
      .toBe('page-name-text')
  })
})
