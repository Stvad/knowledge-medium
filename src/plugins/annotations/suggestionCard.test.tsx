// @vitest-environment happy-dom
import {cleanup, render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {ChangeScope} from '@/data/api'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {RepoContext} from '@/context/repo'
import {referencesDataExtension} from '@/plugins/references/dataExtension.js'
import {captureAnchor} from './anchor'
import {annotationsDataExtension} from './dataExtension'
import {annotationReplacementProp, annotationStatusProp, threadStatusOf, threadSuggestionOf} from './schema'
import {showsAnchorState, SuggestionActions, SuggestionText} from './suggestionCard'
import {createThread} from './threads'

const WS = 'ws'
const TEXT = 'Meet Thursday'
const opts = {scope: ChangeScope.BlockDefault}

let db: TestDb
let repo: Repo
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  await resetTestDb(db.db)
  repo = createTestRepo({db: db.db, user: {id: 'alex'}, extensions: [referencesDataExtension, annotationsDataExtension]}).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(tx => tx.create({id: 'B', workspaceId: WS, parentId: null, orderKey: 'a0', content: TEXT}), opts)
})
afterEach(cleanup)

const root = (status: string, replacement: string | null = 'Thursday 9am') => ({
  content: 'Thursday',
  properties: {
    [annotationStatusProp.name]: status,
    ...(replacement === null ? {} : {[annotationReplacementProp.name]: replacement}),
  },
})

const suggestOnB = async () => (await createThread(repo, {
  targetId: 'B', anchor: captureAnchor(TEXT, 5, 13), replacement: 'Thursday 9am',
})).threadId

describe('threadSuggestionOf', () => {
  it('is the anchor and replacement of a suggestion, and null for a comment or a whole-block thread', () => {
    expect(threadSuggestionOf(root('open'))).toMatchObject({anchor: {quote: 'Thursday'}, replacement: 'Thursday 9am'})
    expect(threadSuggestionOf(root('open', null))).toBeNull()
    expect(threadSuggestionOf({...root('open'), content: ''})).toBeNull()
  })
})

describe('showsAnchorState', () => {
  it('hides where a closed suggestion\'s quote resolves, which accepting moved on purpose', () => {
    expect(showsAnchorState(root('open'))).toBe(true)
    expect(showsAnchorState(root('accepted'))).toBe(false)
    expect(showsAnchorState(root('rejected'))).toBe(false)
    expect(showsAnchorState(root('resolved', null))).toBe(true)
  })
})

describe('SuggestionText', () => {
  const textOf = (status: string) => {
    const r = root(status)
    const {container} = render(<SuggestionText root={r} suggestion={threadSuggestionOf(r)!}/>)
    return container
  }

  it('shows an open suggestion as the quote struck through and the replacement inserted', () => {
    const container = textOf('open')
    expect(container.querySelector('del')?.textContent).toBe('Thursday')
    expect(container.querySelector('ins')?.textContent).toBe('Thursday 9am')
  })

  it('reads a closed one as what became of it', () => {
    expect(textOf('accepted').textContent).toBe('Replaced “Thursday” with “Thursday 9am”')
    expect(textOf('rejected').textContent).toBe('Rejected replacing “Thursday” with “Thursday 9am”')
  })
})

describe('SuggestionActions', () => {
  const renderActions = (threadId: string) => render(
    <RepoContext.Provider value={repo}><SuggestionActions threadId={threadId}/></RepoContext.Provider>,
  )

  it('accepts with a click, editing the target', async () => {
    const threadId = await suggestOnB()
    renderActions(threadId)
    await userEvent.click(screen.getByRole('button', {name: 'Accept'}))
    await vi.waitFor(async () => expect((await repo.load('B'))!.content).toBe('Meet Thursday 9am'))
    expect(threadStatusOf((await repo.load(threadId))!)).toBe('accepted')
  })

  it('rejects with a click, leaving the target alone', async () => {
    const threadId = await suggestOnB()
    renderActions(threadId)
    await userEvent.click(screen.getByRole('button', {name: 'Reject'}))
    await vi.waitFor(async () => expect(threadStatusOf((await repo.load(threadId))!)).toBe('rejected'))
    expect((await repo.load('B'))!.content).toBe(TEXT)
  })
})
