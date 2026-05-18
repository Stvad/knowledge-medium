// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import { defineBlocksAction, multiSelectActionId } from '../utils.ts'
import { ActionContextTypes } from '../types.ts'

const fakeBlock = (id: string): Block => ({id} as unknown as Block)

describe('defineBlocksAction', () => {
  it('emits a NORMAL_MODE variant that wraps the focused block in a one-element flow call', async () => {
    const flow = vi.fn(async () => undefined)
    const pair = defineBlocksAction({
      id: 'test.op',
      blockDescription: 'do the thing',
      blocksDescription: 'do the thing to selection',
      flow,
    })

    expect(pair.block.id).toBe('test.op')
    expect(pair.block.context).toBe(ActionContextTypes.NORMAL_MODE)
    expect(pair.block.description).toBe('do the thing')

    const block = fakeBlock('a')
    await pair.block.handler(
      {block, uiStateBlock: block},
      new CustomEvent('test'),
    )
    expect(flow).toHaveBeenCalledTimes(1)
    expect(flow).toHaveBeenCalledWith([block])
  })

  it('emits a MULTI_SELECT_MODE variant under a multi_select-prefixed id', async () => {
    const flow = vi.fn(async () => undefined)
    const pair = defineBlocksAction({
      id: 'test.op',
      blockDescription: 'one',
      blocksDescription: 'many',
      flow,
    })

    // Distinct id keeps palette dispatch unambiguous: clicking the
    // "block" row runs the NORMAL_MODE handler, clicking the
    // "blocks" row runs the MULTI_SELECT_MODE handler, even when
    // both contexts are active simultaneously.
    expect(pair.blocks.id).toBe(multiSelectActionId('test.op'))
    expect(pair.blocks.id).not.toBe(pair.block.id)
    expect(pair.blocks.context).toBe(ActionContextTypes.MULTI_SELECT_MODE)
    expect(pair.blocks.description).toBe('many')

    const selectedBlocks = [fakeBlock('a'), fakeBlock('b')]
    const uiStateBlock = fakeBlock('ui')
    await pair.blocks.handler(
      {selectedBlocks, anchorBlock: null, uiStateBlock},
      new CustomEvent('test'),
    )
    expect(flow).toHaveBeenCalledTimes(1)
    expect(flow).toHaveBeenCalledWith(selectedBlocks)
  })

  it('omits canRun on NORMAL_MODE when no per-block predicate is supplied', () => {
    const pair = defineBlocksAction({
      id: 'test.op',
      blockDescription: 'block',
      blocksDescription: 'blocks',
      flow: async () => undefined,
    })
    expect(pair.block.canRun).toBeUndefined()
  })

  it('routes appliesTo through both variants', () => {
    const appliesTo = vi.fn((block: Block) => block.id === 'yes')
    const pair = defineBlocksAction({
      id: 'test.op',
      blockDescription: 'block',
      blocksDescription: 'blocks',
      appliesTo,
      flow: async () => undefined,
    })

    const yes = fakeBlock('yes')
    const no = fakeBlock('no')

    // NORMAL_MODE — predicate runs against the focused block.
    expect(pair.block.canRun!({block: yes, uiStateBlock: yes})).toBe(true)
    expect(pair.block.canRun!({block: no, uiStateBlock: no})).toBe(false)

    // MULTI_SELECT_MODE — true when at least one selected block
    // applies; false for empty selections; false when nothing in
    // the selection applies.
    expect(
      pair.blocks.canRun!({selectedBlocks: [yes, no], anchorBlock: null, uiStateBlock: yes}),
    ).toBe(true)
    expect(
      pair.blocks.canRun!({selectedBlocks: [no, no], anchorBlock: null, uiStateBlock: no}),
    ).toBe(false)
    expect(
      pair.blocks.canRun!({selectedBlocks: [], anchorBlock: null, uiStateBlock: no}),
    ).toBe(false)
  })

  it('MULTI_SELECT canRun rejects empty selections even without appliesTo', () => {
    const pair = defineBlocksAction({
      id: 'test.op',
      blockDescription: 'block',
      blocksDescription: 'blocks',
      flow: async () => undefined,
    })
    expect(
      pair.blocks.canRun!({
        selectedBlocks: [],
        anchorBlock: null,
        uiStateBlock: fakeBlock('ui'),
      }),
    ).toBe(false)
    expect(
      pair.blocks.canRun!({
        selectedBlocks: [fakeBlock('a')],
        anchorBlock: null,
        uiStateBlock: fakeBlock('ui'),
      }),
    ).toBe(true)
  })
})
