import { memoize } from 'lodash'
import { v5 as uuidv5 } from 'uuid'
import type { Block } from '@/data/block.ts'
import type { BlockData } from '@/data/api'
import { ChangeScope, codecs, defineProperty } from '@/data/api'
import { keyAtEnd } from '@/data/orderKey.ts'
import {
  getOrCreateJournalBlock,
  journalBlockId,
} from '@/data/dailyNotes.ts'

const SHORTCUTS_BLOCK_CONTENT = 'Shortcuts'
const SHORTCUTS_BLOCK_NS = 'e99db742-98fd-494a-aa31-f4afaa3d247f'
const JOURNAL_SHORTCUT_NS = 'b2b62f3e-5a1d-47eb-a8e7-34ba5c61468d'
const JOURNAL_SHORTCUT_CONTENT = 'Journal'

const shortcutsInitializedProp = defineProperty<boolean>('system:left-sidebar:shortcutsInitialized', {
  codec: codecs.boolean,
  defaultValue: false,
  changeScope: ChangeScope.UserPrefs,
})

const shortcutsBlockId = (userBlockId: string): string =>
  uuidv5(userBlockId, SHORTCUTS_BLOCK_NS)

const journalShortcutId = (shortcutsBlockId: string, targetId: string): string =>
  uuidv5(`${shortcutsBlockId}:${targetId}`, JOURNAL_SHORTCUT_NS)

const shortcutsInitialized = (data: BlockData): boolean => {
  const raw = data.properties[shortcutsInitializedProp.name]
  return raw === undefined ? false : shortcutsInitializedProp.codec.decode(raw)
}

const resolveJournalShortcutTarget = async (
  block: Block,
  workspaceId: string,
): Promise<Block | null> => {
  const repo = block.repo
  const id = journalBlockId(workspaceId)
  const live = await repo.load(id)
  if (live && !live.deleted) return repo.block(id)
  if (repo.isReadOnly) return null
  return getOrCreateJournalBlock(repo, workspaceId)
}

const initializeShortcutsBlock = async (
  shortcutsBlock: Block,
  workspaceId: string,
): Promise<void> => {
  const repo = shortcutsBlock.repo
  const existing = shortcutsBlock.peek() ?? await shortcutsBlock.load()
  if (!existing || shortcutsInitialized(existing)) return

  const journal = await resolveJournalShortcutTarget(shortcutsBlock, workspaceId)

  await repo.tx(async tx => {
    const current = await tx.get(shortcutsBlock.id)
    if (!current || current.deleted || shortcutsInitialized(current)) return

    const children = await tx.childrenOf(shortcutsBlock.id, workspaceId)
    if (children.length === 0 && journal) {
      const id = journalShortcutId(shortcutsBlock.id, journal.id)
      const existingShortcut = await tx.get(id)
      const patch = {
        content: JOURNAL_SHORTCUT_CONTENT,
        references: [{id: journal.id, alias: JOURNAL_SHORTCUT_CONTENT}],
      }

      if (existingShortcut?.deleted) {
        await tx.restore(id, patch)
        await tx.move(id, {parentId: shortcutsBlock.id, orderKey: keyAtEnd(null)})
      } else if (existingShortcut) {
        await tx.update(id, patch)
        if (existingShortcut.parentId !== shortcutsBlock.id) {
          await tx.move(id, {parentId: shortcutsBlock.id, orderKey: keyAtEnd(null)})
        }
      } else {
        await tx.create({
          id,
          workspaceId,
          parentId: shortcutsBlock.id,
          orderKey: keyAtEnd(null),
          ...patch,
        })
      }
    }

    await tx.setProperty(shortcutsBlock.id, shortcutsInitializedProp, true)
  }, {scope: ChangeScope.UserPrefs, description: 'initialize shortcuts block'})
}

export const getOrCreateShortcutsBlock = memoize(
  async (userBlock: Block): Promise<Block> => {
    const repo = userBlock.repo
    const userData = userBlock.peek() ?? await userBlock.load()
    if (!userData) throw new Error(`Shortcuts parent ${userBlock.id} is missing`)

    const existingByContent = await repo.query.firstChildByContent({
      parentId: userBlock.id,
      content: SHORTCUTS_BLOCK_CONTENT,
    }).load()
    if (existingByContent) {
      const block = repo.block(existingByContent.id)
      await initializeShortcutsBlock(block, userData.workspaceId)
      return block
    }

    const id = shortcutsBlockId(userBlock.id)
    const live = await repo.load(id)
    if (live && !live.deleted) {
      const block = repo.block(id)
      await initializeShortcutsBlock(block, userData.workspaceId)
      return block
    }

    let resolvedId = id
    await repo.tx(async tx => {
      const parent = await tx.get(userBlock.id)
      if (!parent || parent.deleted) {
        throw new Error(`Shortcuts parent ${userBlock.id} is missing`)
      }

      const children = await tx.childrenOf(userBlock.id, parent.workspaceId)
      const existing = children.find(child => child.content === SHORTCUTS_BLOCK_CONTENT)
      if (existing) {
        resolvedId = existing.id
        return
      }

      const orderKey = keyAtEnd(children.at(-1)?.orderKey ?? null)
      const tombstone = await tx.get(id)
      if (tombstone) {
        resolvedId = tombstone.id
        if (tombstone.deleted) {
          await tx.restore(tombstone.id, {content: SHORTCUTS_BLOCK_CONTENT})
        }
        if (tombstone.parentId !== userBlock.id || tombstone.orderKey !== orderKey) {
          await tx.move(tombstone.id, {parentId: userBlock.id, orderKey})
        }
        return
      }

      resolvedId = await tx.create({
        id,
        workspaceId: parent.workspaceId,
        parentId: userBlock.id,
        orderKey,
        content: SHORTCUTS_BLOCK_CONTENT,
      })
    }, {scope: ChangeScope.UserPrefs, description: 'ensure shortcuts block'})

    const block = repo.block(resolvedId)
    await initializeShortcutsBlock(block, userData.workspaceId)
    return block
  },
  userBlock => `${userBlock.repo.instanceId}:${userBlock.id}`,
)
