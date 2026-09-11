// @vitest-environment node
/**
 * Opening a day whose name another page already owns, and restoring a
 * tombstoned one.
 *
 * Every failure here is `alias.sync` reacting to what the create/restore paths
 * write, so the repo is built with `aliasDataExtension` installed —
 * `dailyNotes.test.ts` ran without it until recently, and a repro of the
 * restore-rename bug PASSES against a repo where that processor is absent.
 * Kept as its own file because these are all one scenario (a contested name)
 * rather than more coverage of the get-or-create contract.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
  dailyNoteIso,
  dailyNotesDataExtension,
  getOrCreateDailyNote,
} from '@/plugins/daily-notes'
import { dailyNoteDateProp } from '@/plugins/daily-notes/schema.js'

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
afterEach(() => { vi.restoreAllMocks() })

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

/** A sync-shaped row: raw insert, so the uniqueness trigger's `WHEN` guard
 *  skips it and co-claims are possible. Still maintains `block_aliases`. */
const rawRow = async (id: string, content: string, aliases: string[]): Promise<void> => {
  await sharedDb.db.execute(
    `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json,
      references_json, created_at, updated_at, user_updated_at, created_by, updated_by, deleted)
     VALUES (?, ?, NULL, ?, ?, ?, '[]', 1, 1, 1, 'u', 'u', 0)`,
    [id, WS, `k-${id}`, content, JSON.stringify({[aliasesProp.name]: aliases})],
  )
}

/** A live page holding `alias`, created before the day is ever opened. */
const squatterOwning = async (alias: string): Promise<void> => {
  await repo.tx(async tx => {
    await tx.create({id: 'squatter', workspaceId: WS, parentId: null, orderKey: 'a', content: 'Notes'})
    await tx.setProperty('squatter', aliasesProp, [alias])
  }, {scope: ChangeScope.BlockDefault})
}

describe('reading a day\'s identity', () => {
  it('ignores a date field on a page that is not the day it names', async () => {
    // `daily-note:date` is globally registered, so any block can adopt it
    // through the "+ Field" picker. Trusting it on a block whose id is not the
    // derived one for that day hands an ordinary page the date arrows, and
    // makes global prev/next step relative to whatever it holds.
    await repo.tx(async tx => {
      await tx.create({id: 'ordinary', workspaceId: WS, parentId: null, orderKey: 'a',
        content: 'Some page'})
      await tx.setProperty('ordinary', dailyNoteDateProp, new Date(`${ISO}T00:00:00Z`))
    }, {scope: ChangeScope.BlockDefault})
    const block = await repo.load('ordinary')

    expect(dailyNoteIso({
      id: 'ordinary', workspaceId: WS,
      date: dailyNoteDateProp.codec.decode(block!.properties[dailyNoteDateProp.name]),
      aliases: [],
    })).toBeNull()
  })

  it('opens a day that co-claims one of its names with another live block', async () => {
    // The alias trigger deletes and re-inserts the row's WHOLE bag on any
    // properties write, so a name the row already shares with another live
    // block aborts the repair — and with it the navigation that opened the
    // day. Skipping the repair leaves the row unrepaired but reachable.
    const id = dailyNoteBlockId(WS, ISO)
    await rawRow(id, LONG, [ISO, 'Dup'])
    await rawRow('other', 'Other', ['Dup'])

    await expect(getOrCreateDailyNote(repo, WS, ISO)).resolves.toBeDefined()
    expect(await repo.load(id)).not.toBeNull()
  })

  it('reports rather than handing a viewer a day that does not exist', async () => {
    // The read-only short-circuit must not answer for a row that was never
    // created: `todayDailyNoteLanding` would return the deterministic id and
    // bootstrap would open a panel on a missing block, which the
    // `WorkspaceLandingResolver` contract calls out by name as a bug.
    vi.spyOn(repo, 'isReadOnly', 'get').mockReturnValue(true)

    await expect(getOrCreateDailyNote(repo, WS, ISO)).rejects.toThrow()
    expect(await repo.load(dailyNoteBlockId(WS, ISO))).toBeNull()
  })

  it('opens a contested day for a viewer instead of failing to repair it', async () => {
    // A day that yielded a canonical alias leaves `needsRepair` true on every
    // later call. Without a read-only short-circuit the repair transaction
    // throws `ReadOnlyError` and the viewer cannot open the page at all.
    await squatterOwning(LONG)
    const note = await getOrCreateDailyNote(repo, WS, ISO)
    vi.spyOn(repo, 'isReadOnly', 'get').mockReturnValue(true)

    await expect(getOrCreateDailyNote(repo, WS, ISO)).resolves.toBeDefined()
    expect(await repo.load(note.id)).not.toBeNull()
  })
})

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
  it('opens a day whose title the user had cleared', async () => {
    // Filling an EMPTY title is not a rename, and was still fatal: it makes
    // `alias.sync` rule 2 append the label as a fresh alias, going around the
    // partition entirely, so a page already holding that name aborts the whole
    // tx and the day stays tombstoned on every retry. Restore writes no content
    // at all now.
    const id = dailyNoteBlockId(WS, ISO)
    await getOrCreateDailyNote(repo, WS, ISO)
    await repo.tx(tx => tx.update(id, {content: ''}), {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.delete(id), {scope: ChangeScope.BlockDefault})
    await squatterOwning(LONG)

    await getOrCreateDailyNote(repo, WS, ISO)

    expect(await repo.load(id)).not.toBeNull()
    expect(await aliasesOf(id)).toEqual([ISO])
  })

  it('keeps a title and a custom alias the user gave the day', async () => {
    // Replacing the alias bag rather than merging it makes the diff a 1-for-1
    // swap, which `alias.sync` rule 3 reads as a rename and follows by
    // rewriting content — losing the user's title, their custom name, and
    // re-keying every `[[Sprint Day]]` link through `renameBacklinks`.
    const id = dailyNoteBlockId(WS, ISO)
    await getOrCreateDailyNote(repo, WS, ISO)
    await repo.tx(tx => tx.update(id, {content: 'Sprint Day'}), {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.delete(id), {scope: ChangeScope.BlockDefault})

    await getOrCreateDailyNote(repo, WS, ISO)

    expect((await repo.load(id))?.content).toBe('Sprint Day')
    expect(await aliasesOf(id)).toEqual(expect.arrayContaining(['Sprint Day', ISO, LONG]))
  })

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
