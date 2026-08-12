// @vitest-environment node
/**
 * `resolveEditorPasteMove` — the decision `CodeMirrorContentRenderer`'s
 * `handlePaste` uses to decide whether an EDITOR-surface paste (⌘V while
 * actually editing a block's text — the mouse-driven path: click a
 * destination to enter edit mode, then paste) completes a pending cut→move
 * instead of inserting text.
 *
 * Extracted into a standalone function specifically so this is testable:
 * rendering a live CodeMirror instance (via `BlockEditor`/
 * `@uiw/react-codemirror`) to exercise a real `ClipboardEvent` with a
 * working view + dispatch isn't practical in this suite — no existing
 * harness does it, and CodeMirror's view needs a real DOM measurement
 * pass. `handlePaste` itself just calls this function and returns early on
 * `true`, so this test exercises the SAME code the component runs, not a
 * re-implementation of it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { pasteAsMoveVerb } from '@/paste/moveOnPasteVerb'
import { pasteAsMoveImpl } from '@/plugins/move-blocks/pasteAsMoveImpl'
import { clearPendingMove, getPendingMove, setPendingMove } from '@/utils/pendingMove'
import { resolveEditorPasteMove } from './CodeMirrorContentRenderer.tsx'

const WS = 'ws-1'

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({ db: sharedDb.db, user: { id: 'user-1' } }).repo
  repo.setActiveWorkspaceId(WS)
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    pasteAsMoveVerb.impl(pasteAsMoveImpl),
  ]))
  await repo.tx(async tx => {
    await tx.create({ id: 'src', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'src' })
    await tx.create({ id: 'a', workspaceId: WS, parentId: 'src', orderKey: 'a0', content: 'a' })
    await tx.create({ id: 'dest', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'dest' })
    await tx.create({ id: 'kid', workspaceId: WS, parentId: 'dest', orderKey: 'a0', content: 'kid' })
    // 'after' after this too, so root order is [src, dest, after] and a
    // sibling-AFTER-dest landing is distinguishable from sibling-BEFORE.
    await tx.create({ id: 'after', workspaceId: WS, parentId: null, orderKey: 'a2', content: 'after' })
  }, { scope: ChangeScope.BlockDefault, description: 'seed' })
})

afterEach(() => { clearPendingMove() })

const childIds = async (parentId: string): Promise<string[]> => {
  const rows = await repo.db.getAll<{ id: string }>(
    'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id',
    [parentId],
  )
  return rows.map(r => r.id)
}

const rootChildIds = async (): Promise<string[]> => {
  const rows = await repo.db.getAll<{ id: string }>(
    'SELECT id FROM blocks WHERE parent_id IS NULL AND deleted = 0 ORDER BY order_key, id',
  )
  return rows.map(r => r.id)
}

describe('resolveEditorPasteMove', () => {
  it('returns false and touches nothing when nothing is pending — this is the common case for every ordinary editor paste', async () => {
    const result = await resolveEditorPasteMove(repo, repo.block('dest'), 'some pasted text')
    expect(result).toBe(false)
    expect(await childIds('dest')).toEqual(['kid'])
  })

  it('completes the move — clicking into "dest" (entering edit mode) then pasting the cut block relocates it, with the SAME id, instead of duplicating it, positioned immediately AFTER "dest"', async () => {
    setPendingMove({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })

    const result = await resolveEditorPasteMove(repo, repo.block('dest'), 'a')

    expect(result).toBe(true)
    // Moved, not duplicated: the SAME id 'a' is now a sibling of 'dest' —
    // not a new id minted from re-parsing the pasted text — and it's gone
    // from 'src', where it used to live. Landing order pins 'after' (not
    // 'before'): dest, THEN a, then the pre-existing 'after' sibling.
    expect(repo.block('a').peek()?.parentId).toBeNull()
    expect(await childIds('src')).toEqual([])
    expect(await rootChildIds()).toEqual(['src', 'dest', 'a', 'after'])
    expect(getPendingMove()).toBeNull()
  })

  it('targets sibling-AFTER the destination — not first-child — even when the destination has visible children', async () => {
    // The editor surface's own fallback (`pasteEditModeMultilineText`)
    // hardcodes `placement: 'sibling'` regardless of the target's
    // children, unlike the outline-level "visible" placement policy — so
    // the move target must match that, not the visible-placement rule.
    setPendingMove({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })

    await resolveEditorPasteMove(repo, repo.block('dest'), 'a')

    // 'a' landed as a SIBLING of 'dest' at the workspace root, not as a
    // child of 'dest' alongside 'kid'.
    expect(repo.block('a').peek()?.parentId).toBeNull()
    expect(await childIds('dest')).toEqual(['kid']) // unchanged — 'a' did NOT land here
  })

  it('is a no-op fallback (not a move) when the pasted text does not match the pending move\'s clipboard text', async () => {
    setPendingMove({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })

    const result = await resolveEditorPasteMove(repo, repo.block('dest'), 'unrelated pasted text')

    expect(result).toBe(false)
    expect(repo.block('a').peek()?.parentId).toBe('src') // untouched
  })

  // Cutting a genuinely EMPTY block records an empty clipboardText. If this
  // helper (or `tryPasteAsMove` underneath it) refused on empty text, that
  // cut could never complete via the editor surface — the block would stay
  // marked forever every time the user clicks in and pastes.
  it('completes the move even when the pasted text is empty, matching an empty-block cut', async () => {
    await repo.block('a').setContent('')
    setPendingMove({ blockIds: ['a'], workspaceId: WS, clipboardText: '' })

    const result = await resolveEditorPasteMove(repo, repo.block('dest'), '')

    expect(result).toBe(true)
    expect(repo.block('a').peek()?.parentId).toBeNull()
  })
})
