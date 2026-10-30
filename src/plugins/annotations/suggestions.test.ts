import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {ChangeScope} from '@/data/api'
import {propertyDefinitionBlockId} from '@/data/definitionSeeds'
import {propertyFieldContent} from '@/data/propertyChildren'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {referencesDataExtension} from '@/plugins/references/dataExtension.js'
import {captureAnchor, resolveAnchor, type RangeAnchor} from './anchor'
import {annotationsDataExtension} from './dataExtension'
import {
  annotationQuotePrefixProp,
  annotationQuoteStartProp,
  annotationQuoteSuffixProp,
  annotationReplacementProp,
  annotationTargetProp,
  threadAnchorOf,
  threadIsOpen,
  threadReplacementOf,
  threadStatusOf,
} from './schema'
import {acceptSuggestion, SuggestionChangedError} from './suggestions'
import {createThread, InvalidSuggestionError, setThreadStatus, UnannotatableTargetError} from './threads'

const WS = 'ws'
const MID = 'We moved the launch to Thursday because the vendor slipped.'
const opts = {scope: ChangeScope.BlockDefault}

let db: TestDb
let repo: Repo
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  await resetTestDb(db.db)
  repo = createTestRepo({db: db.db, user: {id: 'alex'}, extensions: [referencesDataExtension, annotationsDataExtension]}).repo
  repo.setActiveWorkspaceId(WS)
  await setTarget(MID)
})

const setTarget = async (content: string) => {
  const existing = await repo.load('B')
  await repo.tx(async tx => {
    if (existing) await tx.update('B', {content})
    else await tx.create({id: 'B', workspaceId: WS, parentId: null, orderKey: 'a0', content})
  }, opts)
}

const anchorFor = (content: string, quote: string): RangeAnchor => {
  const from = content.indexOf(quote)
  return captureAnchor(content, from, from + quote.length)!
}

const targetText = async () => (await repo.load('B'))!.content
const rootOf = async (threadId: string) => (await repo.load(threadId))!

const suggest = async (quote: string, replacement: string, comment?: string) =>
  (await createThread(repo, {targetId: 'B', anchor: anchorFor(await targetText(), quote), replacement, comment})).threadId

describe('creating a suggestion', () => {
  it('stores the replacement on the root, with or without a comment', async () => {
    const withComment = await suggest('Thursday', 'Thursday 9am', 'Matches the vendor’s email.')
    const bare = await suggest('vendor', 'supplier')
    expect(threadReplacementOf(await rootOf(withComment))).toBe('Thursday 9am')
    expect(threadReplacementOf(await rootOf(bare))).toBe('supplier')
    expect(threadStatusOf(await rootOf(bare))).toBe('open')
    expect(await targetText()).toBe(MID)
  })

  it('refuses a replacement with no quote to replace', async () => {
    await expect(createThread(repo, {targetId: 'B', anchor: null, replacement: 'x'}))
      .rejects.toBeInstanceOf(InvalidSuggestionError)
  })

  it('refuses an empty replacement, and one that changes nothing', async () => {
    await expect(suggest('Thursday', '')).rejects.toBeInstanceOf(InvalidSuggestionError)
    await expect(suggest('Thursday', 'Thursday')).rejects.toBeInstanceOf(InvalidSuggestionError)
  })
})

describe('threadReplacementOf', () => {
  it('reads an empty stored replacement as no suggestion', () => {
    expect(threadReplacementOf({content: 'x', properties: {[annotationReplacementProp.name]: ''}})).toBeUndefined()
    expect(threadReplacementOf({content: 'x', properties: {}})).toBeUndefined()
    expect(threadReplacementOf({content: 'x', properties: {[annotationReplacementProp.name]: 42}})).toBeUndefined()
  })
})

describe('acceptSuggestion', () => {
  it('splices the replacement into the target and marks the thread accepted, as one undo step', async () => {
    const threadId = await suggest('Thursday', 'Thursday 9am')
    await acceptSuggestion(repo, threadId)
    expect(await targetText()).toBe('We moved the launch to Thursday 9am because the vendor slipped.')
    expect(threadStatusOf(await rootOf(threadId))).toBe('accepted')
    expect(threadIsOpen(await rootOf(threadId))).toBe(false)

    expect(await repo.undo()).toBe(true)
    expect(await targetText()).toBe(MID)
    expect(threadStatusOf(await rootOf(threadId))).toBe('open')
  })

  it('refuses a deleted target, writing nothing', async () => {
    const threadId = await suggest('Thursday', 'Thursday 9am')
    await repo.tx(tx => tx.delete('B'), opts)
    await expect(acceptSuggestion(repo, threadId)).rejects.toBeInstanceOf(UnannotatableTargetError)
    expect(threadStatusOf(await rootOf(threadId))).toBe('open')
  })

  it('refuses once the quoted text is gone (stale), writing nothing', async () => {
    const threadId = await suggest('Thursday', 'Thursday 9am')
    await setTarget('We moved the launch to Friday because the vendor slipped.')
    await expect(acceptSuggestion(repo, threadId)).rejects.toBeInstanceOf(SuggestionChangedError)
    expect(await targetText()).toBe('We moved the launch to Friday because the vendor slipped.')
    expect(threadStatusOf(await rootOf(threadId))).toBe('open')
  })

  it('refuses once the quote has moved, even though it is still found', async () => {
    const threadId = await suggest('Thursday', 'Thursday 9am')
    await setTarget(`Update: ${MID}`)
    await expect(acceptSuggestion(repo, threadId)).rejects.toThrow('The text changed since this was suggested')
    expect(await targetText()).toBe(`Update: ${MID}`)
  })

  // The duplicate still finds its quote at its offset; only the context
  // windows, compared for equality, tell that the text was already changed.
  it.each([
    ['mid-block', MID, 'We moved the launch to Thursday 9am because the vendor slipped.'],
    ['at the very start', 'Thursday works for everyone.', 'Thursday 9am works for everyone.'],
    ['at the very end', 'Meet Thursday', 'Meet Thursday 9am'],
  ])('refuses a duplicate of an applied suggestion, with the quote %s', async (_, before, after) => {
    await setTarget(before)
    const first = await suggest('Thursday', 'Thursday 9am')
    const duplicate = await suggest('Thursday', 'Thursday 9am')
    await acceptSuggestion(repo, first)
    expect(await targetText()).toBe(after)

    await expect(acceptSuggestion(repo, duplicate)).rejects.toBeInstanceOf(SuggestionChangedError)
    expect(await targetText()).toBe(after)
    expect(threadStatusOf(await rootOf(duplicate))).toBe('open')
  })

  it('refuses a change that would leave it applicable again, where the text repeats around the quote', async () => {
    const text = 'Say very very very very very very good.'
    await setTarget(text)
    const threadId = await suggest('very', 'very very')
    // The premise: after the splice, the quote sits at its offset between the
    // same windows, so a duplicate or a reopened copy would resolve exact.
    const anchor = threadAnchorOf(await rootOf(threadId)) as RangeAnchor
    expect(resolveAnchor(text.replace('very', 'very very'), anchor).state).toBe('exact')

    await expect(acceptSuggestion(repo, threadId)).rejects.toBeInstanceOf(InvalidSuggestionError)
    expect(await targetText()).toBe(text)
    expect(threadStatusOf(await rootOf(threadId))).toBe('open')
  })

  it('refuses the same suggestion reopened after it was applied', async () => {
    await setTarget('Meet Thursday')
    const threadId = await suggest('Thursday', 'Thursday 9am')
    await acceptSuggestion(repo, threadId)
    await setThreadStatus(repo, threadId, 'open')
    await expect(acceptSuggestion(repo, threadId)).rejects.toBeInstanceOf(SuggestionChangedError)
    expect(await targetText()).toBe('Meet Thursday 9am')
  })

  it('refuses a thread that is not a suggestion', async () => {
    const {threadId} = await createThread(repo, {targetId: 'B', anchor: anchorFor(MID, 'Thursday'), comment: 'x'})
    await expect(acceptSuggestion(repo, threadId)).rejects.toBeInstanceOf(InvalidSuggestionError)
    expect(await targetText()).toBe(MID)
  })

  it('refuses a replacement on a whole-block thread, which has no quote to replace', async () => {
    const {threadId} = await createThread(repo, {targetId: 'B', anchor: null, comment: 'x'})
    await repo.tx(tx => tx.setProperty(threadId, annotationReplacementProp, 'Whole new text'), opts)
    await expect(acceptSuggestion(repo, threadId)).rejects.toBeInstanceOf(InvalidSuggestionError)
    expect(await targetText()).toBe(MID)
  })

  it('refuses a block that is not a thread root', async () => {
    await expect(acceptSuggestion(repo, 'B')).rejects.toThrow('Thread B is missing or deleted.')
  })

  it('refuses a property row as the target, whose content is an encoded value', async () => {
    await db.db.execute(`INSERT INTO workspaces
      (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
      VALUES (?, 'Test', 'alex', 1, 1, 'none', NULL, 'children')`, [WS])
    await repo.tx(tx => tx.setProperty('B', annotationQuotePrefixProp, 'a value'), opts)
    const fieldId = propertyDefinitionBlockId(WS, annotationQuotePrefixProp.seedKey)
    const field = await db.db.get<{id: string}>(
      'SELECT id FROM blocks WHERE parent_id = ? AND content = ? AND deleted = 0', ['B', propertyFieldContent(fieldId)])
    const value = await db.db.get<{id: string; content: string}>(
      'SELECT id, content FROM blocks WHERE parent_id = ? AND deleted = 0', [field.id])
    // Pointed there by hand, quoting the whole value exactly: creation refuses
    // a property row as a target.
    const threadId = await suggest('Thursday', 'Thursday 9am')
    await repo.tx(async tx => {
      await tx.setProperty(threadId, annotationTargetProp, value.id)
      await tx.update(threadId, {content: value.content})
      await tx.setProperty(threadId, annotationQuoteStartProp, 0)
      await tx.setProperties(threadId, {unset: [annotationQuotePrefixProp, annotationQuoteSuffixProp]})
    }, opts)
    expect(resolveAnchor(value.content, threadAnchorOf(await rootOf(threadId)) as RangeAnchor).state).toBe('exact')

    await expect(acceptSuggestion(repo, threadId)).rejects.toBeInstanceOf(UnannotatableTargetError)
    expect((await repo.load(value.id))!.content).toBe(value.content)
  })
})

describe('rejecting', () => {
  it('only closes the thread', async () => {
    const threadId = await suggest('Thursday', 'Thursday 9am')
    await setThreadStatus(repo, threadId, 'rejected')
    expect(threadStatusOf(await rootOf(threadId))).toBe('rejected')
    expect(threadIsOpen(await rootOf(threadId))).toBe(false)
    expect(await targetText()).toBe(MID)
  })
})
