// @vitest-environment happy-dom
/**
 * The surface a definition change puts up while it holds the writer.
 *
 * Driven through the STORE rather than by calling the component with props:
 * the mount reads a module store keyed by the active workspace, and the two
 * ways this fails in production are both about that wiring — a run opened for
 * one workspace showing over another, and a run that ends leaving the modal
 * behind.
 */
import { Suspense, type ReactNode } from 'react'
import { vi } from 'vitest'

// The shortcut funnel injects a UI-state block into every activation, so even
// a dependency-free one reaches `useUser`. Mocked rather than provided: the
// subject here is the modal, not who is signed in.
vi.mock('@/components/Login.tsx', () => ({useUser: () => ({id: 'user-1'})}))

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { RepoContext } from '@/context/repo.js'
import { ActiveContextsProvider, useActiveContextsState } from '@/shortcuts/ActiveContexts'
import { ActionContextTypes } from '@/shortcuts/types'
import { defaultActionContextConfigs } from '@/shortcuts/defaultContexts'
import { actionContextsFacet } from '@/extensions/core'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import {
  beginPropertyDefinitionFanout,
  reportPropertyDefinitionFanout,
  __resetPropertyDefinitionFanoutForTests,
  type PropertyDefinitionFanoutRun,
} from '@/data/propertyDefinitionFanout'
import { DefinitionFanoutProgress } from '../definitionFanoutAppMount.tsx'

const WS = 'ws-fanout-surface'

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}}).repo
  repo.setActiveWorkspaceId(WS)
})

afterEach(() => {
  cleanup()
  __resetPropertyDefinitionFanoutForTests()
})

/** Reads whether the surface underneath is shadowed — what stops a bare Enter
 *  reaching the editor behind a modal. */
const Shadowing = (): ReactNode => {
  const active = useActiveContextsState()
  return <div data-testid="shadowing">{String(active.has(ActionContextTypes.DIALOG))}</div>
}

/** The providers this sits inside in production — it is an app mount, so the
 *  shortcut runtime is always above it. Rendered bare, the modal could lose
 *  its keyboard shadowing with no test noticing. */
const renderMount = (): void => {
  const runtime = resolveFacetRuntimeSync(
    defaultActionContextConfigs.map(context => actionContextsFacet.of(context)),
  )
  render(
    <RepoContext.Provider value={repo}>
      <AppRuntimeContextProvider value={runtime}>
        <ActiveContextsProvider>
          <Suspense fallback={null}>
            <DefinitionFanoutProgress />
            <Shadowing />
          </Suspense>
        </ActiveContextsProvider>
      </AppRuntimeContextProvider>
    </RepoContext.Provider>,
  )
}

/** ASYNC act: mounting the dialog suspends on the shortcut funnel's UI-state
 *  read, and the resolution needs a flush the synchronous form does not give. */
const openRun = async (
  workspaceId = WS, total = 4_000,
): Promise<PropertyDefinitionFanoutRun> => {
  let run!: PropertyDefinitionFanoutRun
  await act(async () => {
    run = beginPropertyDefinitionFanout(workspaceId, 'status', total)
  })
  return run
}

const report = (done: number, total = 4_000, workspaceId = WS): void => {
  act(() => { reportPropertyDefinitionFanout(workspaceId, done, total) })
}

const bar = () => screen.getByRole('progressbar')

describe('the fan-out progress surface', () => {
  it('shows nothing while no change is running', () => {
    renderMount()

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByTestId('shadowing').textContent).toBe('false')
  })

  it('comes up on the run, follows it, and goes away with it', async () => {
    renderMount()
    const run = await openRun()

    // BEFORE any report: the transaction has not reached the consumers, and
    // the bar says so rather than sitting at a number it does not have.
    expect(await screen.findByText(/Updating blocks that use “status”/)).toBeTruthy()
    expect(screen.getByText('Starting…')).toBeTruthy()
    expect(bar().getAttribute('aria-valuenow')).toBeNull()
    await waitFor(() => {
      expect(screen.getByTestId('shadowing').textContent).toBe('true')
    })

    report(1_000)
    expect(screen.getByText('1,000 of 4,000 blocks updated')).toBeTruthy()
    expect(bar().getAttribute('aria-valuenow')).toBe('1000')

    // The last consumer is NOT the end of the wait — the commit and the
    // post-commit walk are still to come — so the surface stays up and stops
    // counting rather than reading as finished.
    report(4_000)
    expect(screen.getByText('Saving the change…')).toBeTruthy()

    act(() => { run.end() })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(screen.getByTestId('shadowing').textContent).toBe('false')
  })

  it('stays out of a workspace the change is not happening in', async () => {
    renderMount()
    // PRIMED FIRST, and that is the whole test: the dialog's first mount
    // suspends on the shortcut funnel, so an absence asserted before anything
    // has ever rendered here passes with the workspace keying deleted. Showing
    // it once, and taking it down again, leaves the suspend resolved — so the
    // absence below is about the keying.
    const primed = await openRun()
    expect(await screen.findByRole('dialog')).toBeTruthy()
    act(() => { primed.end() })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })

    await openRun('ws-somewhere-else')

    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
