// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BlockResolveContext } from '@/extensions/blockInteraction'
import { DAILY_NOTE_TYPE } from '@/plugins/daily-notes/schema'
import { TutorialBanner, tutorialBannerHeader } from '../TutorialBanner.tsx'
import { INSERT_TUTORIAL_ACTION_ID } from '../action.ts'

const mocks = vi.hoisted(() => ({runActionById: vi.fn()}))

vi.mock('@/shortcuts/runAction.js', () => ({
  runActionById: (...args: unknown[]) => mocks.runActionById(...args),
}))

// Only the fields the header predicate reads; the facet hands it a full
// BlockResolveContext.
const ctx = (over: Partial<BlockResolveContext>): BlockResolveContext =>
  ({isTopLevel: false, types: [], ...over}) as BlockResolveContext

describe('tutorial banner placement', () => {
  it('shows above the focal daily note', () => {
    expect(tutorialBannerHeader(ctx({isTopLevel: true, types: [DAILY_NOTE_TYPE]})))
      .toBe(TutorialBanner)
  })

  it('stays off ordinary pages', () => {
    expect(tutorialBannerHeader(ctx({isTopLevel: true, types: ['page']}))).toBeNull()
  })

  it('stays off a daily note embedded in another surface', () => {
    // An embed / backlink entry of today's note is still `isTopLevel` by id;
    // a second banner there would read as a duplicate of the real one.
    expect(tutorialBannerHeader(ctx({
      isTopLevel: true,
      types: [DAILY_NOTE_TYPE],
      blockContext: {isNestedSurface: true} as BlockResolveContext['blockContext'],
    }))).toBeNull()
  })

  it('stays off a daily note that is not the focal block', () => {
    expect(tutorialBannerHeader(ctx({types: [DAILY_NOTE_TYPE]}))).toBeNull()
  })
})

describe('TutorialBanner', () => {
  beforeEach(() => {
    mocks.runActionById = vi.fn()
    window.localStorage.clear()
  })
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
  })

  it('opens the tutorial through the existing action', () => {
    render(<TutorialBanner/>)

    fireEvent.click(screen.getByRole('button', {name: 'Open tutorial'}))

    expect(mocks.runActionById)
      .toHaveBeenCalledWith(INSERT_TUTORIAL_ACTION_ID, expect.anything())
  })

  it('retires itself once opened, so it never becomes permanent chrome', () => {
    const view = render(<TutorialBanner/>)

    fireEvent.click(screen.getByRole('button', {name: 'Open tutorial'}))
    expect(screen.queryByText(/Start with the tutorial/)).not.toBeInTheDocument()

    // …and stays gone on the next session, not just this mount.
    view.unmount()
    render(<TutorialBanner/>)
    expect(screen.queryByText(/Start with the tutorial/)).not.toBeInTheDocument()
  })

  it('can be dismissed without opening the tutorial', () => {
    const view = render(<TutorialBanner/>)

    fireEvent.click(screen.getByRole('button', {name: 'Dismiss tutorial prompt'}))

    expect(mocks.runActionById).not.toHaveBeenCalled()
    view.unmount()
    render(<TutorialBanner/>)
    expect(screen.queryByText(/Start with the tutorial/)).not.toBeInTheDocument()
  })
})
