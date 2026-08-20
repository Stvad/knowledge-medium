import { ChangeScope, seedProperty, seedType } from '@/data/api/index.js'
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

// Tagging an unregistered type id throws and rolls the tx back. Declaring
// and contributing them IS this default export.
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
  // id = uuidv5(workspaceId, NS): the workspace is the WHOLE key, so one per
  // workspace. Repairs a row that lost its alias or type, restores a deleted
  // one. These two examples are one fictional plugin, hence the shared NS.
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
      })
      // Written on 'created' AND 'adopted': adopted means the block was
      // already there and this call left its content and properties alone,
      // not that there is nothing to write. 'taken' wrote nothing and its id
      // is not yours.
      if (outcome.status !== 'taken') {
        // Here rather than via the spec's `properties`, which is applied on
        // CREATE only — an adopted record would never receive the id.
        await tx.setProperty(outcome.id, bookIdProp, book.userBookId)
        await tx.setProperty(outcome.id, progressProp, book.progress)
      }
    }
  }, { scope: ChangeScope.BlockDefault, description: 'sync readwise books' })
}
