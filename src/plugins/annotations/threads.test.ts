import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {ChangeScope} from '@/data/api'
import {PAGE_TYPE} from '@/data/blockTypes'
import {propertyDefinitionBlockId} from '@/data/definitionSeeds'
import {propertyFieldContent} from '@/data/propertyChildren'
import {isCollapsedProp, typesProp} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {referencesDataExtension} from '@/plugins/references/dataExtension.js'
import {captureAnchor, resolveAnchor, type RangeAnchor} from './anchor'
import {COMMENTS_PAGE_ALIAS, commentsPageBlockId} from './container'
import {DELETED_COMMENT_CONTENT, deleteCommentFromCard} from './deleteComment'
import {annotationsPlugin} from './index'
import {annotationsDataExtension} from './dataExtension'
import {
  annotationQuotePrefixProp,
  annotationStatusProp,
  annotationTargetProp,
  THREAD_TYPE,
  threadAnchorOf,
  threadStatusOf,
  threadTargetIdOf,
} from './schema'
import {AnchorChangedError, createThread, InvalidQuoteError, replyTo, setThreadStatus, UnannotatableTargetError} from './threads'

const WS = 'ws'
const TARGET_TEXT = 'We moved the launch to Thursday because the vendor slipped.'
const opts = {scope: ChangeScope.BlockDefault}

let db: TestDb
let repo: Repo
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })

const setUp = async (extensions = [referencesDataExtension, annotationsPlugin]) => {
  await resetTestDb(db.db)
  repo = createTestRepo({db: db.db, user: {id: 'alex', name: 'Alex'}, extensions}).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Project notes',
      properties: {[typesProp.name]: [PAGE_TYPE]}})
    await tx.create({id: 'B', workspaceId: WS, parentId: 'page', orderKey: 'a0', content: TARGET_TEXT})
  }, opts)
}

const anchorFor = (content: string, quote: string): RangeAnchor => {
  const from = content.indexOf(quote)
  return captureAnchor(content, from, from + quote.length)!
}

const threadsOf = (targetId: string) =>
  repo.query['core.typedBlockIds']({
    workspaceId: WS, types: [THREAD_TYPE],
    referencedBy: {id: targetId, sourceField: annotationTargetProp.name},
  }).load()

const childContents = async (id: string) =>
  (await repo.block(id).children.load()).map(child => child.content)

describe('createThread', () => {
  beforeEach(() => setUp())

  it('writes the container, the root and the first comment, and never the target', async () => {
    const before = await repo.load('B')
    const {threadId, commentId} = await createThread(repo, {
      targetId: 'B', anchor: anchorFor(TARGET_TEXT, 'Thursday'), comment: 'Is Thursday confirmed?',
    })

    const container = (await repo.load(commentsPageBlockId(WS)))!
    expect(container.content).toBe(COMMENTS_PAGE_ALIAS)
    const root = (await repo.load(threadId))!
    expect(root.parentId).toBe(container.id)
    expect(root.content).toBe('Thursday')
    expect(threadTargetIdOf(root)).toBe('B')
    expect(threadStatusOf(root)).toBe('open')
    expect(threadAnchorOf(root)).toEqual({
      kind: 'range', quote: 'Thursday', quoteStart: 23,
      prefix: 'd the launch to ', suffix: ' because the ven',
    })
    expect(await childContents(threadId)).toEqual(['Is Thursday confirmed?'])
    expect((await repo.load(commentId!))!.parentId).toBe(threadId)
    expect(await repo.load('B')).toEqual(before)
  })

  it('is one undo step that leaves the container, which other devices file threads under', async () => {
    const {threadId, commentId} = await createThread(repo, {
      targetId: 'B', anchor: anchorFor(TARGET_TEXT, 'Thursday'), comment: 'Is Thursday confirmed?',
    })
    expect(await repo.undo()).toBe(true)
    expect(await repo.load(threadId)).toBeNull()
    expect(await repo.load(commentId!)).toBeNull()
    expect((await repo.load(commentsPageBlockId(WS)))!.content).toBe(COMMENTS_PAGE_ALIAS)
    // The setup tx before it is still in place: one step took exactly the thread.
    expect((await repo.load('B'))!.content).toBe(TARGET_TEXT)
    // And no later step takes the container either: the next one is the setup.
    expect(await repo.undo()).toBe(true)
    expect(await repo.load('B')).toBeNull()
    expect(await repo.load(commentsPageBlockId(WS))).not.toBeNull()
  })

  it('is discoverable through the target edge as soon as it commits', async () => {
    // No reference processor installed: only the references passed at create
    // time can have projected the edge.
    await setUp([annotationsDataExtension])
    const {threadId} = await createThread(repo, {targetId: 'B', anchor: null, comment: 'Whole block'})
    expect(await threadsOf('B')).toEqual([threadId])
  })

  it('comments on the whole block with no quote and no anchor properties', async () => {
    const {threadId} = await createThread(repo, {targetId: 'B', anchor: null, comment: 'General remark'})
    const root = (await repo.load(threadId))!
    expect(root.content).toBe('')
    expect(threadAnchorOf(root)).toEqual({kind: 'block'})
    expect(root.properties[annotationQuotePrefixProp.name]).toBeUndefined()
  })

  it('makes a highlight, a thread with no comments, when there is no comment', async () => {
    const {threadId, commentId} = await createThread(repo, {targetId: 'B', anchor: anchorFor(TARGET_TEXT, 'vendor')})
    expect(commentId).toBeNull()
    expect(await childContents(threadId)).toEqual([])
    expect(await threadsOf('B')).toEqual([threadId])
  })

  it('reuses the container for later threads', async () => {
    const first = await createThread(repo, {targetId: 'B', anchor: null, comment: 'one'})
    const second = await createThread(repo, {targetId: 'B', anchor: null, comment: 'two'})
    expect((await repo.load(first.threadId))!.parentId).toBe((await repo.load(second.threadId))!.parentId)
  })

  it('refuses, writing nothing, when the target changed under the selection', async () => {
    const anchor = anchorFor(TARGET_TEXT, 'Thursday')
    await createThread(repo, {targetId: 'B', anchor: null, comment: 'container exists'})
    await repo.tx(tx => tx.update('B', {content: `Update: ${TARGET_TEXT}`}), opts)
    await expect(createThread(repo, {targetId: 'B', anchor, comment: 'Is Thursday confirmed?'}))
      .rejects.toBeInstanceOf(AnchorChangedError)
    expect(await threadsOf('B')).toHaveLength(1)
  })

  it('refuses a target deleted between the first read and the creating tx', async () => {
    const load = repo.load.bind(repo)
    vi.spyOn(repo, 'load').mockImplementationOnce(async id => {
      const row = await load(id)
      await repo.tx(tx => tx.delete('B'), opts)
      return row
    })
    await expect(createThread(repo, {targetId: 'B', anchor: null, comment: 'x'}))
      .rejects.toBeInstanceOf(UnannotatableTargetError)
    vi.restoreAllMocks()
    await repo.tx(tx => tx.restore('B'), opts)
    expect(await threadsOf('B')).toEqual([])
  })

  it('refuses a quote that is a property field marker, which would make the root a field row', async () => {
    const marker = '::((3f2a9c1d-0000-4000-8000-00000000f1e1))'
    await repo.tx(tx => tx.update('B', {content: `Field rows look like ${marker} in raw text`}), opts)
    const content = (await repo.load('B'))!.content
    await expect(createThread(repo, {targetId: 'B', anchor: anchorFor(content, marker), comment: 'c'}))
      .rejects.toBeInstanceOf(InvalidQuoteError)
    expect(await threadsOf('B')).toEqual([])
  })

  it.each([
    ['an empty quote', {quote: '', quoteStart: 0, prefix: '', suffix: ''}],
    ['a fractional start', {quote: 'Thursday', quoteStart: 23.5, prefix: 'd the launch to ', suffix: ' because the ven'}],
    ['half a surrogate pair', {quote: 'Thursday\ud83d', quoteStart: 23, prefix: '', suffix: ''}],
  ])('refuses a hand-built anchor with %s', async (_, anchor) => {
    await expect(createThread(repo, {targetId: 'B', anchor, comment: 'x'})).rejects.toBeInstanceOf(InvalidQuoteError)
  })

  it('refuses a missing or deleted target', async () => {
    await expect(createThread(repo, {targetId: 'nope', anchor: null, comment: 'x'}))
      .rejects.toBeInstanceOf(UnannotatableTargetError)
    await repo.tx(tx => tx.delete('B'), opts)
    await expect(createThread(repo, {targetId: 'B', anchor: null, comment: 'x'}))
      .rejects.toBeInstanceOf(UnannotatableTargetError)
  })

  describe('property rows as targets', () => {
    const fieldAndValueRows = async () => {
      await db.db.execute(`INSERT INTO workspaces
        (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
        VALUES (?, 'Test', 'alex', 1, 1, 'none', NULL, 'children')`, [WS])
      await repo.tx(tx => tx.setProperty('B', annotationQuotePrefixProp, 'a value'), opts)
      const fieldId = propertyDefinitionBlockId(WS, annotationQuotePrefixProp.seedKey)
      const field = await db.db.get<{id: string}>(
        'SELECT id FROM blocks WHERE parent_id = ? AND content = ? AND deleted = 0', ['B', propertyFieldContent(fieldId)])
      const value = await db.db.get<{id: string}>('SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0', [field.id])
      return {field: field.id, value: value.id}
    }

    it('refuses a property field row', async () => {
      const {field} = await fieldAndValueRows()
      await expect(createThread(repo, {targetId: field, anchor: null, comment: 'x'}))
        .rejects.toBeInstanceOf(UnannotatableTargetError)
    })

    it('refuses a property value row', async () => {
      const {value} = await fieldAndValueRows()
      await expect(createThread(repo, {targetId: value, anchor: null, comment: 'x'}))
        .rejects.toBeInstanceOf(UnannotatableTargetError)
    })
  })
})

describe('replies and status', () => {
  beforeEach(() => setUp())

  it('replies under the comment being answered, revealing it if collapsed', async () => {
    const {threadId, commentId} = await createThread(repo, {targetId: 'B', anchor: null, comment: 'First'})
    await repo.tx(tx => tx.setProperty(commentId!, isCollapsedProp, true), opts)
    const replyId = await replyTo(repo, commentId!)
    expect((await repo.load(replyId))!.parentId).toBe(commentId)
    expect((await repo.load(commentId!))!.properties[isCollapsedProp.name]).toBe(false)
    expect((await repo.load(replyId))!.content).toBe('')
    const nestedId = await replyTo(repo, replyId)
    expect((await repo.load(nestedId))!.parentId).toBe(replyId)
    expect(await childContents(threadId)).toEqual(['First'])
  })

  it('resolves and reopens a thread', async () => {
    const {threadId} = await createThread(repo, {targetId: 'B', anchor: null, comment: 'x'})
    await setThreadStatus(repo, threadId, 'resolved')
    expect((await repo.load(threadId))!.properties[annotationStatusProp.name]).toBe('resolved')
    await setThreadStatus(repo, threadId, 'open')
    expect(threadStatusOf((await repo.load(threadId))!)).toBe('open')
  })
})

describe('target lifecycle', () => {
  beforeEach(() => setUp())

  it('keeps the thread and its ref when the target is deleted, and resolves again on restore', async () => {
    const anchor = anchorFor(TARGET_TEXT, 'Thursday')
    const {threadId} = await createThread(repo, {targetId: 'B', anchor, comment: 'x'})
    await repo.tx(tx => tx.delete('B'), opts)
    const root = (await repo.load(threadId))!
    expect(threadTargetIdOf(root)).toBe('B')
    await repo.tx(tx => tx.restore('B'), opts)
    expect(resolveAnchor((await repo.load('B'))!.content, anchor).state).toBe('exact')
    expect(await threadsOf('B')).toEqual([threadId])
  })

  it('follows a merge through the production processors, and the anchor resolves as moved', async () => {
    await repo.tx(async tx => {
      await tx.create({id: 'A', workspaceId: WS, parentId: 'page', orderKey: 'Zz', content: 'Ship the fix, '})
      await tx.update('B', {content: 'then test the fix.'})
    }, opts)
    const {threadId} = await createThread(repo, {
      targetId: 'B', anchor: anchorFor('then test the fix.', 'the fix'), comment: 'x',
    })
    await repo.mutate.merge({intoId: 'A', fromId: 'B'})

    const root = (await repo.load(threadId))!
    expect(threadTargetIdOf(root)).toBe('A')
    expect(await threadsOf('A')).toEqual([threadId])
    const anchor = threadAnchorOf(root)
    if (anchor.kind !== 'range') throw new Error('expected a range anchor')
    expect(resolveAnchor((await repo.load('A'))!.content, anchor)).toEqual({state: 'moved', from: 24, to: 31})
  })
})

describe('deleteCommentFromCard', () => {
  beforeEach(() => setUp())

  it('blanks a comment that has replies, keeping the replies', async () => {
    const {commentId} = await createThread(repo, {targetId: 'B', anchor: null, comment: 'Mine'})
    const replyId = await replyTo(repo, commentId!)
    await repo.tx(tx => tx.update(replyId, {content: 'Someone else’s reply'}), opts)

    expect(await deleteCommentFromCard(repo.block(commentId!))).toBe('blanked')
    expect((await repo.load(commentId!))!.content).toBe(DELETED_COMMENT_CONTENT)
    expect((await repo.load(replyId))!.content).toBe('Someone else’s reply')
  })

  it('deletes a comment with no replies when the thread has others', async () => {
    const {threadId, commentId} = await createThread(repo, {targetId: 'B', anchor: null, comment: 'First'})
    const secondId = await replyTo(repo, threadId)
    expect(await deleteCommentFromCard(repo.block(secondId))).toBe('deleted')
    expect(await repo.load(secondId)).toBeNull()
    expect(await repo.load(commentId!)).not.toBeNull()
    // The reply check wrote nothing, so the top undo entry is the delete.
    expect(await repo.undo()).toBe(true)
    expect(await repo.load(secondId)).not.toBeNull()
  })

  it('deletes the first comment of several, keeping the thread', async () => {
    const {threadId, commentId} = await createThread(repo, {targetId: 'B', anchor: null, comment: 'First'})
    await replyTo(repo, threadId)
    expect(await deleteCommentFromCard(repo.block(commentId!))).toBe('deleted')
    expect(await repo.load(threadId)).not.toBeNull()
  })

  it('deletes only a reply that is its comment’s sole child', async () => {
    const {commentId} = await createThread(repo, {targetId: 'B', anchor: null, comment: 'First'})
    const replyId = await replyTo(repo, commentId!)
    expect(await deleteCommentFromCard(repo.block(replyId))).toBe('deleted')
    expect(await repo.load(commentId!)).not.toBeNull()
  })

  it('deletes the thread with its last comment', async () => {
    const {threadId, commentId} = await createThread(repo, {targetId: 'B', anchor: null, comment: 'Only'})
    expect(await deleteCommentFromCard(repo.block(commentId!))).toBe('deleted-thread')
    expect(await repo.load(threadId)).toBeNull()
  })
})
