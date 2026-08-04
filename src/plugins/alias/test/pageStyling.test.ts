import { describe, expect, it } from 'vitest'
import type { BlockResolveContext } from '@/extensions/blockInteraction'
import { aliasPageStyling } from '../pageStyling.ts'

// Only the fields the contribution reads; the facet hands it a full context.
const ctx = (over: Partial<BlockResolveContext>): BlockResolveContext =>
  ({aliases: [], isTopLevel: false, ...over}) as BlockResolveContext

describe('aliasPageStyling', () => {
  it('gives the open page the title treatment', () => {
    expect(aliasPageStyling(ctx({aliases: ['Inbox'], isTopLevel: true})))
      .toEqual({className: 'page-title-content'})
  })

  it('marks a page seen anywhere else without resizing it', () => {
    // The outline case: one row among siblings. A size change here would break
    // the vertical rhythm that makes the hierarchy scannable, so the marker is
    // weight-only — a different class, not the title one.
    expect(aliasPageStyling(ctx({aliases: ['Inbox']})))
      .toEqual({className: 'page-name-content'})
  })

  it('contributes nothing for a block that is not a page', () => {
    // Returning null (rather than an empty className) is what keeps the merged
    // class string identical to the pre-plugin one for ordinary blocks.
    expect(aliasPageStyling(ctx({isTopLevel: true}))).toBeNull()
    expect(aliasPageStyling(ctx({}))).toBeNull()
  })

  it('treats a focal render inside a nested surface as not-the-open-page', () => {
    // An embed or backlink entry of the page is `isTopLevel` by id but is not
    // the page being viewed — it should read as a page reference in a list,
    // not sprout a second page title mid-outline.
    expect(aliasPageStyling(ctx({
      aliases: ['Inbox'],
      isTopLevel: true,
      blockContext: {isNestedSurface: true} as BlockResolveContext['blockContext'],
    }))).toEqual({className: 'page-name-content'})
  })
})
