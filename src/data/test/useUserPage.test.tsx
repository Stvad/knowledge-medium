// @vitest-environment happy-dom
/**
 * `useUserPage` end-to-end against a REAL repo — the hook that turns the
 * opaque id in `created_by` / `updated_by` into the display name shown by
 * every attribution surface ("Changed by" in the property panel, the
 * bullet hover-card, the update indicator).
 *
 * Both consumer tests (`BlockMetaCard.test.tsx`,
 * `BlockProperties.component.test.tsx`) mock `useUserPage` out, so the
 * resolution itself — deterministic-id lookup, the load that has to
 * happen before the name is known, and the fallbacks — was unpinned. A
 * regression there resurfaces the raw user id in the UI while every
 * existing test stays green.
 *
 * Coverage:
 *   - resolves an id to the user page's content (display name) + block id
 *   - falls back to the raw id, with no link target, for a user whose page
 *     hasn't synced here yet
 *   - reaches the name only after the row loads (the fallback is not a
 *     terminal state — this is what a broken ensure-load would look like)
 *   - renders a historical `system:<id>` author as "System" with no link
 *   - resolves against the caller-supplied workspace, not the active one
 */
import type { ReactNode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { v4 as uuidv4 } from 'uuid'
import { RepoContext } from '@/context/repo.tsx'
import { useUserPage } from '@/data/globalState.ts'
import { getUserBlock, userPageBlockId } from '@/data/stateBlocks.ts'
import { systemAuthor, type User } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'

const WS = 'ws-1'
const OTHER_WS = 'ws-2'
const ALICE: User = {id: 'user-alice', name: 'Alice'}

let sharedDb: TestDb
let repo: Repo

const setup = (): Repo => {
  let txSeq = Date.now()
  const {repo: created} = createTestRepo({
    db: sharedDb.db,
    user: ALICE,
    newId: uuidv4,
    newTxSeq: () => ++txSeq,
  })
  created.setActiveWorkspaceId(WS)
  return created
}

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = setup()
})
afterEach(() => { repo.stopSyncObserver() })

const wrapper = ({children}: {children: ReactNode}) => (
  <RepoContext value={repo}>{children}</RepoContext>
)

const Probe = ({userId, workspaceId}: {userId: string; workspaceId?: string}) => {
  const {name, blockId} = useUserPage(userId, workspaceId)
  return (
    <>
      <span data-testid="name">{name}</span>
      <span data-testid="block-id">{blockId ?? ''}</span>
    </>
  )
}

const renderProbe = (userId: string, workspaceId?: string) =>
  render(<Probe userId={userId} workspaceId={workspaceId}/>, {wrapper})

describe('useUserPage', () => {
  it('resolves a user id to the display name on their user page', async () => {
    await getUserBlock(repo, WS, ALICE)

    renderProbe(ALICE.id)

    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('Alice'))
    // The link target is the page's deterministic id, so attribution links
    // to the same block every client derives for this user.
    expect(screen.getByTestId('block-id')).toHaveTextContent(userPageBlockId(WS, ALICE.id))
  })

  it('starts on the id fallback and settles on the name once the row loads', async () => {
    await getUserBlock(repo, WS, ALICE)
    // A fresh Repo has an empty block cache, so the first render genuinely
    // has nothing to read — the name can only arrive via the hook's
    // ensure-load. Without it the fallback below would be terminal, which
    // is exactly the "shows the user id" bug.
    repo.stopSyncObserver()
    repo = setup()

    renderProbe(ALICE.id)

    expect(screen.getByTestId('name')).toHaveTextContent(ALICE.id)
    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('Alice'))
  })

  it('falls back to the raw id, unlinked, when the user page has not synced here', async () => {
    renderProbe('user-not-synced')

    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('user-not-synced'))
    // No link target — attribution degrades to plain text rather than
    // linking to a block that does not exist.
    expect(screen.getByTestId('block-id')).toHaveTextContent('')
  })

  it('renders a historical system author as "System" with no link', async () => {
    renderProbe(systemAuthor(ALICE.id))

    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('System'))
    expect(screen.getByTestId('block-id')).toHaveTextContent('')
  })

  it('resolves against the caller-supplied workspace, not the active one', async () => {
    // Same user, a page in each workspace with a different display name.
    await getUserBlock(repo, WS, ALICE)
    await getUserBlock(repo, OTHER_WS, {...ALICE, name: 'Alice elsewhere'})

    renderProbe(ALICE.id, OTHER_WS)

    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('Alice elsewhere'))
    expect(screen.getByTestId('block-id')).toHaveTextContent(userPageBlockId(OTHER_WS, ALICE.id))
  })
})
