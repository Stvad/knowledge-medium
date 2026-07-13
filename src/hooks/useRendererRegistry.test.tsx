// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useRenderer } from '@/hooks/useRendererRegistry'
import { blockRenderersFacet } from '@/extensions/core.js'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import { ChangeScope, type User } from '@/data/api'
import type { BlockRendererProps } from '@/types'

const USER: User = {id: 'user-1', name: 'Alice'}
const WS = 'ws-1'

let db: TestDb
let repo: Repo

beforeAll(async () => {
  db = await createTestDb()
  repo = createTestRepo({db: db.db, user: USER}).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({
      id: 'block-1',
      workspaceId: WS,
      parentId: null,
      orderKey: 'a0',
      content: 'Block',
    })
  }, {scope: ChangeScope.BlockDefault, description: 'seed renderer probe block'})
  await repo.load('block-1')
})

afterAll(async () => { await db.cleanup() })

// A probe renderer that opts in purely on the panelViewMode context field —
// the shape the video-notes renderer (slice 5) will use.
const Probe = () => null
Probe.canRender = ({context}: BlockRendererProps) => context?.panelViewMode === 'video-notes'
Probe.priority = () => 100

describe('useRenderer × panelViewMode context', () => {
  const run = (context: BlockRendererProps['context']) => {
    const runtime = resolveFacetRuntimeSync([
      blockRenderersFacet.of({id: 'probe', renderer: Probe}, {source: 'test'}),
    ])
    const wrapper = ({children}: {children: ReactNode}) => (
      <AppRuntimeContextProvider value={runtime}>{children}</AppRuntimeContextProvider>
    )
    return renderHook(() => useRenderer({block: repo.block('block-1'), context}), {wrapper})
  }

  it('selects a canRender(panelViewMode) contribution when the context carries the mode', () => {
    expect(run({panelViewMode: 'video-notes'}).result.current).toBe(Probe)
  })

  it('does not select it when the context lacks the mode', () => {
    expect(run({}).result.current).not.toBe(Probe)
  })

  it('does not select it for a different mode value', () => {
    expect(run({panelViewMode: 'other'}).result.current).not.toBe(Probe)
  })
})
