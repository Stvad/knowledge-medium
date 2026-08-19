// @vitest-environment happy-dom
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useRenderer } from '@/hooks/useRendererRegistry'
import { blockRendererFacet } from '@/extensions/blockInteraction.js'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'
import { resolveFacetRuntimeSync, type AppExtension } from '@/facets/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { RepoContext } from '@/context/repo'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { rendererProp, typesProp } from '@/data/properties'
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

const Probe = () => null
const Rival = () => null
const OnDemand = () => null

const render = (
  extensions: AppExtension[],
  context?: BlockRendererProps['context'],
  blockId = 'block-1',
) => {
  const runtime = resolveFacetRuntimeSync(extensions)
  const wrapper = ({children}: {children: ReactNode}) => (
    <RepoContext.Provider value={repo}>
      <AppRuntimeContextProvider value={runtime}>{children}</AppRuntimeContextProvider>
    </RepoContext.Provider>
  )
  return renderHook(() => useRenderer({block: repo.block(blockId), context}), {wrapper})
}

describe('useRenderer selection', () => {
  // Gated purely on a context field, the shape the video-notes renderer uses.
  const modeProbe = blockRendererFacet.of({
    id: 'probe',
    label: 'Probe',
    resolve: ctx => ctx.blockContext?.panelViewMode === 'video-notes' ? {render: Probe} : null,
  }, {source: 'test'})

  it('selects a registration whose resolve claims the block', () => {
    expect(render([modeProbe], {panelViewMode: 'video-notes'}).result.current).toBe(Probe)
  })

  it('falls through to the default when resolve declines', () => {
    expect(render([modeProbe], {}).result.current).toBe(DefaultBlockRenderer)
    expect(render([modeProbe], {panelViewMode: 'other'}).result.current).toBe(DefaultBlockRenderer)
  })

  it('ranks claiming registrations by precedence, not registration order', () => {
    const weak = blockRendererFacet.of(
      {id: 'weak', label: 'Weak', render: Probe}, {source: 'test', precedence: 5})
    const strong = blockRendererFacet.of(
      {id: 'strong', label: 'Strong', render: Rival}, {source: 'test', precedence: 20})
    // Registered strongest-first, so registration order alone would pick Probe.
    expect(render([strong, weak]).result.current).toBe(Rival)
  })
})

describe('useRenderer × the block\'s renderer property', () => {
  const onDemand = blockRendererFacet.of({
    id: 'on-demand',
    label: 'On demand',
    // Applies to every block but never takes one on its own — the shape a
    // renderer that could draw ANYTHING has to register with.
    render: OnDemand,
    claims: false,
  }, {source: 'test', precedence: 100})

  it('leaves a non-claiming registration unselected', () => {
    expect(render([onDemand]).result.current).toBe(DefaultBlockRenderer)
  })

  it('selects one by id when the block names it, over a claiming rival', async () => {
    const rival = blockRendererFacet.of(
      {id: 'rival', label: 'Rival', render: Rival}, {source: 'test', precedence: 200})
    await repo.tx(async tx => { await tx.setProperty('block-1', rendererProp, 'on-demand') },
      {scope: ChangeScope.BlockDefault, description: 'pick renderer'})
    try {
      expect(render([onDemand, rival]).result.current).toBe(OnDemand)
    } finally {
      await repo.tx(async tx => { await tx.unsetProperty('block-1', rendererProp) },
        {scope: ChangeScope.BlockDefault, description: 'clear renderer'})
    }
  })
})

describe('useRenderer × types', () => {
  const typed = blockRendererFacet.of({
    id: 'typed',
    label: 'Typed',
    resolve: ctx => ctx.types.includes('probe-type') ? {render: Probe} : null,
  }, {source: 'test'})

  it('claims on a decoded type', async () => {
    await repo.tx(async tx => { await tx.setProperty('block-1', typesProp, ['probe-type']) },
      {scope: ChangeScope.BlockDefault, description: 'type the block'})
    try {
      expect(render([typed]).result.current).toBe(Probe)
    } finally {
      await repo.tx(async tx => { await tx.unsetProperty('block-1', typesProp) },
        {scope: ChangeScope.BlockDefault, description: 'untype the block'})
    }
  })

  // Resolution runs for every block during its loading window, above
  // BlockComponent's ErrorBoundary. A malformed `types` cell — which the
  // cache boundary does not validate — must degrade to "no types", not throw:
  // every per-type gate used to hand-roll this and now relies on it.
  it('treats a malformed types cell as no types rather than throwing', async () => {
    // Inserted raw, and never loaded before: a `repo.tx` cannot produce this
    // row — the type-ify processor decodes `types` and would throw on the way
    // in — and a raw UPDATE to an already-cached row would leave the resolver
    // reading the old snapshot, passing with the guard deleted. Raw is also
    // the shape a synced or pre-upgrade row arrives in, which is the case
    // this guards.
    await db.db.writeTransaction(async tx => {
      await tx.execute(
        `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content,
           properties_json, references_json, created_at, updated_at, created_by, updated_by, deleted)
         VALUES ('block-malformed', ?, NULL, 'a1', 'Malformed',
           '{"types":"not-an-array"}', '[]', 0, 0, ?, ?, 0)`,
        [WS, USER.id, USER.id],
      )
    })
    await repo.load('block-malformed')
    expect(render([typed], undefined, 'block-malformed').result.current).toBe(DefaultBlockRenderer)
  })
})
