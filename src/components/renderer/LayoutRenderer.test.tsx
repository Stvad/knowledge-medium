// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { User } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { getLayoutSessionBlock, getUIStateBlock } from '@/data/stateBlocks'
import { BlockContextProvider, useBlockContext } from '@/context/block'
import { insertPanelRow } from '@/utils/panelLayoutProjection'
import { LayoutRenderer } from './LayoutRenderer'

const isMobileRef = vi.hoisted(() => ({
  current: false,
}))

vi.mock('@/utils/react.tsx', () => ({
  useIsMobile: () => isMobileRef.current,
}))

vi.mock('@/components/BlockComponent.tsx', () => ({
  BlockComponent: ({blockId}: {blockId: string}) => {
    const context = useBlockContext()
    return (
      <div
        data-testid={`block-${blockId}`}
        data-stacked={String(Boolean(context.stackedPanel))}
        data-wide-scroll-surface={String(Boolean(context.wideScrollSurface))}
      />
    )
  },
}))

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}

interface Harness {
  h: TestDb
  repo: Repo
  layoutSessionBlockId: string
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const { repo } = createTestRepo({
    db: h.db,
    user: USER,
    startSyncObserver: false,
  })
  repo.setActiveWorkspaceId(WS)
  const uiState = await getUIStateBlock(repo, WS, USER, {})
  const layoutSessionBlock = await getLayoutSessionBlock(uiState, 'layout-session-a')
  return {h, repo, layoutSessionBlockId: layoutSessionBlock.id}
}

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

describe('LayoutRenderer', () => {
  let env: Harness

  beforeEach(async () => {
    isMobileRef.current = false
    env = await setup()
  })

  afterEach(async () => {
    cleanup()
  })

  const layoutSessionBlock = () => env.repo.block(env.layoutSessionBlockId)

  const renderLayout = () =>
    render(
      <BlockContextProvider initialValue={{layoutBoundary: false}}>
        <LayoutRenderer block={layoutSessionBlock()}/>
      </BlockContextProvider>,
    )

  it('marks a single top-level panel as a wide scroll surface', async () => {
    const panelId = await insertPanelRow(env.repo, layoutSessionBlock(), 'page-a')

    renderLayout()

    const renderedPanel = await screen.findByTestId(`block-${panelId}`)
    expect(renderedPanel).toHaveAttribute('data-wide-scroll-surface', 'true')
    expect(renderedPanel.parentElement?.className).not.toContain('max-w-3xl')
  })

  it('keeps normal column constraints when multiple top-level panels are present', async () => {
    const firstPanelId = await insertPanelRow(env.repo, layoutSessionBlock(), 'page-a')
    const secondPanelId = await insertPanelRow(env.repo, layoutSessionBlock(), 'page-b')

    renderLayout()

    const firstPanel = await screen.findByTestId(`block-${firstPanelId}`)
    const secondPanel = await screen.findByTestId(`block-${secondPanelId}`)
    expect(firstPanel).toHaveAttribute('data-wide-scroll-surface', 'false')
    expect(secondPanel).toHaveAttribute('data-wide-scroll-surface', 'false')
    expect(firstPanel.parentElement?.className).toContain('max-w-3xl')
    expect(secondPanel.parentElement?.className).toContain('max-w-3xl')
  })

  it('uses the wide scroll surface for the active mobile panel', async () => {
    isMobileRef.current = true
    await insertPanelRow(env.repo, layoutSessionBlock(), 'page-a')
    const secondPanelId = await insertPanelRow(env.repo, layoutSessionBlock(), 'page-b')

    renderLayout()

    expect(await screen.findByTestId(`block-${secondPanelId}`)).toHaveAttribute(
      'data-wide-scroll-surface',
      'true',
    )
  })
})
