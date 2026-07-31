import { workspaceDerivedBlockId } from '@/data/derivedIds'

/** Deterministic block id for a plugin-owned block — the ID ONLY.
 *
 *  Probably not what you want. An id looks like a lookup and isn't: what
 *  sits there may be nothing, a tombstone, another workspace's row, or a
 *  block the user has since edited. Following this with `repo.load` and a
 *  `tx.create` is the race the derived id was supposed to remove — the load
 *  answers for the moment it ran, so two writers both see nothing and the
 *  second `tx.create` throws `DuplicateIdError`, taking its whole
 *  transaction with it.
 *
 *  Reach for the get-or-create that owns the whole dance instead:
 *
 *    - `getOrCreateKernelPage` (`@/data/kernelPage`) — the plugin's root
 *      page. Creates, repairs a row that lost its alias or type, restores
 *      one that was deleted.
 *    - `getOrCreateTypedChild` (`@/data/typedRecords`) — a record under it.
 *      Creates or adopts, never overwrites what it adopts, and tells you
 *      which happened.
 *
 *  This helper is for the cases that genuinely want the string: asking "is
 *  this block one of mine?", or handing a target id to something else.
 *
 *  Pick one namespace UUID per block kind, hardcode it, and never change
 *  it — changing it re-points the kind at fresh ids and orphans every block
 *  already written. (`crypto.randomUUID()` in any browser console gives you
 *  one.) The workspace is mixed into the key, so the same plugin in two
 *  workspaces produces distinct ids. See `@/data/derivedIds` for the rules.
 *
 *  Example:
 *
 *    const READWISE_NS = '0d4f1c2e-7e9a-4f4d-a4f1-2c0a3a6e7f01'
 *    const isMine = block.id === pluginBlockId(workspaceId, READWISE_NS, 'library-root')
 */
export const pluginBlockId = (
  workspaceId: string,
  pluginNamespace: string,
  key: string,
): string => workspaceDerivedBlockId(pluginNamespace, workspaceId, key)
