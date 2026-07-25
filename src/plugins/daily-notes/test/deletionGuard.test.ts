// @vitest-environment node
/**
 * The daily-notes UI deletion guard. Deleting a get-or-create page never
 * sticks (revisiting the date restores the row) but DOES discard the subtree,
 * so the gesture looks broken while destroying content — refuse it instead.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import {
  dailyNotesDataExtension,
  getOrCreateDailyNote,
  getOrCreateJournalBlock,
  todayIso,
} from '@/plugins/daily-notes'
import { typesProp } from '@/data/properties'
import { dailyNoteDateProp } from '../schema.ts'
import { dailyNoteDateValue } from '../dailyNotes.ts'
import { dailyNotesDeletionGuard } from '../deletionGuard.ts'

const WS = 'ws-1'
let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    extensions: [dailyNotesDataExtension],
  }).repo
  repo.setActiveWorkspaceId(WS)
})

describe('dailyNotesDeletionGuard', () => {
  it('refuses a daily note', async () => {
    const note = await getOrCreateDailyNote(repo, WS, todayIso())
    expect(await dailyNotesDeletionGuard(note)).toMatch(/Daily notes/)
  })

  it('refuses the Journal', async () => {
    const journal = await getOrCreateJournalBlock(repo, WS)
    expect(await dailyNotesDeletionGuard(journal)).toMatch(/Journal/)
  })

  it('recognises a note by either signal, since neither is immutable', async () => {
    // Either signal suffices, because neither is immutable: dropping the type
    // chip leaves the id-from-date derivation, and editing the date leaves the
    // chip. Only stripping both gives up protection.
    const note = await getOrCreateDailyNote(repo, WS, todayIso())
    await note.set(typesProp, [])
    expect(await dailyNotesDeletionGuard(note)).toMatch(/Daily notes/)

    const dated = await getOrCreateDailyNote(repo, WS, todayIso())
    await dated.set(dailyNoteDateProp, dailyNoteDateValue('1999-01-01'))
    expect(await dailyNotesDeletionGuard(dated)).toMatch(/Daily notes/)

    await repo.tx(async tx => {
      await tx.create({id: 'impostor', workspaceId: WS, parentId: null, orderKey: 'b0', content: 'x'})
    }, {scope: ChangeScope.BlockDefault})
    const impostor = repo.block('impostor')
    await impostor.load()
    await impostor.set(dailyNoteDateProp, dailyNoteDateValue(todayIso()))
    // Not at its derived address and not tagged: not a daily note.
    expect(await dailyNotesDeletionGuard(impostor)).toBeNull()
  })

  it('allows an ordinary page, including a child of a daily note', async () => {
    const note = await getOrCreateDailyNote(repo, WS, todayIso())
    await repo.mutate.createChild({parentId: note.id, id: 'kid', content: 'kid'})
    await repo.tx(async tx => {
      await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'page'})
    }, {scope: ChangeScope.BlockDefault})
    await repo.block('page').load()

    expect(await dailyNotesDeletionGuard(repo.block('kid'))).toBeNull()
    expect(await dailyNotesDeletionGuard(repo.block('page'))).toBeNull()
  })
})
