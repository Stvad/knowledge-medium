import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {ChangeScope} from '@/data/api'
import {PAGE_TYPE} from '@/data/blockTypes'
import {typesProp} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {referencesDataExtension} from '@/plugins/references/dataExtension.js'
import {addComment, anchorForQuote} from './addComment'
import {resolveAnchor} from './anchor'
import {annotationsDataExtension} from './dataExtension'
import {threadAnchorOf} from './schema'
import {InvalidQuoteError, UnannotatableTargetError} from './threads'

const WS = 'ws'
const TEXT = 'Ship the fix, then test the fix. Ask [[Vendor]] first.'
const opts = {scope: ChangeScope.BlockDefault}

let db: TestDb
let repo: Repo
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  await resetTestDb(db.db)
  repo = createTestRepo({db: db.db, user: {id: 'alex', name: 'Alex'}, extensions: [referencesDataExtension, annotationsDataExtension]}).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Notes',
      properties: {[typesProp.name]: [PAGE_TYPE]}})
    await tx.create({id: 'B', workspaceId: WS, parentId: 'page', orderKey: 'a0', content: TEXT})
  }, opts)
})

const anchorOf = async (threadId: string) => threadAnchorOf((await repo.load(threadId))!)

describe('anchorForQuote', () => {
  it('anchors a quote that appears once, exactly where it is', () => {
    const anchor = anchorForQuote(TEXT, 'Ship')
    expect(anchor).toMatchObject({quote: 'Ship', quoteStart: 0})
    expect(resolveAnchor(TEXT, anchor)).toEqual({state: 'exact', from: 0, to: 4})
  })

  it('refuses an ambiguous quote, and anchors the appearance `occurrence` picks', () => {
    expect(() => anchorForQuote(TEXT, 'the fix')).toThrow(/appears 2 times.*occurrence \(1–2\)/)
    const second = anchorForQuote(TEXT, 'the fix', 2)
    expect(second.quoteStart).toBe(TEXT.lastIndexOf('the fix'))
    expect(resolveAnchor(TEXT, second).state).toBe('exact')
  })

  it('refuses an occurrence out of range, a quote not in the text, and an empty quote', () => {
    expect(() => anchorForQuote(TEXT, 'the fix', 3)).toThrow(InvalidQuoteError)
    expect(() => anchorForQuote(TEXT, 'the fix', 0)).toThrow(InvalidQuoteError)
    expect(() => anchorForQuote(TEXT, 'Thursday')).toThrow(/not in the block/)
    expect(() => anchorForQuote(TEXT, '')).toThrow(/empty/)
  })

  it('widens a quote that cuts a reference to the whole reference', () => {
    expect(anchorForQuote(TEXT, 'Vendor').quote).toBe('[[Vendor]]')
  })
})

describe('addComment', () => {
  it('creates a thread on the quote with its first comment', async () => {
    const {threadId, commentId} = await addComment(repo, {targetId: 'B', quote: 'the fix', occurrence: 2, comment: 'Which fix?'})
    const anchor = await anchorOf(threadId)
    expect(anchor).toMatchObject({kind: 'range', quote: 'the fix', quoteStart: TEXT.lastIndexOf('the fix')})
    expect((await repo.load(commentId!))?.content).toBe('Which fix?')
  })

  it('comments on the whole block with no quote, and makes a highlight with no comment', async () => {
    const whole = await addComment(repo, {targetId: 'B', comment: 'Looks good'})
    expect(await anchorOf(whole.threadId)).toEqual({kind: 'block'})
    const highlight = await addComment(repo, {targetId: 'B', quote: 'Ship'})
    expect(highlight.commentId).toBeNull()
  })

  it('refuses a thread root and the page that holds threads as targets', async () => {
    const {threadId} = await addComment(repo, {targetId: 'B', comment: 'On B'})
    const containerId = (await repo.load(threadId))!.parentId!
    for (const targetId of [threadId, containerId]) {
      await expect(addComment(repo, {targetId, comment: 'x'})).rejects.toThrow(/can’t be commented on/)
    }
  })

  it('refuses an occurrence without a quote, and a missing target', async () => {
    await expect(addComment(repo, {targetId: 'B', occurrence: 1})).rejects.toThrow(InvalidQuoteError)
    await expect(addComment(repo, {targetId: 'nope', quote: 'Ship'})).rejects.toThrow(UnannotatableTargetError)
  })
})
