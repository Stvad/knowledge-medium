// @vitest-environment node
/**
 * Stateful fuzz suite for `pasteMultilineText`'s PLACEMENT — the half of
 * `src/paste/operations.ts` that writes to the DB. Its sibling
 * `operations.fuzz.test.ts` owns the pure planners; a property about where
 * pasted blocks LAND belongs here, where there is a DB to land them in. See
 * `src/test/fuzz.ts` for the smoke/deep tier mechanics and `docs/fuzzing.md`
 * §6 for the shared-DB interrupt hazard `statefulFuzzGuard` guards.
 *
 * ──── What is NOT asserted, and why ────
 *
 * DEPTH is deliberately absent. A blank target absorbs a pasted root, so its
 * own children and the clipboard's roots #2..N can end up sharing a child
 * list — a flat clipboard comes out nested, and a nested one comes out one
 * level shallower on a zoomed target. Both are accepted behaviour with
 * example tests spelling them out (`operations.test.ts`) and an open issue
 * (#645), so a depth oracle would pin that rather than a contract.
 *
 * CONTIGUITY is absent for the same reason: the target's own pre-existing
 * children sit between the absorbed root's subtree and roots #2..N, so the
 * pasted blocks are not a contiguous pre-order run.
 *
 * What survives is the part every branch does agree on:
 *
 * 1. ORDER + CONSERVATION — each clipboard line appears exactly once in the
 *    tree afterwards, and the pasted lines' relative pre-order is the
 *    clipboard's own line order. (Reading order is preserved even where
 *    nesting is not.)
 * 2. NO COLLATERAL — every pre-existing block survives with its relative
 *    pre-order unchanged. The tie-breaking re-key in `keysImmediatelyBefore`
 *    / `keysImmediatelyAfter` moves existing siblings, so this is a live
 *    check, not a triviality: it pins that those moves preserve order.
 * 3. SLOT CONTAINMENT — no pasted block escapes the target's slot: all of
 *    them land after everything that preceded the target in pre-order, and
 *    before everything that followed the target's subtree. This is what
 *    makes `position` meaningful at all, and it holds in every branch —
 *    sibling-run either side, first-child insert, and the re-key paths.
 * 4. RETURN ORDER — `pasteMultilineText` returns the root-level pasted
 *    blocks in CLIPBOARD order. Both `position: 'before'` call sites (vim
 *    `Shift+P`, `paste_before_selection`) focus `pasted[0]`, and the
 *    absorbed root is not always #1.
 * 5. SIDE — a root placed as a SIBLING of the target lands on the side
 *    `position` names. Restricted to siblings on purpose: a root that landed
 *    in the target's child list is inside it, which no `position` contradicts,
 *    and the absorbed root IS the target, so neither has a side to check.
 *
 * Determinism: order-key placement jitters via `Math.random`
 * (`fractional-indexing-jittered`), so every case pins a seeded LCG through
 * `guard.run`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout, statefulFuzzGuard } from '@/test/fuzz'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { ChangeScope } from '@/data/api'
import { SUBTREE_SQL } from '@/data/internals/treeQueries'
import { isCollapsedProp } from '@/data/properties'
import type { Repo } from '@/data/repo'
import { pasteMultilineText } from '../operations'

const WS = 'ws-1'
const ROOT = 'root'
const PAGE = 'page'

/** Pre-order (id, content) of the whole tree — `SUBTREE_SQL` orders by the
 *  materialized order-key path, i.e. exactly the outline's reading order. */
const preorder = async (db: TestDb['db']): Promise<Array<{id: string; content: string}>> =>
  (await db.getAll<{id: string; content: string}>(SUBTREE_SQL, [ROOT]))
    .map(row => ({id: row.id, content: row.content}))

/** Depths clamped so each line is at most one level deeper than the previous
 *  one — the shape markdown can actually express (a further jump renders as
 *  the same level). Depth 0 lines are the clipboard's roots. */
const normalizeDepths = (raw: readonly number[]): number[] => {
  const out: number[] = []
  for (const d of raw) out.push(Math.min(d, (out.at(-1) ?? -1) + 1))
  return out
}

interface Case {
  depths: number[]
  siblingCount: number
  targetIx: number
  targetChildCount: number
  targetBlank: boolean
  targetCollapsed: boolean
  scopeIsTarget: boolean
  tiedSiblings: boolean
  position: 'before' | 'after'
  placement: 'visible' | 'sibling'
}

const caseArb = fc.record({
  depths: fc.array(fc.nat(2), {minLength: 1, maxLength: 5}).map(normalizeDepths),
  siblingCount: fc.integer({min: 1, max: 3}),
  targetIx: fc.nat(3),
  targetChildCount: fc.nat(2),
  targetBlank: fc.boolean(),
  targetCollapsed: fc.boolean(),
  scopeIsTarget: fc.boolean(),
  tiedSiblings: fc.boolean(),
  position: fc.constantFrom('before' as const, 'after' as const),
  placement: fc.constantFrom('visible' as const, 'sibling' as const),
  prngSeed: fc.integer({min: 1, max: 2 ** 31 - 2}),
})

const create = (
  repo: Repo, id: string, content: string, parentId: string | null, orderKey: string,
): Promise<unknown> => repo.tx(
  tx => tx.create({id, workspaceId: WS, parentId, orderKey, content}),
  {scope: ChangeScope.BlockDefault},
)

const runCase = async (c: Case): Promise<void> => {
  const {db} = sharedDb
  await resetTestDb(db)
  const {repo} = createTestRepo({db, user: {id: 'user-1'}})

  // `page`'s children are the sibling run; the target is one of them, or
  // `page` itself (the zoomed / scope-root shape). All contents are unique so
  // a content sequence identifies blocks unambiguously.
  await create(repo, ROOT, 'Root', null, 'a0')
  await create(repo, PAGE, 'Page', ROOT, 'a0')
  const siblings = Array.from({length: c.siblingCount}, (_, i) => `E${i}`)
  for (const [i, id] of siblings.entries()) {
    // A shared key across the whole run exercises the tie-breaking re-key in
    // `keysImmediatelyBefore` / `keysImmediatelyAfter`; ties sort by id.
    await create(repo, id, id, PAGE, c.tiedSiblings ? 'a1' : `a${i}`)
  }
  const targetId = [PAGE, ...siblings][c.targetIx % (siblings.length + 1)]
  for (let i = 0; i < c.targetChildCount; i++) {
    await create(repo, `C${i}`, `C${i}`, targetId, `a${i}`)
  }
  if (c.targetBlank) {
    await repo.tx(tx => tx.update(targetId, {content: ''}), {scope: ChangeScope.BlockDefault})
  }
  if (c.targetCollapsed) {
    await repo.mutate.setProperty({id: targetId, schema: isCollapsedProp, value: true})
  }

  const lines = c.depths.map((depth, i) => `${'  '.repeat(depth)}- L${i}`)
  const lineContents = c.depths.map((_, i) => `L${i}`)
  const lineSet = new Set(lineContents)

  const before = await preorder(db)
  const targetIx = before.findIndex(row => row.id === targetId)
  // The seed gives the target only direct children, so its subtree is the
  // contiguous pre-order run `[targetIx, targetIx + 1 + targetChildCount)`.
  const subtreeEnd = targetIx + 1 + c.targetChildCount
  const precedingIds = before.slice(0, targetIx).map(row => row.id)
  const followingIds = before.slice(subtreeEnd).map(row => row.id)

  const pasted = await pasteMultilineText(lines.join('\n'), repo.block(targetId), repo, {
    position: c.position,
    placement: c.placement,
    scopeRootId: c.scopeIsTarget ? targetId : PAGE,
  })

  const after = await preorder(db)
  const index = new Map(after.map((row, i) => [row.id, i]))

  // 1. order + conservation
  expect(after.map(row => row.content).filter(content => lineSet.has(content)),
    'clipboard lines appear exactly once each, in clipboard order').toEqual(lineContents)

  // 2. no collateral
  const beforeIds = before.map(row => row.id)
  const beforeIdSet = new Set(beforeIds)
  expect(after.map(row => row.id).filter(id => beforeIdSet.has(id)),
    'pre-existing blocks all survive, in their original relative order').toEqual(beforeIds)

  // 3. slot containment. `precedingIds` is never empty (the root and the page
  // precede every candidate target), so `lo` is a real bound; nothing follows
  // a `page` target's subtree, so `hi` falls back to the end.
  const lo = Math.max(...precedingIds.map(id => index.get(id) ?? -1))
  const hi = followingIds.length === 0
    ? after.length
    : Math.min(...followingIds.map(id => index.get(id) ?? after.length))
  for (const [i, row] of after.entries()) {
    if (!lineSet.has(row.content)) continue
    expect(i, `pasted ${row.content} escaped the target slot`).toBeGreaterThan(lo)
    expect(i, `pasted ${row.content} escaped the target slot`).toBeLessThan(hi)
  }

  // 4. return order
  expect(pasted.map(block => block.peek()?.content),
    'returns the root-level pasted blocks in clipboard order')
    .toEqual(lineContents.filter((_, i) => c.depths[i] === 0))

  // 5. `position` means what it says — but only for roots placed as SIBLINGS
  // of the target. A root that landed in the target's child list is inside it,
  // which no `position` claims to contradict, and the absorbed root IS the
  // target, so neither has a side to check.
  const targetParentId = targetId === PAGE ? ROOT : PAGE
  const targetIndex = index.get(targetId) ?? -1
  for (const block of pasted) {
    const data = block.peek()
    if (!data || data.id === targetId || data.parentId !== targetParentId) continue
    const side = (index.get(data.id) ?? -1) < targetIndex ? 'before' : 'after'
    expect(side, `pasted ${data.content} landed on the wrong side of the target`).toBe(c.position)
  }
}

let sharedDb: TestDb
const guard = statefulFuzzGuard()
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => {
  await guard.barrier()
  await sharedDb.cleanup()
})

describe('pasteMultilineText placement', () => {
  it('preserves clipboard order and stays inside the target slot', async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, ({prngSeed, ...c}) => guard.run(prngSeed, () => runCase(c))),
      fuzzParams(50),
    )
  }, fuzzTestTimeout())
})
