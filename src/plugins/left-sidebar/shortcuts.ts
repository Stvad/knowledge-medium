import { memoize } from 'lodash'
import { v5 as uuidv5 } from 'uuid'
import type { Block } from '@/data/block.js'
import { ChangeScope } from '@/data/api'
import { createOrRestoreTargetBlock } from '@/data/targets.js'
import { keyAtEnd } from '@/data/orderKey.js'
import { getOrCreateJournalBlock } from '@/plugins/daily-notes'

const SHORTCUTS_BLOCK_CONTENT = 'Shortcuts'
const JOURNAL_SHORTCUT_CONTENT = '[[Journal]]'
const JOURNAL_SHORTCUT_ALIAS = 'Journal'

// Deterministic-id namespaces — two offline clients (or one client
// racing local create against first sync) converge on the same row
// rather than each writing a fresh uuid. Without this the user page
// can end up with multiple "Shortcuts" children after the upload
// queue drains. Mirrors the daily-notes namespace pattern.
const SHORTCUTS_NS = 'c1d7a2e3-4b6f-4a8e-9c5d-2f3b6e8a1c47'
const JOURNAL_SHORTCUT_NS = 'b2a4f7c9-3d5e-4f1b-8a2c-9e7b6d4f3a51'

export const shortcutsBlockId = (userBlockId: string): string =>
  uuidv5(userBlockId, SHORTCUTS_NS)

export const journalShortcutBlockId = (shortcutsId: string): string =>
  uuidv5(shortcutsId, JOURNAL_SHORTCUT_NS)

export const getOrCreateShortcutsBlock = memoize(
  async (userBlock: Block): Promise<Block> => {
    const repo = userBlock.repo
    const userData = userBlock.peek() ?? await userBlock.load()
    if (!userData) throw new Error(`Shortcuts parent ${userBlock.id} is missing`)

    const shortcutsId = shortcutsBlockId(userBlock.id)

    const live = await repo.load(shortcutsId)
    if (live) return repo.block(shortcutsId)

    const journal = await getOrCreateJournalBlock(repo, userData.workspaceId)

    await repo.tx(async tx => {
      const parent = await tx.get(userBlock.id)
      if (!parent || parent.deleted) {
        throw new Error(`Shortcuts parent ${userBlock.id} is missing`)
      }

      const siblings = await tx.childrenOf(userBlock.id, parent.workspaceId)
      const shortcutsResult = await createOrRestoreTargetBlock(tx, {
        id: shortcutsId,
        workspaceId: parent.workspaceId,
        parentId: userBlock.id,
        orderKey: keyAtEnd(siblings.at(-1)?.orderKey ?? null),
        freshContent: SHORTCUTS_BLOCK_CONTENT,
      })

      // Only seed default children on first creation / restore of the
      // shortcuts row itself — preserves a user's intentional deletes
      // when they manually empty the shortcuts list.
      if (!shortcutsResult.inserted) return

      await createOrRestoreTargetBlock(tx, {
        id: journalShortcutBlockId(shortcutsId),
        workspaceId: parent.workspaceId,
        parentId: shortcutsId,
        orderKey: keyAtEnd(),
        freshContent: JOURNAL_SHORTCUT_CONTENT,
        onInsertedOrRestored: async (tx, id) => {
          await tx.update(id, {
            references: [{id: journal.id, alias: JOURNAL_SHORTCUT_ALIAS}],
          })
        },
      })
    }, {scope: ChangeScope.UserPrefs, description: 'ensure shortcuts block'})

    return repo.block(shortcutsId)
  },
  userBlock => `${userBlock.repo.instanceId}:${userBlock.id}`,
)
