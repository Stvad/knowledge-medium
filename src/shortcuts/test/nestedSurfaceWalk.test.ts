// @vitest-environment happy-dom
/**
 * A nested surface a children view declares (a grid, a board) is drawn among
 * its parent's children, but its rows are not the parent's to name: the walk
 * passes over it and says so, and a merge across it is refused.
 *
 *   page
 *     before
 *     host      draws [q, SURFACE] (its other data child is not drawn)
 *       q
 *       machinery
 *     bare      draws [SURFACE]
 *     after
 *     board     draws [c1, SURFACE, c2]
 *       c1
 *       c2
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { EditorView } from '@codemirror/view'
import { ChangeScope, defineQuery, type User } from '@/data/api'
import { childrenViewFacet, type DrawnChild } from '@/data/childrenView'
import { queriesFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { outlineSurfaceOf } from '@/data/outlineSurface'
import type { PropertyDisplayScopeLevels } from '@/data/propertyDisplayMode'
import type { Repo } from '@/data/repo'
import { structuralEditPolicyForBlock } from '@/data/structuralEditPolicy'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { getDefaultActions } from '@/shortcuts/defaultShortcuts'
import {
  ActionContextTypes, type ActionConfig, type ActionTrigger, type CodeMirrorEditModeDependencies,
} from '@/shortcuts/types'
import { getLastVisibleDescendant, nextDrawnStep, nextVisibleBlock, previousDrawnStep } from '@/utils/selection'

const USER: User = {id: 'user-1', name: 'Alice'}
const WS = 'ws-nested-surface-walk'
const DISPLAY: PropertyDisplayScopeLevels = {childBacked: true, workspace: 'none', panel: 'inherit'}
const SURFACE: DrawnChild = {kind: 'nested-surface', renderScopeId: 'surface.test:grid'}
const MEMBERS_QUERY = 'test.members'

declare module '@/data/api' {
  interface QueryRegistry {
    [MEMBERS_QUERY]: typeof membersQuery
  }
}

const AT_SURFACE = '<surface>'

/** A fixed member list, `<surface>` standing for the nested surface. */
const membersQuery = defineQuery<{members: string[]}, DrawnChild[]>({
  name: MEMBERS_QUERY,
  argsSchema: z.object({members: z.array(z.string())}),
  resultSchema: {parse: input => input as DrawnChild[]},
  resolve: async ({members}) => members.map(member => member === AT_SURFACE ? SURFACE : member),
})

const DRAWN: Record<string, string[]> = {host: ['q', AT_SURFACE], bare: [AT_SURFACE], board: ['c1', AT_SURFACE, 'c2']}

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: USER}).repo
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    queriesFacet.of(membersQuery, {source: 'test'}),
    childrenViewFacet.of(({parent}) => DRAWN[parent.id] !== undefined && {
      id: 'test.members',
      read: () => parent.repo.query[MEMBERS_QUERY]({members: DRAWN[parent.id]!}),
    }, {source: 'test'}),
  ]))
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'page'})
    await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0', content: ''})
    await tx.create({id: 'before', workspaceId: WS, parentId: 'page', orderKey: 'a0', content: 'before'})
    await tx.create({id: 'host', workspaceId: WS, parentId: 'page', orderKey: 'a1', content: 'host'})
    await tx.create({id: 'q', workspaceId: WS, parentId: 'host', orderKey: 'a0', content: 'q'})
    await tx.create({id: 'machinery', workspaceId: WS, parentId: 'host', orderKey: 'a1', content: 'machinery'})
    await tx.create({id: 'bare', workspaceId: WS, parentId: 'page', orderKey: 'a2', content: 'bare'})
    await tx.create({id: 'after', workspaceId: WS, parentId: 'page', orderKey: 'a3', content: 'after'})
    await tx.create({id: 'board', workspaceId: WS, parentId: 'page', orderKey: 'a4', content: 'board'})
    await tx.create({id: 'c1', workspaceId: WS, parentId: 'board', orderKey: 'a0', content: 'c1'})
    await tx.create({id: 'c2', workspaceId: WS, parentId: 'board', orderKey: 'a1', content: 'c2'})
  }, {scope: ChangeScope.BlockDefault})
})

const SURFACE_OF_PAGE = () => outlineSurfaceOf({scopeRootId: 'page', propertyDisplay: DISPLAY})!

const editorAt = (content: string, cursor: number): EditorView => {
  const view = {
    dispatch: vi.fn(),
    moveToLineBoundary: (_selection: unknown, forward: boolean) => ({head: forward ? content.length : 0}),
    coordsAtPos: () => ({left: 0, right: 0, top: 0, bottom: 1}),
    state: {
      selection: {main: {empty: true, from: cursor, to: cursor, anchor: cursor, head: cursor}},
      doc: {length: content.length, toString: () => content, sliceString: (from: number, to = content.length) => content.slice(from, to)},
    },
  }
  return view as unknown as EditorView
}

const pressInEditor = async (actionId: string, blockId: string, cursor: 'start' | 'end') => {
  const action = getDefaultActions({repo}).find(
    (candidate): candidate is ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> =>
      candidate.id === actionId && candidate.context === ActionContextTypes.EDIT_MODE_CM)!
  const content = (await repo.load(blockId))!.content
  await action.handler({
    block: repo.block(blockId),
    editorView: editorAt(content, cursor === 'start' ? 0 : content.length),
    uiStateBlock: repo.block('ui'),
    scopeRootId: 'page',
    propertyDisplay: DISPLAY,
  } satisfies CodeMirrorEditModeDependencies, {preventDefault: vi.fn()} as unknown as ActionTrigger)
}

const contentOf = async (id: string) => (await repo.load(id))?.content

describe('a nested surface among drawn children', () => {
  it('the walk passes over it, never into the data children it stands for, and says so', async () => {
    expect((await nextVisibleBlock(repo.block('host'), SURFACE_OF_PAGE()))?.id).toBe('q')
    expect(await nextDrawnStep(repo.block('q'), SURFACE_OF_PAGE())).toMatchObject({block: {id: 'bare'}, crossed: true})
    expect(await nextDrawnStep(repo.block('before'), SURFACE_OF_PAGE())).toMatchObject({block: {id: 'host'}, crossed: false})
    expect(await nextDrawnStep(repo.block('c1'), SURFACE_OF_PAGE())).toMatchObject({block: {id: 'c2'}, crossed: true})
    expect(await previousDrawnStep(repo.block('c2'), SURFACE_OF_PAGE())).toMatchObject({block: {id: 'c1'}, crossed: true})
  })

  it('the descent into a parent whose children end in it steps back to the block drawn before it', async () => {
    expect((await getLastVisibleDescendant(repo.block('host'), SURFACE_OF_PAGE())).id).toBe('q')
    expect((await getLastVisibleDescendant(repo.block('bare'), SURFACE_OF_PAGE())).id).toBe('bare')
    expect(await previousDrawnStep(repo.block('after'), SURFACE_OF_PAGE())).toMatchObject({block: {id: 'bare'}, crossed: true})
    expect(await previousDrawnStep(repo.block('bare'), SURFACE_OF_PAGE())).toMatchObject({block: {id: 'q'}, crossed: true})
  })

  it('counts as children the parent shows', async () => {
    const carrier = {scopeRootId: 'page', propertyDisplay: DISPLAY}
    expect((await structuralEditPolicyForBlock(repo.block('bare'), carrier)).createBelowPlacement).toBe('child-first')
    expect((await structuralEditPolicyForBlock(repo.block('after'), carrier)).createBelowPlacement).toBe('sibling-below')
  })

  it('Backspace does not merge a block into the one drawn above a nested surface', async () => {
    await pressInEditor('delete_empty_block_cm', 'q', 'start')
    expect(await contentOf('host')).toBe('hostq')
    await pressInEditor('delete_empty_block_cm', 'after', 'start')
    expect(await contentOf('after')).toBe('after')
    expect(await contentOf('bare')).toBe('bare')
  })

  it('Delete at a block’s end does not pull up the block past a nested surface', async () => {
    await pressInEditor('merge_next_block_cm', 'bare', 'end')
    expect(await contentOf('after')).toBe('after')
    expect(await contentOf('bare')).toBe('bare')
    await pressInEditor('merge_next_block_cm', 'before', 'end')
    expect(await contentOf('before')).toBe('beforehost')
  })
})
