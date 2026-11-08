import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {ChangeScope} from '@/data/api'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {referencesDataExtension} from '@/plugins/references/dataExtension.js'
import {captureAnchor, resolveAnchor, type RangeAnchor} from './anchor'
import {annotationsDataExtension} from './dataExtension'
import {confirmedAnchor, reanchorThread} from './reanchor'
import {annotationQuotePrefixProp, annotationQuoteStartProp, annotationQuoteSuffixProp, threadAnchorOf} from './schema'
import {AnchorChangedError, createThread, InvalidQuoteError} from './threads'

const WS = 'ws'
const TEXT = 'Ship the fix, then test the fix.'
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

const anchorAt = (content: string, quote: string, nth = 0): RangeAnchor => {
  let from = -1
  for (let i = 0; i <= nth; i++) from = content.indexOf(quote, from + 1)
  return captureAnchor(content, from, from + quote.length)!
}

const setTarget = (content: string) => repo.tx(tx => tx.update('B', {content}), opts)
const rootOf = async (threadId: string) => (await repo.load(threadId))!
const targetText = async () => (await repo.load('B'))!.content
const stateOf = async (threadId: string) => {
  const anchor = threadAnchorOf(await rootOf(threadId))
  return anchor.kind === 'block' ? 'block' : resolveAnchor(await targetText(), anchor).state
}

describe('confirmedAnchor', () => {
  it('is the moved quote where it now sits, and null once it is stale', async () => {
    const anchor = anchorAt(TEXT, 'the fix', 1)
    const moved = `Note to self: ${TEXT}`
    expect(confirmedAnchor(moved, anchor)).toEqual(anchorAt(moved, 'the fix', 1))
    expect(confirmedAnchor('Ship the fix, then test it.', anchor)).toBeNull()
  })

  it('is null where the quote now sits inside a reference span, which would widen it', () => {
    // Made by hand, as an agent may: creation would have widened it.
    const handMade: RangeAnchor = {quote: 'Launch', quoteStart: 6, prefix: 'See [[', suffix: ']] soon'}
    expect(resolveAnchor('See [[Launch]] soon', handMade).state).toBe('exact')
    expect(confirmedAnchor('See [[Launch]] soon', handMade)).toBeNull()
  })
})

describe('reanchorThread', () => {
  it('confirms a moved quote where it now sits, as one undo step', async () => {
    const {threadId} = await createThread(repo, {targetId: 'B', anchor: anchorAt(TEXT, 'the fix', 1), comment: 'x'})
    await setTarget(`Note to self: ${TEXT}`)
    expect(await stateOf(threadId)).toBe('moved')

    await reanchorThread(repo, threadId, confirmedAnchor(await targetText(), threadAnchorOf(await rootOf(threadId)) as RangeAnchor))
    expect(await stateOf(threadId)).toBe('exact')
    expect((await rootOf(threadId)).content).toBe('the fix')
    expect((await rootOf(threadId)).properties[annotationQuoteStartProp.name]).toBe(38)

    expect(await repo.undo()).toBe(true)
    expect(await stateOf(threadId)).toBe('moved')
  })

  it('moves a stale thread onto newly selected text', async () => {
    const {threadId} = await createThread(repo, {targetId: 'B', anchor: anchorAt(TEXT, 'test the fix'), comment: 'x'})
    await setTarget('Ship the fix, then verify it.')
    expect(await stateOf(threadId)).toBe('stale')

    await reanchorThread(repo, threadId, anchorAt('Ship the fix, then verify it.', 'verify it'))
    expect((await rootOf(threadId)).content).toBe('verify it')
    expect(await stateOf(threadId)).toBe('exact')
  })

  it('anchors a thread to the whole block, clearing the quote and its context', async () => {
    const {threadId} = await createThread(repo, {targetId: 'B', anchor: anchorAt(TEXT, 'the fix'), comment: 'x'})
    await reanchorThread(repo, threadId, null)
    const root = await rootOf(threadId)
    expect(root.content).toBe('')
    expect(threadAnchorOf(root)).toEqual({kind: 'block'})
    for (const prop of [annotationQuoteStartProp, annotationQuotePrefixProp, annotationQuoteSuffixProp]) {
      expect(root.properties[prop.name]).toBeUndefined()
    }
  })

  it('refuses, writing nothing, when the text changed after it was selected', async () => {
    const {threadId} = await createThread(repo, {targetId: 'B', anchor: anchorAt(TEXT, 'Ship'), comment: 'x'})
    const selected = anchorAt(TEXT, 'test the fix')
    await setTarget(`${TEXT} Later.`)
    await expect(reanchorThread(repo, threadId, selected)).rejects.toBeInstanceOf(AnchorChangedError)
    expect((await rootOf(threadId)).content).toBe('Ship')
  })

  it('refuses a deleted thread, and a thread whose target is deleted', async () => {
    const {threadId} = await createThread(repo, {targetId: 'B', anchor: null, comment: 'x'})
    await repo.tx(tx => tx.delete(threadId), opts)
    await expect(reanchorThread(repo, threadId, null)).rejects.toThrow(`Thread ${threadId} is missing or deleted.`)
    const other = await createThread(repo, {targetId: 'B', anchor: null, comment: 'y'})
    await repo.tx(tx => tx.delete('B'), opts)
    await expect(reanchorThread(repo, other.threadId, null)).rejects.toThrow('Block B is missing or deleted.')
  })

  it('refuses a block that is not a thread root', async () => {
    await expect(reanchorThread(repo, 'B', null)).rejects.toThrow('Thread B is missing or deleted.')
  })

  it('refuses a quote a thread root cannot hold', async () => {
    const {threadId} = await createThread(repo, {targetId: 'B', anchor: null, comment: 'x'})
    await expect(reanchorThread(repo, threadId, {quote: '', quoteStart: 0, prefix: '', suffix: ''}))
      .rejects.toBeInstanceOf(InvalidQuoteError)
  })
})
