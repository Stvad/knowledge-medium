// @vitest-environment node
/**
 * The daily-notes UI deletion guard. Deleting a get-or-create page never
 * sticks (revisiting the date restores the row) but DOES discard the subtree,
 * so the gesture looks broken while destroying content — refuse it instead.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { addBlockTypeToProperties, aliasesProp } from '@/data/properties'
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

  it('still guards the canonical Journal after it gains another type', async () => {
    // The resolver applies adoption guards only to NON-fallback claimants, so
    // the canonical row keeps resolving whatever else it carries. A predicate
    // narrower than the resolver lets the UI delete the real Journal — the
    // delete cascades through every daily note, and the next get-or-create
    // restores only the root, so the contents are simply gone.
    const journal = await getOrCreateJournalBlock(repo, WS)
    await repo.tx(async tx => {
      const row = await tx.get(journal.id)
      await tx.update(journal.id, {
        properties: addBlockTypeToProperties({...row!.properties}, 'some-composed-identity'),
      })
    }, {scope: ChangeScope.BlockDefault})
    await repo.block(journal.id).load()

    expect(await dailyNotesDeletionGuard(repo.block(journal.id))).toMatch(/Journal/)
  })

  it('allows deleting a typed block that merely claims the Journal alias', async () => {
    // Adoption refuses a claimant carrying another identity, so this block is
    // NOT the Journal and never will be. Recognising it by the alias alone made
    // the UI refuse the delete and blame the Journal for it — for a block the
    // resolver would never adopt.
    await repo.tx(async tx => {
      await tx.create({
        id: 'todo-ish', workspaceId: WS, parentId: null, orderKey: 'b0', content: 'Journal',
        properties: addBlockTypeToProperties(
          {[aliasesProp.name]: aliasesProp.codec.encode(['Journal'])},
          'some-other-identity',
        ),
      })
    }, {scope: ChangeScope.BlockDefault})
    await repo.block('todo-ish').load()

    expect(await dailyNotesDeletionGuard(repo.block('todo-ish'))).toBeNull()
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
