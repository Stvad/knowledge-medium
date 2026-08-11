// @vitest-environment happy-dom
/**
 * The seam itself, not the decision logic: with no plugin impl installed
 * (`defaultImpl`), every paste must stay a plain "not a move" so the
 * ordinary text-paste path is untouched — same contract as
 * `captureMediaVerb`'s "no provider installed" default. The move-blocks
 * plugin's actual decision logic is `pasteAsMoveImpl.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '@/data/repo.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import {
  pasteAsMoveVerb,
  siblingMoveTarget,
  tryPasteAsMove,
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

  it('is false without touching the verb when the clipboard text is empty', async () => {
    const impl = vi.fn()
    const runtime = resolveFacetRuntimeSync([pasteAsMoveVerb.impl(impl)])
    const repo = { facetRuntime: runtime } as unknown as Repo
    expect(await tryPasteAsMove(repo, target, '')).toBe(false)
    expect(impl).not.toHaveBeenCalled()
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
