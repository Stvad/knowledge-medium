import { ChangeScope } from '@/data/api/index.js'
import { keyAtEnd, keysBetween } from '@/data/orderKey.js'
import { aliasesProp } from '@/data/properties.js'
import { pluginBlockId } from '@/extensions/pluginIds.js'
import type { Repo } from '@/data/repo.js'

// Inside `await repo.tx(async tx => { ... }, {scope, description})`:
//
//   tx.get(id)                       → Promise<BlockData | null>
//   tx.peek(id)                      → BlockData | null (sync, snapshot read)
//   tx.create({...})                 → Promise<string> (new id, or pin via {id})
//   tx.createOrGet({id, ...})        → Promise<{id, inserted}> — idempotent insert
//   tx.update(id, patch)             → patch is {content?, properties?, references?}
//   tx.delete(id) / tx.restore(id)   → soft delete + recover
//   tx.move(id, {parentId, orderKey})
//   tx.childrenOf(parentId, wsId?)   → Promise<BlockData[]> (order_key ascending)
//   tx.parentOf(childId)             → Promise<BlockData | null>

const READWISE_NS = '0d4f1c2e-7e9a-4f4d-a4f1-2c0a3a6e7f01'

interface Highlight {
  id: string
  text: string
}

// Idempotent upsert by deterministic id. `createOrGet` is what makes the
// second sync of the same record land on the existing block: a pinned id on
// bare `tx.create` throws DuplicateIdError and aborts the whole transaction.
export const syncHighlights = async (
  repo: Repo,
  workspaceId: string,
  highlights: readonly Highlight[],
): Promise<void> => {
  await repo.tx(async tx => {
    const rootId = pluginBlockId(workspaceId, READWISE_NS, 'library-root')
    const root = await tx.createOrGet({
      id: rootId,                                  // pin
      workspaceId,
      parentId: null,
      orderKey: keyAtEnd(),
      content: 'Readwise Library',
    })
    if (root.inserted) {
      // Typed writes, not raw `properties` keys — each property has a codec,
      // and the type tagger owns the registry `{types: [...]}` would bypass.
      await tx.setProperty(rootId, aliasesProp, ['Readwise Library'])
      await repo.addTypeInTx(tx, rootId, 'page')
    }

    // Insert N highlights as children, using order keys that sort
    // between the existing last child and the end-of-list.
    const children = await tx.childrenOf(rootId)
    const lastKey = children.at(-1)?.orderKey ?? null
    const newKeys = keysBetween(lastKey, null, highlights.length)
    for (const [i, hl] of highlights.entries()) {
      await tx.createOrGet({
        id: pluginBlockId(workspaceId, READWISE_NS, `hl:${hl.id}`),
        workspaceId,
        parentId: rootId,
        orderKey: newKeys[i],
        content: hl.text,
        properties: { 'readwise:highlight_id': hl.id },
      })
    }
  }, { scope: ChangeScope.BlockDefault, description: 'readwise sync' })
}
