var e=`import { ChangeScope } from '@/data/api/index.js'
import { keyAtEnd } from '@/data/orderKey.js'
import { aliasesProp } from '@/data/properties.js'
import { createOrRestoreTargetBlock } from '@/data/targets.js'
import { pluginBlockId } from '@/extensions/pluginIds.js'
import type { Repo } from '@/data/repo.js'

// Generate ONE namespace UUID for your plugin and never change it.
// (Run \`crypto.randomUUID()\` in any browser console.)
const READWISE_NS = '0d4f1c2e-7e9a-4f4d-a4f1-2c0a3a6e7f01'

// In a sync handler:
export const ensureLibraryRoot = async (repo: Repo, workspaceId: string): Promise<string> => {
  const rootId = pluginBlockId(workspaceId, READWISE_NS, 'library-root')
  await repo.tx(async tx => {
    // \`createOrRestoreTargetBlock\` is the get-or-create for a deterministic
    // id. Two hazards it handles that hand-rolled code gets wrong:
    //   - \`repo.load\` then \`tx.create\` is racy — the load answers for the
    //     moment it ran, so two syncs both see nothing and the second create
    //     throws DuplicateIdError, taking its whole tx with it.
    //   - a DELETED page leaves a tombstone the id still resolves to, and the
    //     bare \`tx.createOrGet\` underneath throws on one, failing every later
    //     sync. This restores it instead.
    await createOrRestoreTargetBlock(tx, {
      id: rootId,                              // pin the id
      workspaceId,
      parentId: null,
      orderKey: keyAtEnd(),
      freshContent: 'Readwise Library',
      // Set because the callback below OWNS the alias: a tombstone can carry a
      // stale claim, and restoring it as-is trips the alias-uniqueness trigger
      // and rolls the tx back. Leave it unset if you DON'T rewrite the alias,
      // so a user-set one survives the restore.
      stripAliasesOnRestore: true,
      // Runs on insert and on restore, not on a live-row hit. Alias and type
      // are TYPED writes, not raw \`properties\` keys: each property has a codec
      // (a bare \`{alias: ['…']}\` stores a value nothing can decode), and the
      // tagger maintains a registry \`{types: ['page']}\` would bypass.
      onInsertedOrRestored: async (tx, id) => {
        await tx.setProperty(id, aliasesProp, ['Readwise Library'])
        await repo.addTypeInTx(tx, id, 'page')
      },
    })
  }, { scope: ChangeScope.BlockDefault, description: 'create readwise root' })
  return rootId
}
`;export{e as default};
//# sourceMappingURL=pluginRootSingleton.js.map