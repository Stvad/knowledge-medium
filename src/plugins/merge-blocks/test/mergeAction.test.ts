// @vitest-environment jsdom
/**
 * "Merge into…" action — the thin handler that opens the merge-target picker
 * over the focused block. The merge *strategy* is covered in strategy.test.ts;
 * this covers the handler's own logic: resolve the block's data (peek, else
 * load), bail if it has none, otherwise open the picker (via `openDialog`)
 * with the source id + its workspace.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/dialogs.js', () => ({ openDialog: vi.fn() }))

import { openDialog } from '@/utils/dialogs.js'
import { mergeIntoAction } from '../mergeAction.ts'
import type { BlockData } from '@/data/api'
import type { BlockShortcutDependencies } from '@/shortcuts/types.js'

const openDialogMock = vi.mocked(openDialog)

const blockData = (o: Partial<BlockData> = {}): BlockData => ({
  id: 'src', workspaceId: 'ws-1', parentId: null, referenceTargetId: null, orderKey: 'a0', content: '',
  properties: {}, references: [], createdAt: 1, updatedAt: 1, userUpdatedAt: 1, createdBy: 'u',
  updatedBy: 'u', deleted: false, ...o,
})

/** Minimal block the handler needs: id + peek()/load(). */
const blockStub = (id: string, peek: BlockData | null, load: BlockData | null = peek) => ({
  id,
  peek: () => peek,
  load: async () => load,
}) as unknown as BlockShortcutDependencies['block']

const run = (block: BlockShortcutDependencies['block']) =>
  mergeIntoAction.handler(
    { block, uiStateBlock: block } as BlockShortcutDependencies,
    {} as KeyboardEvent,
  )

beforeEach(() => openDialogMock.mockClear())

describe('mergeIntoAction', () => {
  it('opens the picker for the focused block, carrying its own workspace', async () => {
    await run(blockStub('src', blockData({ id: 'src', workspaceId: 'ws-9' })))
    expect(openDialogMock).toHaveBeenCalledTimes(1)
    expect(openDialogMock.mock.calls[0][1]).toEqual({ sourceBlockId: 'src', workspaceId: 'ws-9' })
  })

  it('falls back to load() when the block is not yet in the peek cache', async () => {
    await run(blockStub('src', null, blockData({ id: 'src', workspaceId: 'ws-2' })))
    expect(openDialogMock.mock.calls[0][1]).toEqual({ sourceBlockId: 'src', workspaceId: 'ws-2' })
  })

  it('does nothing when the block has no data to merge', async () => {
    await run(blockStub('gone', null, null))
    expect(openDialogMock).not.toHaveBeenCalled()
  })
})
