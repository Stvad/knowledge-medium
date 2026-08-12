// @vitest-environment happy-dom
/**
 * The seam itself, not the decision logic: with no plugin impl installed
 * (`defaultImpl`), every paste must stay a plain "not a move" so the
 * ordinary text-paste path is untouched — same contract as
 * `captureMediaVerb`'s "no provider installed" default. The move-blocks
 * plugin's actual decision logic is `pasteAsMoveImpl.test.ts`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import type { Repo } from '@/data/repo.js'
import { Repo as RealRepo } from '@/data/repo'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { keyBetween } from '@/data/orderKey'
import { isCollapsedProp } from '@/data/properties.js'
import { clearPendingMove, setPendingMove } from '@/utils/pendingMove.js'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { pasteAsMoveImpl } from '@/plugins/move-blocks/pasteAsMoveImpl'
import {
  pasteAsMoveVerb,
  resolveVisiblePasteMoveTarget,
  siblingMoveTarget,
  tryPasteAsMove,
  tryPasteAsMoveAt,
  type PasteAsMoveInput,
} from './moveOnPasteVerb.ts'

describe('pasteAsMoveVerb', () => {
  it('defaults to "not a move" (false) with no impl installed', async () => {
    const runtime = resolveFacetRuntimeSync([])
    const input: PasteAsMoveInput = {
      repo: {} as Repo,
      target: { parentId: null, position: { kind: 'last' } },
      clipboardText: 'anything',
    }
    expect(await pasteAsMoveVerb.run(runtime, input)).toBe(false)
  })

  it('runs the registered impl with the input and returns its result', async () => {
    const seen: PasteAsMoveInput[] = []
    const runtime = resolveFacetRuntimeSync([
      pasteAsMoveVerb.impl((i): boolean => { seen.push(i); return true }),
    ])
    const target = { parentId: 'p', position: { kind: 'last' } as const }
    const result = await pasteAsMoveVerb.run(runtime, {
      repo: {} as Repo, target, clipboardText: 'x',
    })
    expect(result).toBe(true)
    expect(seen[0]?.target).toBe(target)
    expect(seen[0]?.clipboardText).toBe('x')
  })
})

describe('tryPasteAsMove', () => {
  const target = { parentId: null, position: { kind: 'last' } as const }

  it('is false without touching the verb when there is no facet runtime yet', async () => {
    const repo = { facetRuntime: null } as unknown as Repo
    expect(await tryPasteAsMove(repo, target, 'some text')).toBe(false)
  })

  // Cutting a genuinely EMPTY block records an empty `clipboardText` in the
  // pending-move register (`cutBlockIdsToClipboard`). If this short-circuited
  // on empty text, that cut could never complete — the block would stay
  // marked forever with no paste able to reach the impl and finish the move.
  it('runs the verb even when the clipboard text is empty — only the text-paste fallback needs its own non-empty guard', async () => {
    const seen: PasteAsMoveInput[] = []
    const runtime = resolveFacetRuntimeSync([
      pasteAsMoveVerb.impl((i): boolean => { seen.push(i); return true }),
    ])
    const repo = { facetRuntime: runtime } as unknown as Repo
    expect(await tryPasteAsMove(repo, target, '')).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.clipboardText).toBe('')
  })

  it('runs the verb through repo.facetRuntime when both are present', async () => {
    const runtime = resolveFacetRuntimeSync([pasteAsMoveVerb.impl(() => true)])
    const repo = { facetRuntime: runtime } as unknown as Repo
    expect(await tryPasteAsMove(repo, target, 'some text')).toBe(true)
  })
})

describe('siblingMoveTarget', () => {
  const block = (parentId: string | null) => ({
    id: 'anchor',
    peek: () => ({ parentId }),
  }) as unknown as Parameters<typeof siblingMoveTarget>[0]

  it('targets the anchor\'s own parent, positioned relative to the anchor', () => {
    expect(siblingMoveTarget(block('parent-1'), 'after')).toEqual({
      parentId: 'parent-1',
      position: { kind: 'after', siblingId: 'anchor' },
    })
    expect(siblingMoveTarget(block('parent-1'), 'before')).toEqual({
      parentId: 'parent-1',
      position: { kind: 'before', siblingId: 'anchor' },
    })
  })

  it('falls back to the workspace root when the anchor has no cached parent', () => {
    expect(siblingMoveTarget(block(null), 'after')).toEqual({
      parentId: null,
      position: { kind: 'after', siblingId: 'anchor' },
    })
  })
})

const WS = 'ws-1'

describe('resolveVisiblePasteMoveTarget / tryPasteAsMoveAt', () => {
  let sharedDb: TestDb
  let repo: RealRepo
  beforeAll(async () => { sharedDb = await createTestDb() })
  afterAll(async () => { await sharedDb.cleanup() })

  const lastKeyByParent = new Map<string, string | null>()
  const seed = async (
    id: string,
    parentId: string | null,
    opts: { collapsed?: boolean } = {},
  ): Promise<void> => {
    const bucket = parentId ?? '__root__'
    const orderKey = keyBetween(lastKeyByParent.get(bucket) ?? null, null)
    lastKeyByParent.set(bucket, orderKey)
    await repo.tx(async tx => {
      await tx.create({ id, workspaceId: WS, parentId, orderKey, content: id })
      if (opts.collapsed) {
        await tx.setProperty(id, isCollapsedProp, true)
      }
    }, { scope: ChangeScope.BlockDefault, description: `seed ${id}` })
  }

  beforeEach(async () => {
    lastKeyByParent.clear()
    await resetTestDb(sharedDb.db)
    repo = createTestRepo({ db: sharedDb.db, user: { id: 'user-1' } }).repo
    repo.setActiveWorkspaceId(WS)
  })

  describe('resolveVisiblePasteMoveTarget', () => {
    it('lands as the target\'s FIRST CHILD when the target is a workspace root (parentId null)', async () => {
      await seed('root', null)
      const target = await resolveVisiblePasteMoveTarget(repo.block('root'), 'after', undefined)
      expect(target).toEqual({ parentId: 'root', position: { kind: 'first' } })
    })

    it('lands as first child when the target IS the render-scope root — even positioned "before" with no children', async () => {
      // 'scope' must NOT itself be a workspace root (that's a separate,
      // independently-true clause — see the test above) — nest it under
      // 'root' so this test actually isolates the scope-root check.
      await seed('root', null)
      await seed('scope', 'root')
      const target = await resolveVisiblePasteMoveTarget(repo.block('scope'), 'before', 'scope')
      expect(target).toEqual({ parentId: 'scope', position: { kind: 'first' } })
    })

    it('lands as first child after an EXPANDED block with visible children, positioned "after"', async () => {
      await seed('parent', null)
      await seed('kid', 'parent')
      const target = await resolveVisiblePasteMoveTarget(repo.block('parent'), 'after', undefined)
      expect(target).toEqual({ parentId: 'parent', position: { kind: 'first' } })
    })

    it('lands as a SIBLING after a COLLAPSED block, even though it has children', async () => {
      // 'parent' must NOT itself be a workspace root — a workspace root
      // always takes children regardless of collapse/position (see the
      // "workspace root" test above) — so nest it under 'root' to actually
      // exercise the collapse check.
      await seed('root', null)
      await seed('parent', 'root', { collapsed: true })
      await seed('kid', 'parent')
      const target = await resolveVisiblePasteMoveTarget(repo.block('parent'), 'after', undefined)
      expect(target).toEqual({ parentId: 'root', position: { kind: 'after', siblingId: 'parent' } })
    })

    it('lands as a SIBLING before a block with visible children — only "after" triggers child placement', async () => {
      await seed('root', null)
      await seed('parent', 'root')
      await seed('kid', 'parent')
      const target = await resolveVisiblePasteMoveTarget(repo.block('parent'), 'before', undefined)
      expect(target).toEqual({ parentId: 'root', position: { kind: 'before', siblingId: 'parent' } })
    })

    it('lands as a sibling after an ordinary childless block outside any scope', async () => {
      await seed('parent', null)
      await seed('leaf', 'parent')
      const target = await resolveVisiblePasteMoveTarget(repo.block('leaf'), 'after', undefined)
      expect(target).toEqual({ parentId: 'parent', position: { kind: 'after', siblingId: 'leaf' } })
    })
  })

  describe('tryPasteAsMoveAt', () => {
    afterEach(() => { clearPendingMove() })

    const withPasteAsMoveInstalled = (): void => {
      repo.setFacetRuntime(resolveFacetRuntimeSync([
        kernelDataExtension,
        pasteAsMoveVerb.impl(pasteAsMoveImpl),
      ]))
    }

    it('returns false without resolving a target when nothing is pending', async () => {
      await seed('scope', null)
      const result = await tryPasteAsMoveAt(repo, repo.block('scope'), 'after', 'scope', 'whatever')
      expect(result).toBe(false)
    })

    it('completes a pending move at a scope root as FIRST CHILD, not literally after it', async () => {
      // This is the case a hardcoded sibling-after target gets wrong: 'scope'
      // is the render-scope root (nested under 'workspaceRoot', so this
      // isolates the scope-root check from the separate workspace-root
      // one), so "after scope" as a sibling would sit OUTSIDE the rendered
      // surface — the moved block would vanish from view even though it
      // landed somewhere in the tree.
      await seed('workspaceRoot', null)
      await seed('scope', 'workspaceRoot')
      await seed('a', 'workspaceRoot')
      withPasteAsMoveInstalled()
      setPendingMove({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })

      const result = await tryPasteAsMoveAt(repo, repo.block('scope'), 'after', 'scope', 'a')

      expect(result).toBe(true)
      expect(repo.block('a').peek()?.parentId).toBe('scope')
    })
  })
})
