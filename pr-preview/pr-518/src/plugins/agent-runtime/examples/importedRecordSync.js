var e=`import { ChangeScope, propertyValue, seedProperty, seedType } from '@/data/api/index.js'
import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets.js'
import { extensionPropertySeedKey, extensionTypeSeedKey } from '@/extensions/dynamicExtensionSeeds.js'
import { getOrCreateKernelPage } from '@/data/kernelPage.js'
import { getOrCreateTypedChild } from '@/data/typedRecords.js'
import type { Repo } from '@/data/repo.js'

// (\`kmagent types --module "@/data/api/index.js"\` for the full Tx surface.)
// One namespace per KIND — the root page and the highlights are two kinds, so
// they get two. (They key differently too: a kernel page's key is the
// workspace id alone.)
const READWISE_ROOT_NS = '7c4b1e93-6a25-4d8f-b013-9e2a5c7f4d61'
const READWISE_HL_NS = '2f68d0a5-4c19-4b73-8e5a-6d1b3f9c8074'

// Source ids and source-owned fields are REGISTERED properties, not bare keys
// in a raw \`properties\` object: an unregistered key has no codec and no
// editor, and \`kmagent audit-extension\` flags it.
const highlightIdProp = seedProperty({
  seedKey: extensionPropertySeedKey('highlight-id'),
  revision: 1,
  name: 'readwise:highlightId',
  preset: 'string',
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})
const noteProp = seedProperty({
  seedKey: extensionPropertySeedKey('highlight-note'),
  revision: 1,
  name: 'readwise:note',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

// A type id that was never registered throws when tagged and rolls the whole
// transaction back, so declare before you tag. Contributing them IS this
// default export — nothing below runs until the runtime has resolved it.
const libraryType = seedType({
  seedKey: extensionTypeSeedKey('library'),
  revision: 1,
  id: 'readwise:library',
  label: 'Readwise Library',
  properties: [],
})
const highlightType = seedType({
  seedKey: extensionTypeSeedKey('highlight'),
  revision: 1,
  id: 'readwise:highlight',
  label: 'Highlight',
  properties: [highlightIdProp, noteProp],
})

export default [
  definitionSeedsFacet.of(highlightIdProp, {source: 'readwise'}),
  definitionSeedsFacet.of(noteProp, {source: 'readwise'}),
  typeSeedsFacet.of(libraryType, {source: 'readwise'}),
  typeSeedsFacet.of(highlightType, {source: 'readwise'}),
]

interface Highlight {
  id: string
  text: string
  note?: string
}

export const syncHighlights = async (
  repo: Repo,
  workspaceId: string,
  highlights: readonly Highlight[],
): Promise<void> => {
  const root = await getOrCreateKernelPage(repo, workspaceId, {
    namespace: READWISE_ROOT_NS,
    alias: 'Readwise Library',
    markerType: libraryType.id,
  })

  await repo.tx(async tx => {
    for (const hl of highlights) {
      const outcome = await getOrCreateTypedChild(repo, tx, {
        // Whatever makes this THIS highlight. Include the workspace: block
        // ids are global, and two workspaces deriving one id collide.
        identity: {
          namespace: READWISE_HL_NS,
          key: \`\${workspaceId}|hl:\${hl.id}\`,
        },
        parentId: root.id,          // appended last; no order-key maths
        content: hl.text,
        types: [highlightType.id],
        properties: [propertyValue(highlightIdProp, hl.id)],
      })

      // 'created' → written from the spec above.
      // 'adopted' → it was already there and this call did NOT overwrite its
      //             content or properties; the user's own edits survive a
      //             re-sync.
      // 'taken'   → the id holds something you can't use (deleted, or another
      //             workspace's row). Nothing was written, and there is no id
      //             of yours to write to.
      //
      // So: write the fields the SOURCE owns on both of the first two. Gating
      // them on 'adopted' alone leaves every first-seen record without them
      // until something re-fetches it — which a checkpointed incremental sync
      // never does.
      if (outcome.status !== 'taken' && hl.note) {
        await tx.setProperty(outcome.id, noteProp, hl.note)
      }
    }
  }, { scope: ChangeScope.BlockDefault, description: 'readwise sync' })
}
`;export{e as default};
//# sourceMappingURL=importedRecordSync.js.map