import { ChangeScope, propertyValue, seedProperty, seedType } from '@/data/api/index.js'
import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets.js'
import { extensionPropertySeedKey, extensionTypeSeedKey } from '@/extensions/dynamicExtensionSeeds.js'
import { getOrCreateKernelPage } from '@/data/kernelPage.js'
import { getOrCreateTypedChild } from '@/data/typedRecords.js'
import type { Repo } from '@/data/repo.js'

// Generate ONE namespace UUID per block kind and never change it —
// changing it re-points the kind at fresh ids and orphans every row
// already written. (`crypto.randomUUID()` in any browser console.)
const READWISE_ROOT_NS = '7c4b1e93-6a25-4d8f-b013-9e2a5c7f4d61'
const READWISE_BOOK_NS = '3b91e4c7-5a2d-4f18-9e63-0c7a2d5b8f14'

const bookIdProp = seedProperty({
  seedKey: extensionPropertySeedKey('user-book-id'),
  revision: 1,
  name: 'readwise:userBookId',
  preset: 'string',
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})
const progressProp = seedProperty({
  seedKey: extensionPropertySeedKey('book-progress'),
  revision: 1,
  name: 'readwise:progress',
  preset: 'number',
  defaultValue: 0,
  changeScope: ChangeScope.BlockDefault,
})

// Every type id you tag must be REGISTERED first — tagging an unknown one
// throws and rolls the transaction back. Declare each with seedType and
// contribute it through typeSeedsFacet, which is what this default export is:
// nothing below runs until the runtime has resolved it.
const libraryType = seedType({
  seedKey: extensionTypeSeedKey('library'),
  revision: 1,
  id: 'readwise:library',
  label: 'Readwise Library',
  properties: [],
})
const bookType = seedType({
  seedKey: extensionTypeSeedKey('book'),
  revision: 1,
  id: 'readwise:book',
  label: 'Book',
  properties: [bookIdProp, progressProp],
})

export default [
  definitionSeedsFacet.of(bookIdProp, {source: 'readwise'}),
  definitionSeedsFacet.of(progressProp, {source: 'readwise'}),
  typeSeedsFacet.of(libraryType, {source: 'readwise'}),
  typeSeedsFacet.of(bookType, {source: 'readwise'}),
]

interface Book {
  userBookId: string
  title: string
  progress: number
}

export const syncBooks = async (
  repo: Repo,
  workspaceId: string,
  books: readonly Book[],
): Promise<void> => {
  // The root page: id = uuidv5(workspaceId, NS) — the workspace is the WHOLE
  // key, so there is one per workspace. Also repairs a row that lost its alias
  // or type, and restores one that was deleted.
  const root = await getOrCreateKernelPage(repo, workspaceId, {
    namespace: READWISE_ROOT_NS,
    alias: 'Readwise Library',
    markerType: libraryType.id,   // what you subscribeBlocks({types}) for
  })

  // One block per book, under it. The key is whatever makes it THIS book —
  // include the workspace, since ids are global.
  await repo.tx(async tx => {
    for (const book of books) {
      const outcome = await getOrCreateTypedChild(repo, tx, {
        identity: {
          namespace: READWISE_BOOK_NS,
          key: `${workspaceId}|${book.userBookId}`,
        },
        parentId: root.id,
        content: book.title,
        types: [bookType.id],
        properties: [propertyValue(bookIdProp, book.userBookId)],
      })
      // Fields the SOURCE owns get written on both outcomes. 'adopted' means
      // the block was already there and this call did not touch its content or
      // properties — not that there is nothing to write. Skipping the create
      // would leave a first-seen book with no progress until something
      // happened to re-fetch it, which an incremental sync never does.
      // 'taken' wrote nothing at all, so there is no id of yours to write to.
      if (outcome.status !== 'taken') {
        await tx.setProperty(outcome.id, progressProp, book.progress)
      }
    }
  }, { scope: ChangeScope.BlockDefault, description: 'sync readwise books' })
}
