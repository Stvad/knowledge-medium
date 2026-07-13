// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '@/data/repo'
import type { Block } from '@/data/block'
import {
  focusedBlockLocationProp,
  scrollTopProp,
  topLevelBlockIdProp,
} from '@/data/properties'
import { panelHistory } from '@/utils/panelHistory'
import { navigate } from '@/utils/navigation'

const mocks = vi.hoisted(() => ({
  getUIStateBlock: vi.fn(),
  getLayoutSessionBlock: vi.fn(),
}))

vi.mock('@/context/repo', () => ({
  useRepo: vi.fn(),
}))

vi.mock('@/data/stateBlocks', () => ({
  getUIStateBlock: mocks.getUIStateBlock,
  getLayoutSessionBlock: mocks.getLayoutSessionBlock,
}))

describe('navigate explicit panel', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    panelHistory.clear('panel-a')
    mocks.getUIStateBlock.mockReset()
    mocks.getLayoutSessionBlock.mockReset()
  })

  it('updates the panel even when active-panel bookkeeping fails', async () => {
    const writes: Array<{blockId: string; property: string; value: unknown}> = []
    const repo = {
      activeWorkspaceId: 'workspace',
      user: {id: 'user-1', name: 'Alice'},
      block: vi.fn(),
      exists: vi.fn(async () => true),
      tx: vi.fn(async (
        fn: (tx: {
          getProperty: (blockId: string, schema: {name: string}) => Promise<undefined>
          setProperty: (blockId: string, schema: {name: string}, value: unknown) => Promise<void>
        }) => Promise<void>,
      ) => {
        await fn({
          // writePanelContent reads the current mode to skip a matching
          // write; undefined → no mode write lands in `writes` below.
          getProperty: async () => undefined,
          setProperty: async (blockId, schema, value) => {
            writes.push({blockId, property: schema.name, value})
          },
        })
      }),
    } as unknown as Repo
    const panel = {
      id: 'panel-a',
      repo,
      peekProperty: vi.fn((schema: {name: string}) =>
        schema.name === topLevelBlockIdProp.name ? 'previous-block' : undefined,
      ),
    } as unknown as Block
    vi.mocked(repo.block).mockReturnValue(panel)
    mocks.getUIStateBlock.mockRejectedValue(new Error('layout unavailable'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    navigate(repo, {
      blockId: 'next-block',
      workspaceId: 'workspace',
      target: 'panel',
      panelId: 'panel-a',
    })

    await vi.waitFor(() => {
      expect(writes).toEqual([
        {blockId: 'panel-a', property: topLevelBlockIdProp.name, value: 'next-block'},
        {
          blockId: 'panel-a',
          property: focusedBlockLocationProp.name,
          value: {blockId: 'next-block', renderScopeId: 'outline:next-block'},
        },
        {blockId: 'panel-a', property: scrollTopProp.name, value: 0},
      ])
    })
    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        '[navigation] Failed to mark panel active after navigation',
        expect.any(Error),
      )
    })
  })
})
