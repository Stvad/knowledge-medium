var e=`import { ChangeScope } from '@/data/api/index.js'
import { keyAtEnd } from '@/data/orderKey.js'
import { aliasesProp } from '@/data/properties.js'
import { pluginBlockId } from '@/extensions/pluginIds.js'
import type { Repo } from '@/data/repo.js'

// Generate ONE namespace UUID for your plugin and never change it.
// (Run \`crypto.randomUUID()\` in any browser console.)
const READWISE_NS = '0d4f1c2e-7e9a-4f4d-a4f1-2c0a3a6e7f01'

// In a sync handler:
export const ensureLibraryRoot = async (repo: Repo, workspaceId: string): Promise<string> => {
  const rootId = pluginBlockId(workspaceId, READWISE_NS, 'library-root')
  await repo.tx(async tx => {
    // \`createOrGet\` is the idempotent primitive: it inserts at the pinned id
    // or hands back the row already there. Do NOT \`repo.load\` first and then
    // \`tx.create\` — the load answers for the moment it ran, so two syncs
    // racing each other both see nothing and the second create throws
    // DuplicateIdError, taking its whole transaction with it.
    const {id, inserted} = await tx.createOrGet({
      id: rootId,                              // pin the id
      workspaceId,
      parentId: null,
      orderKey: keyAtEnd(),
      content: 'Readwise Library',
    })
    if (!inserted) return
    // The alias and the block type are TYPED writes, not raw \`properties\`
    // keys. Each property has a codec (a bare \`{alias: ['…']}\` stores a value
    // nothing can decode), and the type tagger maintains a registry that a
    // raw \`{types: ['page']}\` would bypass.
    await tx.setProperty(id, aliasesProp, ['Readwise Library'])
    await repo.addTypeInTx(tx, id, 'page')
  }, { scope: ChangeScope.BlockDefault, description: 'create readwise root' })
  return rootId
}

// Per-record ids — same helper, different key:
export const bookBlockId = (workspaceId: string, userBookId: string): string =>
  pluginBlockId(workspaceId, READWISE_NS, \`book:\${userBookId}\`)
`;export{e as default};
//# sourceMappingURL=pluginRootSingleton.js.map