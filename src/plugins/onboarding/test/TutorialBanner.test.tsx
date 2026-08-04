// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BlockResolveContext } from '@/extensions/blockInteraction'
import { DAILY_NOTE_TYPE } from '@/plugins/daily-notes/schema'
import { TutorialBanner, tutorialBannerHeader } from '../TutorialBanner.tsx'
import { isTutorialBannerDismissed, resetTutorialBannerDismissal } from '../bannerDismissal.ts'

const mocks = vi.hoisted(() => ({
  openTutorial: vi.fn(),
  /** Whether the tutorial actually opened — drives persist-only-on-success. */
  opens: true,
  /** When true, run the REAL helper instead of the stub, so the failure test
   *  exercises the actual "no active workspace" path rather than asserting on
   *  a boolean it invented. */
  useReal: false,
  /** Stands in for the active workspace; null is the real failure input. */
  activeWorkspaceId: 'ws-1' as string | null,
  /** What `navigateFromGlobalCommand` resolves. `null` is its documented
   *  "suppressed / vetoed gesture" result — it never rejects. */
  navigates: {ok: true} as unknown,
}))

vi.mock('@/context/repo.js', () => ({
  useRepo: () => ({
    activeWorkspaceId: mocks.activeWorkspaceId,
    // Lets the real `insertTutorialIntoWorkspace` take its already-present
    // branch, so these tests reach the navigation step without seeding.
    query: {aliasLookup: () => ({load: async () => ({id: 'tutorial-1'})})},
  }),
}))

vi.mock('@/utils/navigation.js', () => ({
  activeWorkspaceIdPreferringHash: (repo: {activeWorkspaceId: string | null}) =>
    repo.activeWorkspaceId,
  navigateFromGlobalCommand: async () => mocks.navigates,
}))

// Toasts are the helper's failure reporting; stub them so the real path can
// run headless.
vi.mock('@/utils/toast.js', () => ({
  showProgress: () => ({done: vi.fn(), fail: vi.fn()}),
}))

vi.mock('../action.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../action.ts')>()
  return {
    ...actual,
    openTutorialInActiveWorkspace: (repo: unknown) => {
      mocks.openTutorial(repo)
      return mocks.useReal
        ? actual.openTutorialInActiveWorkspace(repo as never)
        : Promise.resolve(mocks.opens)
    },
  }
})

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
    mocks.openTutorial = vi.fn()
    mocks.opens = true
    mocks.useReal = false
    mocks.activeWorkspaceId = 'ws-1'
    mocks.navigates = {ok: true}
    window.location.hash = ''
    resetTutorialBannerDismissal()
    window.localStorage.clear()
  })
  afterEach(() => {
    cleanup()
    resetTutorialBannerDismissal()
    window.localStorage.clear()
  })

  it('opens the tutorial through the shared onboarding entry point', () => {
    render(<TutorialBanner/>)

    fireEvent.click(screen.getByRole('button', {name: 'Open tutorial'}))

    expect(mocks.openTutorial).toHaveBeenCalledTimes(1)
  })

  it('retires itself once opened, so it never becomes permanent chrome', async () => {
    const view = render(<TutorialBanner/>)

    fireEvent.click(screen.getByRole('button', {name: 'Open tutorial'}))
    expect(screen.queryByText(/Start with the tutorial/)).not.toBeInTheDocument()

    // …and stays gone on the next session, not just this mount. Persistence
    // is deferred until the dispatch reports success, so wait for the flag
    // rather than the DOM (already updated by the in-memory hide above).
    await vi.waitFor(() => expect(isTutorialBannerDismissed()).toBe(true))
    view.unmount()
    render(<TutorialBanner/>)
    expect(screen.queryByText(/Start with the tutorial/)).not.toBeInTheDocument()
  })

  it('comes back when no tutorial actually opened, keeping the only retry route', async () => {
    // Drives the REAL helper against the real failure input — no active
    // workspace — rather than a hand-fed boolean. This is the case the action
    // system cannot report: its handler shows a toast and returns normally, so
    // a dispatch "succeeds" while nothing opened. Persisting on that would
    // retire the banner permanently on a failure the user can see but no
    // longer act on from here.
    mocks.useReal = true
    mocks.activeWorkspaceId = null
    const view = render(<TutorialBanner/>)

    fireEvent.click(screen.getByRole('button', {name: 'Open tutorial'}))

    // Restored in place…
    expect(await screen.findByText(/Start with the tutorial/)).toBeInTheDocument()
    // …and nothing was persisted, so a later session still offers it.
    expect(isTutorialBannerDismissed()).toBe(false)
    view.unmount()
    render(<TutorialBanner/>)
    expect(screen.getByText(/Start with the tutorial/)).toBeInTheDocument()
  })

  it('comes back when navigation is vetoed after a successful seed', async () => {
    // The seed succeeds, so the earlier no-workspace branch is never reached —
    // this is the *other* way to end up not on the tutorial.
    // `navigateFromGlobalCommand` resolves `null` for a suppressed/vetoed
    // gesture and never rejects, so nothing throws and the seed toast even
    // says "Tutorial inserted"; only the null result distinguishes it.
    mocks.useReal = true
    mocks.navigates = null
    const view = render(<TutorialBanner/>)

    fireEvent.click(screen.getByRole('button', {name: 'Open tutorial'}))

    expect(await screen.findByText(/Start with the tutorial/)).toBeInTheDocument()
    expect(isTutorialBannerDismissed()).toBe(false)
    view.unmount()
    render(<TutorialBanner/>)
    expect(screen.getByText(/Start with the tutorial/)).toBeInTheDocument()
  })

  it('retires itself when navigation actually lands', async () => {
    mocks.useReal = true
    mocks.navigates = {ok: true}
    render(<TutorialBanner/>)

    fireEvent.click(screen.getByRole('button', {name: 'Open tutorial'}))

    await vi.waitFor(() => expect(isTutorialBannerDismissed()).toBe(true))
  })

  it('retires every mounted banner at once, not just the one clicked', async () => {
    // Two focal daily-note panels can each mount this. Dismissal used to be
    // per-mount `useState`, so the other panel kept its banner and could be
    // dismissed again — the flag and localStorage notify nobody.
    render(<><TutorialBanner/><TutorialBanner/></>)
    expect(screen.getAllByText(/Start with the tutorial/)).toHaveLength(2)

    fireEvent.click(screen.getAllByRole('button', {name: 'Dismiss tutorial prompt'})[0])

    await vi.waitFor(() =>
      expect(screen.queryByText(/Start with the tutorial/)).not.toBeInTheDocument())
  })

  it('can be dismissed without opening the tutorial', () => {
    const view = render(<TutorialBanner/>)

    fireEvent.click(screen.getByRole('button', {name: 'Dismiss tutorial prompt'}))

    expect(mocks.openTutorial).not.toHaveBeenCalled()
    view.unmount()
    render(<TutorialBanner/>)
    expect(screen.queryByText(/Start with the tutorial/)).not.toBeInTheDocument()
  })
})
