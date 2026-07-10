// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import { applyToAllBlocksInSelection, defineBlocksAction, multiSelectActionId } from '../utils.ts'
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
      {block, uiStateBlock: block, renderVisibilityPolicy: {}},
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
      {selectedBlocks, anchorBlock: null, uiStateBlock, renderVisibilityPolicy: {}},
      new CustomEvent('test'),
    )
    expect(flow).toHaveBeenCalledTimes(1)
    expect(flow).toHaveBeenCalledWith(selectedBlocks)
  })

  it('omits isVisible on NORMAL_MODE when no per-block predicate is supplied', () => {
    const pair = defineBlocksAction({
      id: 'test.op',
      blockDescription: 'block',
      blocksDescription: 'blocks',
      flow: async () => undefined,
    })
    expect(pair.block.isVisible).toBeUndefined()
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
    expect(pair.block.isVisible!({block: yes, uiStateBlock: yes, renderVisibilityPolicy: {}})).toBe(true)
    expect(pair.block.isVisible!({block: no, uiStateBlock: no, renderVisibilityPolicy: {}})).toBe(false)

    // MULTI_SELECT_MODE — true when at least one selected block
    // applies; false for empty selections; false when nothing in
    // the selection applies.
    expect(
      pair.blocks.isVisible!({selectedBlocks: [yes, no], anchorBlock: null, uiStateBlock: yes, renderVisibilityPolicy: {}}),
    ).toBe(true)
    expect(
      pair.blocks.isVisible!({selectedBlocks: [no, no], anchorBlock: null, uiStateBlock: no, renderVisibilityPolicy: {}}),
    ).toBe(false)
    expect(
      pair.blocks.isVisible!({selectedBlocks: [], anchorBlock: null, uiStateBlock: no, renderVisibilityPolicy: {}}),
    ).toBe(false)
  })

  it('MULTI_SELECT isVisible rejects empty selections even without appliesTo', () => {
    const pair = defineBlocksAction({
      id: 'test.op',
      blockDescription: 'block',
      blocksDescription: 'blocks',
      flow: async () => undefined,
    })
    expect(
      pair.blocks.isVisible!({
        selectedBlocks: [],
        anchorBlock: null,
        uiStateBlock: fakeBlock('ui'),
        renderVisibilityPolicy: {},
      }),
    ).toBe(false)
    expect(
      pair.blocks.isVisible!({
        selectedBlocks: [fakeBlock('a')],
        anchorBlock: null,
        uiStateBlock: fakeBlock('ui'),
        renderVisibilityPolicy: {},
      }),
    ).toBe(true)
  })
})

describe('applyToAllBlocksInSelection', () => {
  it('forwards the surface visibility policy to every block action', async () => {
    const handler = vi.fn(async () => undefined)
    const action = applyToAllBlocksInSelection({
      id: 'test.op',
      context: ActionContextTypes.NORMAL_MODE,
      description: 'do the thing',
      handler,
    })
    const selectedBlocks = [fakeBlock('a'), fakeBlock('b')]
    const renderVisibilityPolicy = {forceOpenBlockIds: ['ancestor']}
    const uiStateBlock = {
      id: 'ui',
      repo: {facetRuntime: undefined},
    } as unknown as Block

    await action.handler({
      selectedBlocks,
      anchorBlock: selectedBlocks[0],
      uiStateBlock,
      scopeRootId: 'root',
      renderVisibilityPolicy,
    }, new CustomEvent('test'))

    expect(handler).toHaveBeenCalledTimes(2)
    expect(handler).toHaveBeenNthCalledWith(1, {
      block: selectedBlocks[0],
      uiStateBlock,
      scopeRootId: 'root',
      renderVisibilityPolicy,
    }, expect.any(CustomEvent))
    expect(handler).toHaveBeenNthCalledWith(2, {
      block: selectedBlocks[1],
      uiStateBlock,
      scopeRootId: 'root',
      renderVisibilityPolicy,
    }, expect.any(CustomEvent))
  })
})
