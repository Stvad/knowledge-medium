var e=`import { ChangeScope, seedProperty, seedType } from '@/data/api/index.js'
import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets.js'
import { extensionPropertySeedKey, extensionTypeSeedKey } from '@/extensions/dynamicExtensionSeeds.js'
import { getOrCreateKernelPage } from '@/data/kernelPage.js'
import { getOrCreateTypedChild } from '@/data/typedRecords.js'
import type { Repo } from '@/data/repo.js'

// One namespace per KIND, and generate your OWN (\`crypto.randomUUID()\`);
// changing one later orphans every row already written under it. A kernel
// page keys on the workspace id alone, a typed child on {namespace, key}.
const READWISE_ROOT_NS = '7c4b1e93-6a25-4d8f-b013-9e2a5c7f4d61'
const READWISE_HL_NS = '2f68d0a5-4c19-4b73-8e5a-6d1b3f9c8074'

// Registered properties, not bare keys in a raw \`properties\` object: an
// unregistered key has no codec or editor, and audit-extension flags it.
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

// Tagging an unregistered type id throws and rolls the whole tx back, so
// declare before you tag. Contributing them IS this default export.
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
      })

      // 'created' wrote the spec; 'adopted' found it and deliberately left
      // content/properties alone so the user's edits survive; 'taken' wrote
      // nothing and its id is not yours. So write source-owned fields on the
      // first two — gating on 'adopted' alone leaves every first-seen record
      // without them until something re-fetches it, which an incremental
      // sync never does.
      if (outcome.status !== 'taken') {
        // NOT via the spec's \`properties\`: that is applied on CREATE only,
        // so it never reaches an adopted record.
        await tx.setProperty(outcome.id, highlightIdProp, hl.id)
        // No \`&& hl.note\`: guarding on the value writes it but never CLEARS
        // it, so a note deleted upstream sticks forever.
        await tx.setProperty(outcome.id, noteProp, hl.note)
      }
    }
  }, { scope: ChangeScope.BlockDefault, description: 'readwise sync' })
}
`;export{e as default};
//# sourceMappingURL=importedRecordSync.js.map