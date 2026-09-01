// @vitest-environment happy-dom
//
// What is pinned here is the fallback taken when a Readwise title is already a
// page name — the case that aborts the claiming transaction. The document is
// written regardless, under a suffixed alias so it stays linkable, with its
// CONTENT still the real title, which is what leaves it in the state
// `DuplicateNameBanner` reads. The last group drives that banner for real, so
// "and then offer a merge" is pinned as an offer the user can actually take
// rather than as copy nobody exercises.
//
// Wire-level constants are spelled out rather than imported: they are what sits
// in the user's DB, and pinning them is the point.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ChangeScope } from '@/data/api/index.js'
import type { BlockData } from '@/data/api'
import type { Repo } from '@/data/repo.js'
import { RepoContext } from '@/context/repo.js'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb.js'
import { createTestRepo } from '@/data/test/createTestRepo.js'
import { aliasesProp, getBlockTypes } from '@/data/properties.js'
import { PAGE_TYPE } from '@/data/blockTypes.js'
import { pluginBlockId } from '@/extensions/pluginIds.js'
import { aliasDataExtension } from '@/plugins/alias/dataExtension.js'
import { DuplicateNameBanner } from '@/plugins/alias/DuplicateNameBanner.js'
import { dailyNotesDataExtension } from '@/plugins/daily-notes/dataExtension.js'
import { referencesDataExtension } from '@/plugins/references/dataExtension.js'
import type { AppExtension } from '@/facets/facet.js'

import readwiseContributions, {
  acceptFallbackAlias, ensureRoot, syncBookToBlocks, unresolvedAliasConflicts,
} from './readwise.tsx'

const READWISE_NS = '45fb169f-ffac-458b-b2a7-6cec87d2d7ee'
const DOCUMENT_TYPE = 'readwise-document'
const WS = 'ws-1'
const REVIEW_DATE = '2026-08-24'

const readwiseDataAndUi = readwiseContributions
  // `'facet' in c` also drops the nested AppExtension arrays (the dialog host),
  // which is what these suites want: they exclude every app mount anyway.
  .filter(c => 'facet' in (c as object)
    && !['core.app-mounts', 'core.app-effects'].includes((c as any).facet.id)) as unknown as AppExtension[]

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
afterEach(() => { cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({
    db: sharedDb.db,
    extensions: [
      aliasDataExtension,
      // Rename backlinks are part of what a re-title has to keep doing —
      // see the uncontested-rename case below.
      referencesDataExtension,
      dailyNotesDataExtension,
      ...readwiseDataAndUi,
    ],
  }).repo
  repo.setActiveWorkspaceId(WS)
  nextRootKey = 0
})

const documentId = (userBookId: number) =>
  pluginBlockId(WS, READWISE_NS, `book:${userBookId}`)

const book = (userBookId: number, title: string, highlightId: number) => ({
  user_book_id: userBookId,
  title,
  author: 'Cal Newport',
  highlights: [{id: highlightId, text: 'Deep work is valuable.'}],
})

/** The Readwise root documents are parented under. Minted directly rather than
 *  through `ensureRoot`, which is `runSync`'s business and not under test. */
const createRoot = async (): Promise<string> => {
  const rootId = pluginBlockId(WS, READWISE_NS, 'library-root')
  await repo.tx(
    tx => tx.create({id: rootId, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Readwise Library'}),
    {scope: ChangeScope.BlockDefault},
  )
  return rootId
}

/** Workspace-root order keys have to be real fractional indices: `ensureRoot`
 *  computes a key after the last of them. */
let nextRootKey = 0

/** A page the user already has, holding `name` as its alias. */
const createRivalPage = async (id: string, name: string): Promise<void> => {
  const orderKey = `a${++nextRootKey}`
  await repo.tx(async tx => {
    await tx.create({id, workspaceId: WS, parentId: null, orderKey, content: name})
    await tx.setProperty(id, aliasesProp, [name])
    await repo.addTypeInTx(tx, id, PAGE_TYPE, {}, repo.snapshotTypeRegistries())
  }, {scope: ChangeScope.BlockDefault})
}

/** A second live claimant of a name another block already holds, landed the way
 *  sync apply lands one. `repo.tx` cannot produce this — the uniqueness trigger
 *  rejects it — but that trigger skips sync-applied rows, and a raw insert is
 *  the same shape and still maintains `block_aliases`. `createdAt` is what
 *  decides which row `aliasLookup` returns, so it is the whole point here:
 *  a co-claimant YOUNGER than the document is the one the single-row form
 *  hides. Same recipe as `coClaimRaw` in the alias plugin's merge tests. */
const LATE = 4_000_000_000_000

const coClaimRaw = async (id: string, name: string, createdAt: number): Promise<void> => {
  await sharedDb.db.execute(
    `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json,
      references_json, created_at, updated_at, user_updated_at, created_by, updated_by, deleted)
     VALUES (?, ?, NULL, ?, ?, ?, '[]', ?, ?, ?, 'u', 'u', 0)`,
    [id, WS, `k-${id}`, name, JSON.stringify({[aliasesProp.name]: aliasesProp.codec.encode([name])}),
      createdAt, createdAt, createdAt],
  )
}

const sync = (rootId: string, record: ReturnType<typeof book>) =>
  syncBookToBlocks(repo, WS, rootId, record, '{title}', '', '{text}', [], [], [], REVIEW_DATE)

const aliasesOf = (data: BlockData | null): readonly string[] =>
  data === null ? [] : aliasesProp.codec.decode(data.properties[aliasesProp.name])

const claimantIdsOf = async (alias: string): Promise<string[]> =>
  repo.tx(
    async tx => (await tx.aliasClaimants(alias, WS)).map(row => row.id),
    {scope: ChangeScope.BlockDefault},
  )

describe('readwise document alias — nothing in the way', () => {
  it('claims the exact title', async () => {
    const rootId = await createRoot()
    await sync(rootId, book(1, 'Deep Work', 11))

    const doc = await repo.load(documentId(1))
    expect(doc?.content).toBe('Deep Work')
    expect(aliasesOf(doc)).toEqual(['Deep Work'])
    expect(getBlockTypes(doc!)).toContain(DOCUMENT_TYPE)
  })
})

describe('readwise document alias — an ordinary re-title', () => {
  it('carries `[[links]]` to the old title across', async () => {
    const rootId = await createRoot()
    await sync(rootId, book(1, 'Deep Work', 11))
    await repo.tx(
      tx => tx.create({
        id: 'mention', workspaceId: WS, parentId: null, orderKey: 'a9',
        content: 'reading [[Deep Work]] again',
      }),
      {scope: ChangeScope.BlockDefault},
    )

    await sync(rootId, book(1, 'Digital Minimalism', 11))

    // The alias travels with the title through `alias.sync` rule 1, which is
    // what `references.renameBacklinks` reacts to. Releasing the name on every
    // re-title — rather than only on a contested one — routes around both, and
    // this mention would still read `[[Deep Work]]`, pointing nowhere.
    expect((await repo.load('mention'))?.content).toBe('reading [[Digital Minimalism]] again')
    expect(aliasesOf(await repo.load(documentId(1)))).toEqual(['Digital Minimalism'])
  })
})

describe('readwise library root', () => {
  it('yields its name rather than aborting the sync that needs it', async () => {
    await createRivalPage('rival', 'Readwise Library')

    const rootId = await ensureRoot(repo, WS)

    // The root is reached by its deterministic id, so losing the name costs it
    // nothing — and claiming it would abort the transaction, which happens
    // before the first book and would take the whole run with it.
    expect(aliasesOf(await repo.load(rootId))).toEqual([])
    expect(await claimantIdsOf('Readwise Library')).toEqual(['rival'])
  })

  it('survives an alias write the uniqueness trigger refuses', async () => {
    await createRivalPage('rival', 'Readwise Library')
    const rootId = await ensureRoot(repo, WS)

    // A name on the root that a sync-applied row also holds. The reclaim below
    // rewrites the WHOLE bag, so this entry goes back in under the trigger and
    // is refused — and `ensureRoot` runs ahead of the per-book isolation, so an
    // escaping throw would cost every book in the export.
    await repo.tx(
      tx => tx.setProperty(rootId, aliasesProp, ['My Library']),
      {scope: ChangeScope.BlockDefault},
    )
    await coClaimRaw('synced-rival', 'My Library', LATE)
    await repo.tx(
      tx => tx.setProperty('rival', aliasesProp, []),
      {scope: ChangeScope.BlockDefault},
    )

    await expect(ensureRoot(repo, WS)).resolves.toBe(rootId)
    expect(aliasesOf(await repo.load(rootId))).toEqual(['My Library'])
  })

  it('takes its name back once the conflict clears', async () => {
    await createRivalPage('rival', 'Readwise Library')
    const rootId = await ensureRoot(repo, WS)
    expect(aliasesOf(await repo.load(rootId))).toEqual([])

    await repo.tx(
      tx => tx.setProperty('rival', aliasesProp, []),
      {scope: ChangeScope.BlockDefault},
    )
    await ensureRoot(repo, WS)

    expect(aliasesOf(await repo.load(rootId))).toEqual(['Readwise Library'])
  })
})

describe('readwise document alias — the title is already a page name', () => {
  it('writes the document under a suffixed alias instead of failing', async () => {
    const rootId = await createRoot()
    await createRivalPage('rival', 'Deep Work')

    await expect(sync(rootId, book(1, 'Deep Work', 11))).resolves.toBeUndefined()

    const doc = await repo.load(documentId(1))
    // Content is the REAL title: that is what `DuplicateNameBanner` keys on, and
    // what `alias.mergeCollision` requires of a page reclaiming its name.
    expect(doc?.content).toBe('Deep Work')
    expect(aliasesOf(doc)).toEqual(['Deep Work (Readwise)'])
    // Nothing was taken from the page that had the name.
    expect(await claimantIdsOf('Deep Work')).toEqual(['rival'])
  })

  it('still writes the highlights', async () => {
    const rootId = await createRoot()
    await createRivalPage('rival', 'Deep Work')
    await sync(rootId, book(1, 'Deep Work', 11))

    expect((await repo.load(pluginBlockId(WS, READWISE_NS, 'hl:11')))?.content)
      .toBe('Deep work is valuable.')
  })

  it('steps past a suffix that is itself taken', async () => {
    const rootId = await createRoot()
    await createRivalPage('rival', 'Deep Work')
    await createRivalPage('rival-2', 'Deep Work (Readwise)')

    await sync(rootId, book(1, 'Deep Work', 11))

    expect(aliasesOf(await repo.load(documentId(1)))).toEqual(['Deep Work (Readwise 2)'])
  })

  it('takes the real title back once the conflict clears', async () => {
    const rootId = await createRoot()
    await createRivalPage('rival', 'Deep Work')
    await sync(rootId, book(1, 'Deep Work', 11))

    await repo.tx(tx => tx.setProperty('rival', aliasesProp, []), {scope: ChangeScope.BlockDefault})
    await sync(rootId, book(1, 'Deep Work', 11))

    expect(aliasesOf(await repo.load(documentId(1)))).toEqual(['Deep Work'])
  })

  it('leaves an alias the user set on the document alone', async () => {
    const rootId = await createRoot()
    await createRivalPage('rival', 'Deep Work')
    await sync(rootId, book(1, 'Deep Work', 11))

    await repo.tx(
      tx => tx.setProperty(documentId(1), aliasesProp, ['My Notes On Deep Work']),
      {scope: ChangeScope.BlockDefault},
    )
    await sync(rootId, book(1, 'Deep Work', 11))

    expect(aliasesOf(await repo.load(documentId(1)))).toEqual(['My Notes On Deep Work'])
  })

  it('leaves a hand-added second fallback name alone', async () => {
    const rootId = await createRoot()
    await createRivalPage('rival', 'Deep Work')
    await sync(rootId, book(1, 'Deep Work', 11))
    expect(aliasesOf(await repo.load(documentId(1)))).toEqual(['Deep Work (Readwise)'])

    // Indistinguishable from the sync's own work by SHAPE — it is exactly what
    // the generator emits for slot 2 — and obviously not the sync's by RECORD,
    // which only ever claimed one name.
    await repo.tx(
      tx => tx.setProperty(documentId(1), aliasesProp,
        ['Deep Work (Readwise)', 'Deep Work (Readwise 2)']),
      {scope: ChangeScope.BlockDefault},
    )
    await sync(rootId, book(1, 'Deep Work', 11))

    expect(aliasesOf(await repo.load(documentId(1))))
      .toEqual(['Deep Work (Readwise)', 'Deep Work (Readwise 2)'])
  })

  it('leaves a user alias merely SHAPED like a fallback alone', async () => {
    const rootId = await createRoot()
    await createRivalPage('rival', 'Deep Work')
    await sync(rootId, book(1, 'Deep Work', 11))

    // Past the probe depth, so no sync could have written it. Recognising the
    // shape rather than the generated set would read this as the sync's own and
    // overwrite it.
    await repo.tx(
      tx => tx.setProperty(documentId(1), aliasesProp, ['Deep Work (Readwise 2024)']),
      {scope: ChangeScope.BlockDefault},
    )
    await sync(rootId, book(1, 'Deep Work', 11))

    expect(aliasesOf(await repo.load(documentId(1)))).toEqual(['Deep Work (Readwise 2024)'])
  })

  it('keeps a name it already holds when another row co-claims it', async () => {
    const rootId = await createRoot()
    await sync(rootId, book(1, 'Deep Work', 11))
    expect(aliasesOf(await repo.load(documentId(1)))).toEqual(['Deep Work'])

    // Another device creates its own page of the same name. Sync apply skips
    // the uniqueness trigger, so both rows hold it — the kernel allows this.
    await coClaimRaw('laptop-page', 'Deep Work', LATE)
    await sync(rootId, book(1, 'Deep Work', 11))

    // Re-parking here would rewrite the bag so that the entry equal to the
    // CONTENT disappears, which the kernel reads as a rename: the document
    // would be retitled to `Deep Work (Readwise)` and the real title lost.
    const doc = await repo.load(documentId(1))
    expect(doc?.content).toBe('Deep Work')
    expect(aliasesOf(doc)).toEqual(['Deep Work'])
  })

  it('steps off a fallback another row co-claims', async () => {
    const rootId = await createRoot()
    await createRivalPage('rival', 'Deep Work')
    await sync(rootId, book(1, 'Deep Work', 11))
    expect(aliasesOf(await repo.load(documentId(1)))).toEqual(['Deep Work (Readwise)'])

    // A second row lands on the FALLBACK, younger than the document — so the
    // single-row lookup answers with the document and reports the name free.
    // Dropping a fallback is safe where dropping the title is not: it is not
    // the content, so nothing reads the change as a rename.
    await coClaimRaw('other-device', 'Deep Work (Readwise)', LATE)
    await sync(rootId, book(1, 'Deep Work', 11))

    const doc = await repo.load(documentId(1))
    expect(doc?.content).toBe('Deep Work')
    expect(aliasesOf(doc)).toEqual(['Deep Work (Readwise 2)'])
  })

  it('updates a book whose fallback another row co-claims', async () => {
    const rootId = await createRoot()
    await createRivalPage('rival', 'Deep Work')
    await sync(rootId, book(1, 'Deep Work', 11))
    await coClaimRaw('other-device', 'Deep Work (Readwise)', LATE)

    // A CHANGED managed property is what makes this different from the case
    // above: it forces a properties rewrite, and rewriting the bag re-inserts
    // every alias in it under the uniqueness trigger — including the one the
    // other row co-holds. Unchanged properties write nothing and never trip it.
    await syncBookToBlocks(
      repo, WS, rootId, {...book(1, 'Deep Work', 11), author: 'C. Newport'},
      '{title}', '', '{text}', [], [], [], REVIEW_DATE,
    )

    // The book has to land. Failing it would pin `lastSyncedAt` behind a book
    // that fails identically on every retry.
    const doc = await repo.load(documentId(1))
    expect(doc?.content).toBe('Deep Work')
    expect(doc?.properties['readwise:author']).toBeDefined()
    expect(aliasesOf(doc)).toEqual(['Deep Work (Readwise 2)'])
  })

  it('keeps the fallback when the book update fails after releasing it', async () => {
    const rootId = await createRoot()
    await createRivalPage('rival', 'Deep Work')
    await sync(rootId, book(1, 'Deep Work', 11))
    // A free alias of the user's alongside the sync's own, so the release below
    // leaves a writable bag and actually commits.
    await repo.tx(
      tx => tx.setProperty(documentId(1), aliasesProp, ['Deep Work (Readwise)', 'My Notes']),
      {scope: ChangeScope.BlockDefault},
    )
    await coClaimRaw('other-device', 'Deep Work (Readwise)', LATE)

    // Readwise re-titles the book onto a name a page already holds. The release
    // succeeds, and the content rewrite then fails: A3 appends the new content
    // to the bag, and appending a contested name is refused.
    await createRivalPage('rival-2', 'Digital Minimalism')
    await expect(sync(rootId, book(1, 'Digital Minimalism', 11))).rejects.toThrow()

    // The release has to go down with the write that made it necessary.
    // Committed separately it leaves the document holding neither name.
    expect(aliasesOf(await repo.load(documentId(1)))).toEqual(['Deep Work (Readwise)', 'My Notes'])
  })

  it('ignores a keep for a conflict that cleared while the dialog was open', async () => {
    const rootId = await createRoot()
    await createRivalPage('rival', 'Deep Work')
    await sync(rootId, book(1, 'Deep Work', 11))
    expect(aliasesOf(await repo.load(documentId(1)))).toEqual(['Deep Work (Readwise)'])

    // The rival gives the name up and a sync takes it back, all while the dialog
    // still shows the collision. The title on screen is still correct — what is
    // gone is the conflict.
    await repo.tx(
      tx => tx.setProperty('rival', aliasesProp, []),
      {scope: ChangeScope.BlockDefault},
    )
    await sync(rootId, book(1, 'Deep Work', 11))
    expect(aliasesOf(await repo.load(documentId(1)))).toEqual(['Deep Work'])

    await acceptFallbackAlias(repo, documentId(1), 'Deep Work', WS)

    // Recording it would park an acceptance on `Deep Work` and silence the next
    // real collision on that title.
    expect((await repo.load(documentId(1)))?.properties['readwise:aliasFallbackAcceptedFor'])
      .toBeUndefined()
  })

  it('offers other conflicts when one document has a malformed alias bag', async () => {
    const rootId = await createRoot()
    await createRivalPage('rival', 'Deep Work')
    await sync(rootId, book(1, 'Deep Work', 11))
    await sync(rootId, book(2, 'Digital Minimalism', 21))

    // The shape sync apply can land and the local path cannot: a bag the codec
    // rejects. Only the alias cell is corrupted — overwriting the whole bag
    // would drop the type tag too, and the document would leave the scan's
    // query rather than exercise it.
    const corrupt = await repo.load(documentId(2))
    await sharedDb.db.execute(
      'UPDATE blocks SET properties_json = ? WHERE id = ?',
      [JSON.stringify({...corrupt!.properties, [aliasesProp.name]: ['Digital Minimalism', 7]}),
        documentId(2)],
    )
    expect(getBlockTypes((await repo.load(documentId(2)))!)).toContain(DOCUMENT_TYPE)

    // The malformed row must cost only itself. The scan is caught as a whole by
    // its caller, so a throw here takes every other document's conflict with it.
    const found = await unresolvedAliasConflicts(repo, WS)
    expect(found.map(c => c.documentId)).toEqual([documentId(1)])
  })

  it('retires the placeholder when a re-title lands on a free name', async () => {
    const rootId = await createRoot()
    await createRivalPage('rival', 'Deep Work')
    await sync(rootId, book(1, 'Deep Work', 11))
    expect(aliasesOf(await repo.load(documentId(1)))).toEqual(['Deep Work (Readwise)'])

    // Uncontested, so nothing is released first: `alias.sync` cannot re-key a
    // bag that does not hold the old content, so it appends the new title and
    // the bag is briefly two entries. Reconciling that pair back down to one is
    // what retires the placeholder.
    await sync(rootId, book(1, 'Digital Minimalism', 11))

    const doc = await repo.load(documentId(1))
    expect(doc?.content).toBe('Digital Minimalism')
    expect(aliasesOf(doc)).toEqual(['Digital Minimalism'])
  })

  it('re-titles the document to a second contested name without losing it', async () => {
    const rootId = await createRoot()
    await createRivalPage('rival', 'Deep Work')
    await createRivalPage('rival-2', 'Digital Minimalism')
    await sync(rootId, book(1, 'Deep Work', 11))

    // The upstream title changed to another name the user already uses. The
    // content rewrite and the alias claim must not share a transaction, and the
    // rewrite has to release the old name first: `alias.sync`'s A3 rule heals a
    // content change by appending the new content to whatever bag the row has,
    // which is refused for a contested name and rolls the rewrite back with it.
    await sync(rootId, book(1, 'Digital Minimalism', 11))

    const doc = await repo.load(documentId(1))
    expect(doc?.content).toBe('Digital Minimalism')
    expect(aliasesOf(doc)).toEqual(['Digital Minimalism (Readwise)'])
  })
})

describe('readwise document alias — the merge the banner offers', () => {
  const renderBanner = async (id: string) => {
    await repo.block(id).load()
    return render(
      <RepoContext.Provider value={repo}>
        <DuplicateNameBanner block={repo.block(id)}/>
      </RepoContext.Provider>,
    )
  }

  it('tells the user the name went elsewhere', async () => {
    const rootId = await createRoot()
    await createRivalPage('rival', 'Deep Work')
    await sync(rootId, book(1, 'Deep Work', 11))

    await renderBanner(documentId(1))

    expect(await screen.findByText(/Another page is named/)).toBeTruthy()
  })

  it('folds the other page in and hands the name back', async () => {
    const rootId = await createRoot()
    await createRivalPage('rival', 'Deep Work')
    await repo.tx(
      tx => tx.create({id: 'rival-kid', workspaceId: WS, parentId: 'rival', orderKey: 'a0', content: 'my old note'}),
      {scope: ChangeScope.BlockDefault},
    )
    await sync(rootId, book(1, 'Deep Work', 11))
    await renderBanner(documentId(1))

    await userEvent.click(await screen.findByRole('button', {name: /merge into this page/i}))

    await waitFor(async () => {
      expect(await claimantIdsOf('Deep Work')).toEqual([documentId(1)])
    })
    // The placeholder stays through the merge — anything linking it keeps
    // resolving — and the user's page comes across whole.
    expect(aliasesOf(await repo.load(documentId(1)))).toEqual(['Deep Work (Readwise)', 'Deep Work'])
    expect((await repo.load('rival-kid'))?.parentId).toBe(documentId(1))
    expect(await repo.load('rival')).toBeNull()

    // …and the next sync retires the placeholder, now that the real name is the
    // document's own.
    await sync(rootId, book(1, 'Deep Work', 11))
    expect(aliasesOf(await repo.load(documentId(1)))).toEqual(['Deep Work'])
  })
})

describe('readwise alias conflicts — what the sync offers to resolve', () => {
  const conflicts = () => unresolvedAliasConflicts(repo, WS)

  it('reports a document parked on a fallback, with the page holding its name', async () => {
    const rootId = await createRoot()
    await createRivalPage('rival', 'Deep Work')
    await sync(rootId, book(1, 'Deep Work', 11))

    expect(await conflicts()).toEqual([{
      documentId: documentId(1),
      title: 'Deep Work',
      fallback: 'Deep Work (Readwise)',
      rivalIds: ['rival'],
      rivalTitles: ['Deep Work'],
      managedRival: false,
    }])
  })

  it('says nothing about a document holding its own name', async () => {
    const rootId = await createRoot()
    await sync(rootId, book(1, 'Deep Work', 11))

    expect(await conflicts()).toEqual([])
  })

  it('stops reporting one the user chose to keep', async () => {
    const rootId = await createRoot()
    await createRivalPage('rival', 'Deep Work')
    await sync(rootId, book(1, 'Deep Work', 11))

    await acceptFallbackAlias(repo, documentId(1), 'Deep Work', WS)

    expect(await conflicts()).toEqual([])
    // and the answer survives the syncs that follow it, which is the whole
    // point of recording it rather than suppressing the toast in memory
    await sync(rootId, book(1, 'Deep Work', 11))
    expect(await conflicts()).toEqual([])
  })

  it('does not carry a keep from one title onto the next', async () => {
    const rootId = await createRoot()
    await createRivalPage('rival', 'Deep Work')
    await createRivalPage('rival-2', 'Digital Minimalism')
    await sync(rootId, book(1, 'Deep Work', 11))
    await acceptFallbackAlias(repo, documentId(1), 'Deep Work', WS)
    expect(await conflicts()).toEqual([])

    // Re-titled straight onto another name the user holds, without the first
    // conflict ever resolving. A yes/no flag would still be set here and would
    // silence a collision the user has not been shown.
    await sync(rootId, book(1, 'Digital Minimalism', 11))

    expect(await conflicts()).toEqual([{
      documentId: documentId(1),
      title: 'Digital Minimalism',
      fallback: 'Digital Minimalism (Readwise)',
      rivalIds: ['rival-2'],
      rivalTitles: ['Digital Minimalism'],
      managedRival: false,
    }])
  })

  it('refuses a keep clicked for a title the document no longer has', async () => {
    const rootId = await createRoot()
    await createRivalPage('rival', 'Deep Work')
    await createRivalPage('rival-2', 'Digital Minimalism')
    await sync(rootId, book(1, 'Deep Work', 11))

    // The dialog was showing the Deep Work conflict; a sync re-titled the
    // document onto another taken name while it sat open, and the click lands
    // after that.
    await sync(rootId, book(1, 'Digital Minimalism', 11))
    await acceptFallbackAlias(repo, documentId(1), 'Deep Work', WS)

    // Recording the shown title alone would leave an answer for Deep Work
    // parked on the document. Nothing spends it — the clear only fires when
    // the document WINS a title — so when Readwise puts the document back on
    // Deep Work, still taken, that stale answer would silence it.
    await sync(rootId, book(1, 'Deep Work', 11))

    expect((await conflicts()).map(c => c.title)).toEqual(['Deep Work'])
  })

  it('will not offer to merge one Readwise document into another', async () => {
    const rootId = await createRoot()
    await sync(rootId, book(1, 'Deep Work', 11))
    await sync(rootId, book(2, 'Deep Work', 12))

    // Two export records sharing a title. Merging the first into the second
    // does not stick: it keeps its deterministic id, and the next update for
    // that record restores it from the tombstone.
    const [conflict] = await conflicts()
    expect(conflict.rivalIds).toEqual([documentId(1)])
    expect(conflict.managedRival).toBe(true)
  })

  it('offers a LATER conflict again after the first one resolves', async () => {
    const rootId = await createRoot()
    await createRivalPage('rival', 'Deep Work')
    await sync(rootId, book(1, 'Deep Work', 11))
    await acceptFallbackAlias(repo, documentId(1), 'Deep Work', WS)

    // The rival gives the name up, so the document takes it back and the
    // answer is spent.
    await repo.tx(
      tx => tx.setProperty('rival', aliasesProp, []),
      {scope: ChangeScope.BlockDefault},
    )
    await sync(rootId, book(1, 'Deep Work', 11))
    expect(aliasesOf(await repo.load(documentId(1)))).toEqual(['Deep Work'])

    // Readwise re-titles the book onto another name the user already uses: a
    // fresh conflict, offered again rather than answered by the earlier keep.
    await createRivalPage('rival-2', 'Digital Minimalism')
    await sync(rootId, book(1, 'Digital Minimalism', 11))

    expect((await conflicts()).map(c => c.documentId)).toEqual([documentId(1)])
  })
})
