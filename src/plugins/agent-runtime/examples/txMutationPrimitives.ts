import { ChangeScope, seedProperty, seedType } from '@/data/api/index.js'
import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets.js'
import { extensionPropertySeedKey, extensionTypeSeedKey } from '@/extensions/dynamicExtensionSeeds.js'
import { keysBetween } from '@/data/orderKey.js'
import { pluginBlockId } from '@/extensions/pluginIds.js'
import type { Repo } from '@/data/repo.js'

// Inside `await repo.tx(async tx => { ... }, {scope, description})`:
//
//   tx.create({...})           → new id, or pin one via {id}; throws on conflict
//   tx.createOrGet({id, ...})  → {id, inserted} — the idempotent insert
//   tx.update(id, patch)       → {content?, properties?, references?}
//   tx.setProperty(id, prop, value) / tx.get / tx.peek / tx.delete / tx.restore
//   tx.move(id, {parentId, orderKey}) / tx.childrenOf / tx.parentOf
//
// (`kmagent types --module "@/data/api/index.js"` for the full surface.)

const READWISE_NS = '0d4f1c2e-7e9a-4f4d-a4f1-2c0a3a6e7f01'

// The external id is a REGISTERED property, not a bare key in the raw
// `properties` object. An unregistered key has no codec and no editor, and
// `kmagent audit-extension` flags it — declare it, contribute it, write it
// through `tx.setProperty`.
const highlightIdProp = seedProperty({
  seedKey: extensionPropertySeedKey('highlight-id'),
  revision: 1,
  name: 'readwise:highlightId',
  preset: 'string',
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

const highlightType = seedType({
  seedKey: extensionTypeSeedKey('highlight'),
  revision: 1,
  id: 'readwise-highlight',
  label: 'Highlight',
  properties: [highlightIdProp],
})

// Tagging a type that was never registered throws and rolls the whole
// transaction back, so both seeds have to be contributed here.
export default [
  definitionSeedsFacet.of(highlightIdProp, {source: 'readwise'}),
  typeSeedsFacet.of(highlightType, {source: 'readwise'}),
]

interface Highlight {
  id: string
  text: string
}

// Idempotent upsert by deterministic id. `createOrGet` is what makes the
// second sync of the same record land on the existing block: a pinned id on
// bare `tx.create` throws DuplicateIdError and aborts the whole transaction.
// `rootId` comes from the `plugin-root-singleton` pattern — that one owns
// creating the library page; this one owns the records under it.
export const syncHighlights = async (
  repo: Repo,
  workspaceId: string,
  rootId: string,
  highlights: readonly Highlight[],
): Promise<void> => {
  await repo.tx(async tx => {
    // Insert N highlights as children, using order keys that sort
    // between the existing last child and the end-of-list.
    const children = await tx.childrenOf(rootId)
    const lastKey = children.at(-1)?.orderKey ?? null
    const newKeys = keysBetween(lastKey, null, highlights.length)
    for (const [i, hl] of highlights.entries()) {
      const {id, inserted} = await tx.createOrGet({
        id: pluginBlockId(workspaceId, READWISE_NS, `hl:${hl.id}`),
        workspaceId,
        parentId: rootId,
        orderKey: newKeys[i],
        content: hl.text,
      })
      // Fields the SOURCE owns are written on BOTH outcomes. `inserted: false`
      // means the block was already there and createOrGet left it untouched —
      // not that there is nothing to write. Updating only the freshly-inserted
      // ones is how a re-sync silently keeps stale text forever.
      if (!inserted) await tx.update(id, {content: hl.text})
      await repo.addTypeInTx(tx, id, highlightType.id)
      await tx.setProperty(id, highlightIdProp, hl.id)
    }
  }, { scope: ChangeScope.BlockDefault, description: 'readwise sync' })
}
