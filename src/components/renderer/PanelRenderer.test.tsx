// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ChangeScope, type User } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import type { Block } from '@/data/block'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import { topLevelBlockIdProp } from '@/data/properties'
import { BlockContextProvider } from '@/context/block'
import { resolveFacetRuntimeSync, type FacetRuntime } from '@/extensions/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { PanelRenderer } from './PanelRenderer'

const repoRef = vi.hoisted(() => ({
  current: undefined as Repo | undefined,
}))

vi.mock('@/context/repo', () => ({
  useRepo: () => {
    if (!repoRef.current) throw new Error('test repo not initialised')
    return repoRef.current
  },
}))

vi.mock('@/data/globalState', async () => {
  const actual = await vi.importActual<typeof import('@/data/globalState')>('@/data/globalState')
  return {
    ...actual,
    useSelectionState: () => [
      {selectedBlockIds: [], anchorBlockId: null},
      vi.fn(),
    ],
  }
})

vi.mock('@/shortcuts/useActionContext', () => ({
  useActionContext: vi.fn(),
}))

vi.mock('@/components/BlockComponent.tsx', () => ({
  BlockComponent: ({blockId}: {blockId: string}) => (
    <div data-testid="panel-top-level-block" data-block-id={blockId}/>
  ),
}))

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}

interface Harness {
  h: TestDb
  repo: Repo
  runtime: FacetRuntime
  panel: Block
}

const setup = async (): Promise<Harness> => {
  const h = await createTestDb()
  let txSeq = 0
  const repo = new Repo({
    db: h.db,
    cache: new BlockCache(),
    user: USER,
    newTxSeq: () => ++txSeq,
    startRowEventsTail: false,
  })
  repo.setActiveWorkspaceId(WS)
  const runtime = resolveFacetRuntimeSync([])

  await repo.tx(async tx => {
    await tx.create({
      id: 'page-a',
      workspaceId: WS,
      parentId: null,
      orderKey: 'a0',
      content: 'Page A',
    })
    await tx.create({
      id: 'panel-a',
      workspaceId: WS,
      parentId: null,
      orderKey: 'a1',
      content: 'Panel A',
      properties: {
        [topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode('page-a'),
      },
    })
  }, {scope: ChangeScope.BlockDefault, description: 'create panel renderer fixture'})

  repoRef.current = repo
  return {h, repo, runtime, panel: repo.block('panel-a')}
}

describe('PanelRenderer', () => {
  let env: Harness

  beforeEach(async () => {
    env = await setup()
  })

  afterEach(async () => {
    cleanup()
    repoRef.current = undefined
    await env.h.cleanup()
  })

  const renderPanel = (wideScrollSurface: boolean) =>
    render(
      <AppRuntimeContextProvider value={env.runtime}>
        <BlockContextProvider
          initialValue={{
            layoutBoundary: true,
            panelId: env.panel.id,
            wideScrollSurface,
          }}
        >
          <PanelRenderer block={env.panel}/>
        </BlockContextProvider>
      </AppRuntimeContextProvider>,
    )

  it('constrains content inside a wide scroll surface', async () => {
    renderPanel(true)

    const contentFrame = (await screen.findByTestId('panel-top-level-block')).parentElement
    expect(contentFrame?.className).toContain('mx-auto')
    expect(contentFrame?.className).toContain('max-w-3xl')
  })

  it('does not add a content-width frame for normal panel columns', async () => {
    renderPanel(false)

    const topLevelBlock = await screen.findByTestId('panel-top-level-block')
    expect(topLevelBlock.parentElement?.className).not.toContain('max-w-3xl')
  })
})
