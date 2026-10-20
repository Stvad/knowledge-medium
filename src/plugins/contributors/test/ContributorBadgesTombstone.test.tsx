// @vitest-environment happy-dom
import {act, cleanup, render, screen, waitFor} from '@testing-library/react'
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {ChangeScope} from '@/data/api'
import type {Block} from '@/data/block'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import type {Repo} from '@/data/repo'
import type {BlockRenderer} from '@/types.js'
import {CONTRIBUTOR_TYPE, contributorKindProp, contributorRoleProp} from '../schema.js'
import {attributionCreatorsProp, attributionEditorsProp} from '../schema.js'
import {contributorsDataExtension} from '../dataExtension.js'
import {contributorBadgesDecoratorContribution} from '../ContributorBadges.js'

vi.mock('@/utils/navigation.js', () => ({useOpenBlock: () => () => {}}))
vi.mock('@/context/layoutWsContext.js', () => ({useAppHashInContext: (_ws: string, id: string) => `#${id}`}))

const WS = 'ws-contributors'
const NOTE = 'note'
const AGENT = 'agent-profile'
const Inner: BlockRenderer = ({block}: {block: Block}) => <span>Body {block.id}</span>
let sharedDb: TestDb
let repo: Repo
const createRepo = () => createTestRepo({db: sharedDb.db, user: {id: 'user-1'}, extensions: [contributorsDataExtension]}).repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createRepo()
  repo.setActiveWorkspaceId(WS)
})
afterEach(() => {
  cleanup()
  repo.stopSyncObserver()
  repo.setActiveWorkspaceId(null)
})

const seedNoteAndAgent = async (kind: 'human' | 'agent') => {
  await repo.tx(async tx => {
    await tx.create({id: NOTE, workspaceId: WS, parentId: null, orderKey: 'a', content: 'Note'})
    await tx.create({id: AGENT, workspaceId: WS, parentId: null, orderKey: 'b', content: 'Atlas'})
    await repo.addTypeInTx(tx, AGENT, CONTRIBUTOR_TYPE)
    await tx.setProperty(AGENT, contributorKindProp, kind)
    await tx.setProperty(AGENT, contributorRoleProp, 'Researcher')
    await tx.setProperty(NOTE, attributionCreatorsProp, [AGENT])
    await tx.setProperty(NOTE, attributionEditorsProp, [])
  }, {scope: ChangeScope.BlockDefault, context: {contributorId: null}})
}

const renderNote = () => {
  const block = repo.block(NOTE)
  const decorate = contributorBadgesDecoratorContribution({block} as never)
  if (!decorate) throw new Error('contributors decorator opted out')
  const Decorated = decorate(Inner)
  return render(<Decorated block={block}/>)
}

const badge = () => screen.getByRole('button', {name: /Authorship details/})

describe('contributor badge profile liveness', () => {
  it('keeps deleted profile provenance, resolves it on a cold mount, and updates after restore/rename', async () => {
    await seedNoteAndAgent('agent')
    const firstMount = renderNote()
    await waitFor(() => expect(badge().textContent).toBe('By Atlas · Researcher'))

    await act(async () => {
      await repo.tx(tx => tx.delete(AGENT), {scope: ChangeScope.BlockDefault, context: {contributorId: null}})
    })
    expect(badge().textContent).toBe('By Atlas · Researcher')

    firstMount.unmount()
    const mountedRepo = repo
    mountedRepo.stopSyncObserver()
    mountedRepo.setActiveWorkspaceId(null)
    // A fresh Repo has no cached profile or query result; the tombstone must
    // come from the workspace-scoped SQL query on this cold mount.
    repo = createRepo()
    repo.setActiveWorkspaceId(WS)
    expect(repo.cache.getSnapshot(AGENT)).toBeUndefined()
    renderNote()
    await waitFor(() => expect(badge().textContent).toBe('By Atlas · Researcher'))

    await act(async () => {
      await repo.tx(tx => tx.restore(AGENT, {content: 'Orion'}), {scope: ChangeScope.BlockDefault, context: {contributorId: null}})
    })
    await waitFor(() => expect(badge().textContent).toBe('By Orion · Researcher'))
  })

  it('keeps a human-only profile quiet when its kind changes from agent to human', async () => {
    await seedNoteAndAgent('agent')
    renderNote()
    await waitFor(() => expect(badge().textContent).toBe('By Atlas · Researcher'))

    await act(async () => {
      await repo.tx(tx => tx.setProperty(AGENT, contributorKindProp, 'human'), {
        scope: ChangeScope.BlockDefault, context: {contributorId: null},
      })
    })
    await waitFor(() => expect(screen.queryByRole('button', {name: /Authorship details/})).toBeNull())
    expect(screen.getByText('Body note')).toBeTruthy()
  })
})
