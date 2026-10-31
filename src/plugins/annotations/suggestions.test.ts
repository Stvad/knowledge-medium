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
import {confirmedAnchor, reanchorThread} from './reanchor'
import {acceptSuggestion, appliedContent, rejectSuggestion} from './suggestions'
import {AnchorChangedError, createThread, InvalidSuggestionError, setThreadStatus, UnannotatableTargetError} from './threads'

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
  await repo.tx(tx => tx.create({id: 'B', workspaceId: WS, parentId: null, orderKey: 'a0', content: MID}), opts)
})

const setTarget = (content: string) => repo.tx(tx => tx.update('B', {content}), opts)

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

  it('refuses an empty replacement, one that changes nothing, and one that cuts a character in half', async () => {
    await expect(suggest('Thursday', '')).rejects.toBeInstanceOf(InvalidSuggestionError)
    await expect(suggest('Thursday', 'Thursday')).rejects.toBeInstanceOf(InvalidSuggestionError)
    await expect(suggest('Thursday', 'Thu\ud83d')).rejects.toBeInstanceOf(InvalidSuggestionError)
  })

  it('stays a suggestion when re-anchored: anchoring it to the whole block is refused', async () => {
    const threadId = await suggest('Thursday', 'Thursday 9am')
    await expect(reanchorThread(repo, threadId, null)).rejects.toBeInstanceOf(InvalidSuggestionError)
    expect((await rootOf(threadId)).content).toBe('Thursday')
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
    await expect(acceptSuggestion(repo, threadId)).rejects.toBeInstanceOf(AnchorChangedError)
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

    await expect(acceptSuggestion(repo, duplicate)).rejects.toBeInstanceOf(AnchorChangedError)
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

  // Confirm position puts a copy's anchor back on the applied text, where it
  // is exact again; the text itself still says it was applied.
  it.each([
    ['appends to the quote', 'Meet Thursday at noon', 'Thursday 9am', 'Meet Thursday 9am at noon'],
    ['prefixes the quote', 'Meet Thursday at noon', 'next Thursday', 'Meet next Thursday at noon'],
  ])('refuses a copy re-anchored onto applied text, where the replacement %s', async (_, before, replacement, after) => {
    await setTarget(before)
    const first = await suggest('Thursday', replacement)
    const duplicate = await suggest('Thursday', replacement)
    await acceptSuggestion(repo, first)
    expect(await targetText()).toBe(after)
    const confirmed = confirmedAnchor(after, threadAnchorOf(await rootOf(duplicate)) as RangeAnchor)!
    await reanchorThread(repo, duplicate, confirmed)

    await expect(acceptSuggestion(repo, duplicate)).rejects.toThrow('already reads as this suggestion')
    expect(await targetText()).toBe(after)
  })

  it('refuses a suggestion that is no longer open, as a card on another device may still offer it', async () => {
    const threadId = await suggest('Thursday', 'Thursday 9am')
    await rejectSuggestion(repo, threadId)
    await expect(acceptSuggestion(repo, threadId)).rejects.toBeInstanceOf(InvalidSuggestionError)
    expect(await targetText()).toBe(MID)
    expect(threadStatusOf(await rootOf(threadId))).toBe('rejected')
  })

  it('refuses a change that would turn the target into a property field row', async () => {
    await setTarget('oops')
    const threadId = await suggest('oops', '::((3f2a9c1d-0000-4000-8000-00000000f1e1))')
    await expect(acceptSuggestion(repo, threadId)).rejects.toBeInstanceOf(InvalidSuggestionError)
    expect(await targetText()).toBe('oops')
  })

  it('refuses the same suggestion reopened after it was applied', async () => {
    await setTarget('Meet Thursday')
    const threadId = await suggest('Thursday', 'Thursday 9am')
    await acceptSuggestion(repo, threadId)
    await setThreadStatus(repo, threadId, 'open')
    await expect(acceptSuggestion(repo, threadId)).rejects.toBeInstanceOf(AnchorChangedError)
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

  it('re-checks a replacement set by hand, which skipped creation\'s checks', async () => {
    const threadId = await suggest('Thursday', 'Thursday 9am')
    await repo.tx(tx => tx.setProperty(threadId, annotationReplacementProp, 'Thu\ud800'), opts)
    await expect(acceptSuggestion(repo, threadId)).rejects.toThrow('cuts a character in half')
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

describe('appliedContent', () => {
  it('refuses a change after which the quote still sits between the same windows, though the text does not read as it yet', () => {
    // The replacement copies the 16 characters after the quote, then differs.
    const content = 'Ship it. The vendor slipped badly.'
    const anchor = anchorFor(content, 'Ship it.')
    const resolved = {from: 0, to: anchor.quote.length}
    expect(() => appliedContent(content, resolved, anchor, 'Ship it. The vendor slipped twice.')).toThrow('could not be told from')
    expect(appliedContent(content, resolved, anchor, 'Ship it now.')).toBe('Ship it now. The vendor slipped badly.')
  })
})

describe('rejectSuggestion', () => {
  it('only closes the thread', async () => {
    const threadId = await suggest('Thursday', 'Thursday 9am')
    await rejectSuggestion(repo, threadId)
    expect(threadStatusOf(await rootOf(threadId))).toBe('rejected')
    expect(threadIsOpen(await rootOf(threadId))).toBe(false)
    expect(await targetText()).toBe(MID)
  })

  it('refuses a suggestion accepted meanwhile, so its status never contradicts the applied text', async () => {
    const threadId = await suggest('Thursday', 'Thursday 9am')
    // Both clicks queued: accept lands first on the write lock.
    const [accepted, rejected] = await Promise.allSettled([acceptSuggestion(repo, threadId), rejectSuggestion(repo, threadId)])
    expect(accepted.status).toBe('fulfilled')
    expect(rejected).toMatchObject({status: 'rejected', reason: expect.any(InvalidSuggestionError)})
    expect(threadStatusOf(await rootOf(threadId))).toBe('accepted')
  })
})
