// @vitest-environment jsdom
/**
 * "Merge into…" action — the thin handler that opens the merge-target picker
 * over the focused block. The merge *strategy* is covered in strategy.test.ts;
 * this covers the handler's own logic: resolve the block's data (peek, else
 * load), bail if it has none, otherwise fire the open-picker event with the
 * source id + its workspace.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mergeIntoAction } from '../mergeAction.ts'
import { openMergePickerEvent, type OpenMergePickerEventDetail } from '../events.ts'
import type { BlockData } from '@/data/api'
import type { BlockShortcutDependencies } from '@/shortcuts/types.js'

const blockData = (o: Partial<BlockData> = {}): BlockData => ({
  id: 'src', workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: '',
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

let opened: OpenMergePickerEventDetail[]
let listener: (e: Event) => void
beforeEach(() => {
  opened = []
  listener = (e: Event) => opened.push((e as CustomEvent<OpenMergePickerEventDetail>).detail)
  window.addEventListener(openMergePickerEvent, listener)
})
afterEach(() => window.removeEventListener(openMergePickerEvent, listener))

describe('mergeIntoAction', () => {
  it('opens the picker for the focused block, carrying its own workspace', async () => {
    await run(blockStub('src', blockData({ id: 'src', workspaceId: 'ws-9' })))
    expect(opened).toEqual([{ sourceBlockId: 'src', workspaceId: 'ws-9' }])
  })

  it('falls back to load() when the block is not yet in the peek cache', async () => {
    await run(blockStub('src', null, blockData({ id: 'src', workspaceId: 'ws-2' })))
    expect(opened).toEqual([{ sourceBlockId: 'src', workspaceId: 'ws-2' }])
  })

  it('does nothing when the block has no data to merge', async () => {
    await run(blockStub('gone', null, null))
    expect(opened).toEqual([])
  })
})
