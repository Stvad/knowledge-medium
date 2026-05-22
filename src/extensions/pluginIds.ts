import { v5 as uuidv5 } from 'uuid'

/** Deterministic block id for a plugin-owned singleton block (e.g. a
 *  "Library" root page that all imports live under).
 *
 *  Each plugin picks one stable namespace UUID *once* and hardcodes
 *  it — re-deriving the same ids on subsequent runs is what makes
 *  upserts idempotent across reinstalls and across the user's
 *  devices. (`crypto.randomUUID()` in any browser console will give
 *  you a fresh one.) Keys are arbitrary plugin-internal strings —
 *  conventional choices: `'root'`, `'library-root'`, `'sync-state'`,
 *  `'<external-record-id>'`. The workspace is mixed in so the same
 *  plugin in two workspaces produces distinct ids.
 *
 *  Example:
 *
 *    const READWISE_NS = '0d4f1c2e-7e9a-4f4d-a4f1-2c0a3a6e7f01'
 *    const rootId = pluginBlockId(workspaceId, READWISE_NS, 'library-root')
 *    const bookId = pluginBlockId(workspaceId, READWISE_NS, `book:${userBookId}`)
 */
export const pluginBlockId = (
  workspaceId: string,
  pluginNamespace: string,
  key: string,
): string => uuidv5(`${workspaceId}:${key}`, pluginNamespace)
