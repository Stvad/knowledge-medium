// @vitest-environment node
/**
 * Restoring a tombstoned daily note, with `alias.sync` actually installed.
 *
 * The rest of `dailyNotes.test.ts` builds its repo with
 * `[dailyNotesDataExtension]` alone, so the same-tx processor that reconciles
 * content against aliases never runs there — and the two bugs below are
 * entirely that processor reacting to the restore branch's content rewrite.
 * A repro against that harness passes with the bugs present, which is why this
 * file exists separately rather than as more cases in it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { aliasesProp } from '@/data/properties'
import { PAGE_TYPE } from '@/data/blockTypes'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { aliasDataExtension } from '@/plugins/alias/dataExtension.js'
import { referencesDataExtension } from '@/plugins/references/dataExtension.js'
import {
  dailyNoteBlockId,
  dailyNotesDataExtension,
  getOrCreateDailyNote,
} from '@/plugins/daily-notes'

const WS = 'ws-1'
const ISO = '2026-04-28'
const LONG = 'April 28th, 2026'

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    extensions: [dailyNotesDataExtension, aliasDataExtension, referencesDataExtension],
  }).repo
  repo.setActiveWorkspaceId(WS)
})

/** The shape `ensureDailyNoteTarget` leaves behind when a `[[2026-04-28]]`
 *  wikilink resolves before anyone opens the day: content IS the ISO text,
 *  claiming the ISO alias, parked at workspace root. Then tombstoned. */
const tombstonedSeat = async (): Promise<string> => {
  const id = dailyNoteBlockId(WS, ISO)
  await repo.tx(async tx => {
    await tx.create({id, workspaceId: WS, parentId: null, orderKey: 'z', content: ISO})
    await tx.setProperty(id, aliasesProp, [ISO])
    await repo.addTypeInTx(tx, id, PAGE_TYPE, {}, repo.snapshotTypeRegistries())
  }, {scope: ChangeScope.BlockDefault})
  await repo.tx(tx => tx.delete(id), {scope: ChangeScope.BlockDefault})
  return id
}

const aliasesOf = async (id: string): Promise<readonly string[]> => {
  const block = await repo.load(id)
  const encoded = block?.properties[aliasesProp.name]
  return encoded === undefined ? [] : aliasesProp.codec.decode(encoded)
}

/** A live page holding `alias`, created before the day is ever opened. */
const squatterOwning = async (alias: string): Promise<void> => {
  await repo.tx(async tx => {
    await tx.create({id: 'squatter', workspaceId: WS, parentId: null, orderKey: 'a', content: 'Notes'})
    await tx.setProperty('squatter', aliasesProp, [alias])
  }, {scope: ChangeScope.BlockDefault})
}

describe('opening a day whose name another page owns', () => {
  it('creates the day rather than dying on the contested name', async () => {
    // #378 for daily notes: the page is minted in the same transaction that
    // claims its aliases, so the collision rollback destroys it and the next
    // call repeats — the day is permanently unopenable.
    await squatterOwning(LONG)

    const note = await getOrCreateDailyNote(repo, WS, ISO)

    expect(note.id).toBe(dailyNoteBlockId(WS, ISO))
    expect(await repo.load(note.id)).not.toBeNull()
    expect(await aliasesOf(note.id)).toEqual([ISO])
  })

  it('repairs a live day without fighting for a name it lost', async () => {
    // Repair runs on every navigation to the day. With the name gone to
    // another page, an unconditional re-claim aborts the transaction the
    // navigation is riding on, so the day cannot be opened at all.
    const note = await getOrCreateDailyNote(repo, WS, ISO)
    await repo.tx(tx => tx.setProperty(note.id, aliasesProp, [ISO]),
      {scope: ChangeScope.BlockDefault})
    await squatterOwning(LONG)

    await getOrCreateDailyNote(repo, WS, ISO)

    expect(await aliasesOf(note.id)).toEqual([ISO])
    expect((await repo.load('squatter'))?.properties[aliasesProp.name])
      .toEqual(aliasesProp.codec.encode([LONG]))
  })
})

describe('restoring a tombstoned daily-note seat', () => {
  it('keeps the ISO alias the date is addressed by', async () => {
    // Rewriting content on restore reads to `alias.sync` as a rename: the old
    // content is still in the alias list, so rule 1 replaces that entry with
    // the new content and the two aliases collapse to one. The day is then
    // unreachable by `[[2026-04-28]]` until something re-claims it.
    const id = await tombstonedSeat()

    await getOrCreateDailyNote(repo, WS, ISO)

    expect(await aliasesOf(id)).toEqual(expect.arrayContaining([ISO, LONG]))
  })

  it('opens the day even when another page owns its long-form name', async () => {
    // The original bug through a different door. The restore claims the
    // long-form label; a live page already holding it trips the uniqueness
    // trigger, the whole transaction rolls back, the row stays tombstoned —
    // and every retry repeats, so the day is permanently unopenable.
    const id = await tombstonedSeat()
    await squatterOwning(LONG)

    await getOrCreateDailyNote(repo, WS, ISO)

    const restored = await repo.load(id)
    expect(restored).not.toBeNull()
    // Yielded the contested name rather than fighting for it; the ISO alias —
    // the one the date is actually addressed by — is still this page's.
    expect(await aliasesOf(id)).toContain(ISO)
    expect((await repo.load('squatter'))?.properties[aliasesProp.name])
      .toEqual(aliasesProp.codec.encode([LONG]))
  })
})
