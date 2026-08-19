import { describe, expect, it } from 'vitest'
import type { BlockBulletClassContext, BlockTextClassContext } from '@/extensions/blockInteraction'
import { aliasPageBullet, aliasPageStyling } from '../pageStyling.ts'

const ctx = (over: Partial<BlockTextClassContext>): BlockTextClassContext =>
  ({aliases: [], isFocal: false, ...over}) as BlockTextClassContext

const bulletCtx = (aliases: readonly string[]): BlockBulletClassContext =>
  ({aliases}) as BlockBulletClassContext

describe('aliasPageStyling', () => {
  it('leaves the open page\'s title alone', () => {
    // The title is not where page-ness is ambiguous (breadcrumb + panel chrome
    // already answer it), and every decoration available there — a rule, a size
    // step — either collides with the link/reference vocabulary or gets its
    // geometry from the type-chips layout. See the module comment.
    expect(aliasPageStyling(ctx({aliases: ['Inbox'], isFocal: true}))).toBeNull()
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

describe('aliasPageBullet', () => {
  it('rings the bullet of a block that carries a page name', () => {
    expect(aliasPageBullet(bulletCtx(['Inbox']))).toBe('page-bullet')
  })

  it('contributes nothing for an ordinary block', () => {
    expect(aliasPageBullet(bulletCtx([]))).toBeNull()
  })
})
