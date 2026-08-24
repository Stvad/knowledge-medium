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

import readwiseContributions, { ensureRoot, syncBookToBlocks } from './readwise.tsx'

const READWISE_NS = '45fb169f-ffac-458b-b2a7-6cec87d2d7ee'
const DOCUMENT_TYPE = 'readwise-document'
const WS = 'ws-1'
const REVIEW_DATE = '2026-08-24'

const readwiseDataAndUi = readwiseContributions
  .filter(c => !['core.app-mounts', 'core.app-effects'].includes(c.facet.id)) as unknown as AppExtension[]

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
