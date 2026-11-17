// @vitest-environment happy-dom
import {cleanup, fireEvent, render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import type {ReactNode} from 'react'
import {ChangeScope} from '@/data/api'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {RepoContext} from '@/context/repo'
import {referencesDataExtension} from '@/plugins/references/dataExtension.js'
import {captureAnchor} from './anchor'
import {annotationsDataExtension} from './dataExtension'
import {annotationReplacementProp, annotationStatusProp, threadAnchorOf, threadStatusOf, threadSuggestionOf} from './schema'
import {showsAnchorState, SuggestionActions, SuggestionText} from './suggestionCard'
import {createThread} from './threads'
import {ReanchorControls} from './ui'
import {releasePendingReanchor} from './uiStore'

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

  it('shows an open suggestion whole, since Accept applies all of it', () => {
    const long = `${'a'.repeat(200)} and the change at the very end`
    const r = {...root('open'), properties: {...root('open').properties, [annotationReplacementProp.name]: long}}
    const {container} = render(<SuggestionText root={r} suggestion={threadSuggestionOf(r)!}/>)
    expect(container.querySelector('ins')?.textContent).toBe(long)
  })

  it('reads a closed one as what became of it', () => {
    expect(textOf('accepted').textContent).toBe('Replaced “Thursday” with “Thursday 9am”')
    expect(textOf('rejected').textContent).toBe('Rejected replacing “Thursday” with “Thursday 9am”')
    expect(textOf('resolved').textContent).toBe('Closed without applying: replace “Thursday” with “Thursday 9am”')
  })
})

describe('SuggestionActions', () => {
  const renderActions = (threadId: string, recovery?: ReactNode) => render(
    <RepoContext.Provider value={repo}>
      <SuggestionActions threadId={threadId} recovery={recovery}/>
    </RepoContext.Provider>,
  )

  it('accepts with a click, editing the target', async () => {
    const threadId = await suggestOnB()
    renderActions(threadId)
    await userEvent.click(screen.getByRole('button', {name: 'Accept'}))
    await vi.waitFor(async () => expect((await repo.load('B'))!.content).toBe('Meet Thursday 9am'))
    expect(threadStatusOf((await repo.load(threadId))!)).toBe('accepted')
  })

  it('takes one decision at a time: both buttons wait while one is in flight', async () => {
    const threadId = await suggestOnB()
    renderActions(threadId)
    fireEvent.click(screen.getByRole('button', {name: 'Accept'}))
    expect(screen.getByRole('button', {name: 'Reject'})).toBeDisabled()
    expect(screen.getByRole('button', {name: 'Accept'})).toBeDisabled()
    await vi.waitFor(async () => expect(threadStatusOf((await repo.load(threadId))!)).toBe('accepted'))
  })

  it('shows anchor recovery after a refusal and can accept after the text is corrected', async () => {
    const threadId = await suggestOnB()
    await repo.tx(tx => tx.update('B', {content: 'Meet Wednesday'}), opts)
    const rootData = (await repo.load(threadId))!
    renderActions(threadId, <ReanchorControls root={rootData} state="stale" targetContent="Meet Wednesday"/>)

    await userEvent.click(screen.getByRole('button', {name: 'Accept'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('Select the text this suggestion should replace.')
    expect(screen.getByText('Check the position or select the text again before trying Accept.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', {name: 'Reselect'}))
    expect(await screen.findByRole('status')).toHaveTextContent('Select the new text in the block, then choose Comment on selection.')
    expect((await repo.load('B'))!.content).toBe('Meet Wednesday')
    expect(threadStatusOf((await repo.load(threadId))!)).toBe('open')

    releasePendingReanchor(threadId)
    await repo.tx(tx => tx.update('B', {content: TEXT}), opts)
    await userEvent.click(screen.getByRole('button', {name: 'Accept'}))
    await vi.waitFor(async () => expect((await repo.load('B'))!.content).toBe('Meet Thursday 9am'))
    expect(threadStatusOf((await repo.load(threadId))!)).toBe('accepted')
  })

  it('previews the moved candidate before confirming its position, then accepts after re-anchoring', async () => {
    const threadId = await suggestOnB()
    const targetContent = `${'x'.repeat(20)} ${TEXT} and ${TEXT}`
    await repo.tx(tx => tx.update('B', {content: targetContent}), opts)
    const rootData = (await repo.load(threadId))!
    renderActions(threadId, <ReanchorControls root={rootData} state="moved" targetContent={targetContent}/>)

    await userEvent.click(screen.getByRole('button', {name: 'Accept'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('This text appears more than once.')
    expect(screen.getByText('Suggested position (review before confirming):')).toBeInTheDocument()
    expect(screen.getByLabelText(/Candidate quote: .*Meet Thursday/)).toBeInTheDocument()
    expect(screen.getByText('Thursday', {selector: 'mark'})).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', {name: 'Confirm position'}))
    await vi.waitFor(async () => expect(threadAnchorOf((await repo.load(threadId))!)).toMatchObject({quoteStart: 26}))
    await userEvent.click(screen.getByRole('button', {name: 'Accept'}))
    await vi.waitFor(async () => expect((await repo.load('B'))!.content).toContain('Thursday 9am'))
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
