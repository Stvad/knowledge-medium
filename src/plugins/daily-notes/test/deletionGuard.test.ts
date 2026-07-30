// @vitest-environment node
/**
 * The daily-notes UI deletion guard. Deleting a get-or-create page never
 * sticks (revisiting the date restores the row) but DOES discard the subtree,
 * so the gesture looks broken while destroying content — refuse it instead.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { aliasesProp } from '@/data/properties'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import {
  dailyNotesDataExtension,
  getOrCreateDailyNote,
  getOrCreateJournalBlock,
  todayIso,
} from '@/plugins/daily-notes'
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

  it('refuses an ADOPTED Journal at a non-canonical id (issue #378)', async () => {
    // The canonical Journal is deleted, then the user aliases a different
    // page 'Journal' — getOrCreateJournalBlock ADOPTS it (see
    // dailyNotes.ts), so the deletion guard must recognise THAT block as
    // the Journal too, not just the deterministic-id row it used to live
    // at (an id-based check would silently stop protecting it).
    const journal = await getOrCreateJournalBlock(repo, WS)
    await repo.tx(async tx => { await tx.delete(journal.id) }, {scope: ChangeScope.BlockDefault})
    await repo.tx(async tx => {
      await tx.create({id: 'claimant', workspaceId: WS, parentId: null, orderKey: 'z0', content: 'My Journal'})
      await tx.setProperty('claimant', aliasesProp, ['Journal'])
    }, {scope: ChangeScope.BlockDefault})

    const adopted = await getOrCreateJournalBlock(repo, WS)
    expect(adopted.id).toBe('claimant')
    expect(adopted.id).not.toBe(journal.id)
    expect(await dailyNotesDeletionGuard(adopted)).toMatch(/Journal/)
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
