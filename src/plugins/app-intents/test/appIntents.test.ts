// @vitest-environment happy-dom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { getLayoutSessionBlock, getUIStateBlock } from '@/data/stateBlocks'
import { editorSelection } from '@/data/properties'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { __resetLayoutSessionIdForTesting } from '@/utils/layoutSessionId'
import {
  insertPanelRow,
  panelBlockId,
  panelRowsInLayoutOrder,
} from '@/utils/panelLayoutProjection'
import { __resetAppIntentForTesting, consumeAppIntent, formatSharedContent } from '../appIntents.ts'
import {
  dailyNotesDataExtension,
  getOrCreateDailyNote,
  OPEN_DAILY_NOTE_PICKER_ACTION_ID,
} from '@/plugins/daily-notes'
import { QUICK_FIND_ACTION_ID } from '@/plugins/quick-find'
import { runActionById } from '@/shortcuts/runAction.js'

vi.mock('@/shortcuts/runAction.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shortcuts/runAction.js')>()),
  runActionById: vi.fn(),
}))

const runActionByIdMock = vi.mocked(runActionById)

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const { repo } = createTestRepo({
    db: h.db,
    user: USER,
    extensions: [dailyNotesDataExtension],
  })
  repo.setActiveWorkspaceId(WS)
  return {h, repo}
}

const setLocationSearch = (search: string): void => {
  // jsdom requires a full document reload-equivalent to swap window.location.
  // history.replaceState updates href/search without reloading, which is
  // both more realistic (matches the prod replaceState we use to strip
  // the params) and avoids jsdom's "not implemented: navigation" warning.
  window.history.replaceState(null, '', `/${search}`)
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  __resetLayoutSessionIdForTesting()
  __resetAppIntentForTesting()
  runActionByIdMock.mockClear()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 4, 13, 12))
  setLocationSearch('')
  env = await setup()
})

afterEach(async () => {
  vi.useRealTimers()
  setLocationSearch('')
})

const seedLandingLayout = async () => {
  const daily = await getOrCreateDailyNote(env.repo, WS, '2026-05-13')
  await env.repo.tx(async tx => {
    await tx.create({
      id: 'main-block',
      workspaceId: WS,
      parentId: null,
      orderKey: 'm0',
      content: 'Main',
    })
  }, {scope: ChangeScope.BlockDefault})
  const rootUiState = await getUIStateBlock(env.repo, WS, USER, {})
  const layoutSession = await getLayoutSessionBlock(rootUiState, env.repo.activeLayoutSessionId)
  await insertPanelRow(env.repo, layoutSession, 'main-block')
  return {daily, layoutSession}
}

describe('formatSharedContent', () => {
  it('joins distinct fields with newlines', () => {
    expect(formatSharedContent('Title', 'Body', 'https://x/y'))
      .toBe('Title\nBody\nhttps://x/y')
  })

  it('dedupes when fields overlap (Android puts URL into text)', () => {
    expect(formatSharedContent(null, 'https://x/y', 'https://x/y'))
      .toBe('https://x/y')
  })

  it('drops null and empty fields', () => {
    expect(formatSharedContent(null, '', 'https://x/y'))
      .toBe('https://x/y')
  })
})

describe('consumeAppIntent', () => {
  it('does nothing when no intent params are present', async () => {
    const {daily, layoutSession} = await seedLandingLayout()
    await consumeAppIntent(env.repo, layoutSession)
    const dailyChildren = await env.repo.block(daily.id).childIds.load()
    expect(dailyChildren).toHaveLength(0)
  })

  it('on intent=new-daily-block appends an empty block to today', async () => {
    const {daily, layoutSession} = await seedLandingLayout()
    setLocationSearch('?intent=new-daily-block')

    await consumeAppIntent(env.repo, layoutSession)

    const dailyChildren = await env.repo.block(daily.id).childIds.load()
    expect(dailyChildren).toHaveLength(1)
    expect(env.repo.block(dailyChildren[0]).peek()?.content).toBe('')
    expect(window.location.search).toBe('')
  })

  it('on share intent appends a block prefilled with shared content and lands cursor at the end', async () => {
    const {daily, layoutSession} = await seedLandingLayout()
    setLocationSearch('?intent=share&title=Hello&url=https%3A%2F%2Fx%2Fy')

    await consumeAppIntent(env.repo, layoutSession)

    const dailyChildren = await env.repo.block(daily.id).childIds.load()
    expect(dailyChildren).toHaveLength(1)
    const expectedContent = 'Hello\nhttps://x/y'
    const newBlockId = dailyChildren[0]
    expect(env.repo.block(newBlockId).peek()?.content).toBe(expectedContent)
    expect(window.location.search).toBe('')

    const layoutRows = await env.repo.query.subtree({id: layoutSession.id}).load()
    const newPanel = panelRowsInLayoutOrder(layoutSession.id, layoutRows)
      .find(row => panelBlockId(row) === newBlockId)
    expect(newPanel).toBeTruthy()
    const selection = env.repo.block(newPanel!.id).peekProperty(editorSelection)
    expect(selection).toEqual({blockId: newBlockId, start: expectedContent.length})
  })

  it('treats raw share fields without intent= as a share', async () => {
    // Browsers theoretically replace the action URL query string with
    // the share form data — verify we still recognise the dispatch.
    const {daily, layoutSession} = await seedLandingLayout()
    setLocationSearch('?title=Just%20a%20note')

    await consumeAppIntent(env.repo, layoutSession)

    const dailyChildren = await env.repo.block(daily.id).childIds.load()
    expect(dailyChildren).toHaveLength(1)
    expect(env.repo.block(dailyChildren[0]).peek()?.content).toBe('Just a note')
  })

  it('only consumes once per page load', async () => {
    const {daily, layoutSession} = await seedLandingLayout()
    setLocationSearch('?intent=new-daily-block')

    await consumeAppIntent(env.repo, layoutSession)
    // Restore the params and call again — module-level guard should
    // still skip the dispatch.
    setLocationSearch('?intent=new-daily-block')
    await consumeAppIntent(env.repo, layoutSession)

    const dailyChildren = await env.repo.block(daily.id).childIds.load()
    expect(dailyChildren).toHaveLength(1)
  })

  it('on intent=open-picker runs the daily-note picker action and clears params', async () => {
    const {daily, layoutSession} = await seedLandingLayout()
    setLocationSearch('?intent=open-picker')

    await consumeAppIntent(env.repo, layoutSession)

    expect(runActionByIdMock).toHaveBeenCalledTimes(1)
    expect(runActionByIdMock.mock.calls[0][0]).toBe(OPEN_DAILY_NOTE_PICKER_ACTION_ID)
    expect(window.location.search).toBe('')
    // Picker is a UI-only intent — must not create a block.
    const dailyChildren = await env.repo.block(daily.id).childIds.load()
    expect(dailyChildren).toHaveLength(0)
  })

  it('on intent=quick-find runs the quick-find action and clears params', async () => {
    const {daily, layoutSession} = await seedLandingLayout()
    setLocationSearch('?intent=quick-find')

    await consumeAppIntent(env.repo, layoutSession)

    expect(runActionByIdMock).toHaveBeenCalledTimes(1)
    expect(runActionByIdMock.mock.calls[0][0]).toBe(QUICK_FIND_ACTION_ID)
    expect(window.location.search).toBe('')
    const dailyChildren = await env.repo.block(daily.id).childIds.load()
    expect(dailyChildren).toHaveLength(0)
  })

  it('preserves URL params when the dispatch no-ops in read-only mode', async () => {
    const {daily, layoutSession} = await seedLandingLayout()
    env.repo.setReadOnly(true)
    const sharedQuery = '?intent=share&text=Important%20note'
    setLocationSearch(sharedQuery)

    await consumeAppIntent(env.repo, layoutSession)

    // No block created — appendTodayDailyBlockInStack early-returns
    // when read-only — and the URL still carries the share payload
    // so a reload (after read-only is lifted) can retry.
    const dailyChildren = await env.repo.block(daily.id).childIds.load()
    expect(dailyChildren).toHaveLength(0)
    expect(window.location.search).toBe(sharedQuery)
  })
})
