import { memoize } from 'lodash'
import type { Block } from '@/data/block.ts'
import { ChangeScope } from '@/data/api'
import { keyAtEnd } from '@/data/orderKey.ts'
import { getOrCreateJournalBlock } from '@/data/dailyNotes.ts'

const SHORTCUTS_BLOCK_CONTENT = 'Shortcuts'
const JOURNAL_SHORTCUT_CONTENT = '[[Journal]]'
const JOURNAL_SHORTCUT_ALIAS = 'Journal'

export const getOrCreateShortcutsBlock = memoize(
  async (userBlock: Block): Promise<Block> => {
    const repo = userBlock.repo
    const userData = userBlock.peek() ?? await userBlock.load()
    if (!userData) throw new Error(`Shortcuts parent ${userBlock.id} is missing`)

    const existing = await repo.query.firstChildByContent({
      parentId: userBlock.id,
      content: SHORTCUTS_BLOCK_CONTENT,
    }).load()
    if (existing) return repo.block(existing.id)

    const journal = await getOrCreateJournalBlock(repo, userData.workspaceId)

    let shortcutsId: string | undefined
    await repo.tx(async tx => {
      const parent = await tx.get(userBlock.id)
      if (!parent || parent.deleted) {
        throw new Error(`Shortcuts parent ${userBlock.id} is missing`)
      }

      const children = await tx.childrenOf(userBlock.id, parent.workspaceId)
      const existingInTx = children.find(child => child.content === SHORTCUTS_BLOCK_CONTENT)
      if (existingInTx) {
        shortcutsId = existingInTx.id
        return
      }

      shortcutsId = await tx.create({
        workspaceId: parent.workspaceId,
        parentId: userBlock.id,
        orderKey: keyAtEnd(children.at(-1)?.orderKey ?? null),
        content: SHORTCUTS_BLOCK_CONTENT,
      })
      await tx.create({
        workspaceId: parent.workspaceId,
        parentId: shortcutsId,
        orderKey: keyAtEnd(null),
        content: JOURNAL_SHORTCUT_CONTENT,
        references: [{id: journal.id, alias: JOURNAL_SHORTCUT_ALIAS}],
      })
    }, {scope: ChangeScope.UserPrefs, description: 'ensure shortcuts block'})

    if (!shortcutsId) throw new Error('Shortcuts block was not created')
    return repo.block(shortcutsId)
  },
  userBlock => `${userBlock.repo.instanceId}:${userBlock.id}`,
)
