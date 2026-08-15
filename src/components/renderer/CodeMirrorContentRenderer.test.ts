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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { pasteAsMoveVerb } from '@/paste/moveOnPasteVerb'
import { pasteAsMoveImpl } from '@/plugins/move-blocks/pasteAsMoveImpl'
import type { ClipboardPayload } from '@/paste/clipboardPayload.js'
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
    // A NON-root destination that has visible children, for telling the
    // placement-sensitive rule apart from the root rules.
    await tx.create({ id: 'outer', workspaceId: WS, parentId: null, orderKey: 'a3', content: 'outer' })
    await tx.create({ id: 'inner', workspaceId: WS, parentId: 'outer', orderKey: 'a0', content: 'inner' })
    await tx.create({ id: 'innerkid', workspaceId: WS, parentId: 'inner', orderKey: 'a0', content: 'innerkid' })
    await tx.create({ id: 'inner2', workspaceId: WS, parentId: 'outer', orderKey: 'a1', content: 'inner2' })
  }, { scope: ChangeScope.BlockDefault, description: 'seed' })
})

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

const cutPayload = (blockIds: string[]): ClipboardPayload => ({ blockIds, workspaceId: WS, intent: 'cut' })

describe('resolveEditorPasteMove', () => {
  it('returns false and touches nothing when there is no payload — this is the common case for every ordinary editor paste', async () => {
    const result = await resolveEditorPasteMove(repo, repo.block('dest'), null, undefined)
    expect(result).toBe(false)
    expect(await childIds('dest')).toEqual(['kid'])
  })

  it('completes the move — clicking into "dest" (entering edit mode) then pasting the cut block relocates it with the SAME id instead of duplicating it', async () => {
    const result = await resolveEditorPasteMove(repo, repo.block('dest'), cutPayload(['a']), undefined)

    expect(result).toBe(true)
    // Moved, not duplicated: the SAME id 'a' — not a new id minted from
    // re-parsing the pasted text — and it's gone from 'src' where it used
    // to live. 'dest' is a WORKSPACE ROOT, so it lands as dest's first
    // child: `resolveRootDestination` puts a text paste there for the same
    // reason (a root has no representable sibling slot), and the move has
    // to agree with the paste it replaces.
    expect(repo.block('a').peek()?.parentId).toBe('dest')
    expect(await childIds('src')).toEqual([])
    expect(await childIds('dest')).toEqual(['a', 'kid'])
    expect(await rootChildIds()).toEqual(['src', 'dest', 'after', 'outer'])
  })

  it('targets sibling-AFTER a NON-root destination even when it has visible children — that is what placement "sibling" suppresses', async () => {
    // The editor's own fallback (`pasteEditModeMultilineText`) passes
    // `placement: 'sibling'` to `resolveRootDestination`, which switches
    // OFF the "after a block showing its children ⇒ first child" rule.
    // The move target has to match, or completing a cut lands somewhere
    // an ordinary paste at the same caret wouldn't.
    await resolveEditorPasteMove(repo, repo.block('inner'), cutPayload(['a']), undefined)

    // Sibling of 'inner' under 'outer', NOT a child of 'inner' next to
    // 'innerkid'.
    expect(repo.block('a').peek()?.parentId).toBe('outer')
    expect(await childIds('outer')).toEqual(['inner', 'a', 'inner2'])
    expect(await childIds('inner')).toEqual(['innerkid'])
  })

  it('lands INSIDE the render-scope root rather than beside it — a sibling there sits outside the rendered surface', async () => {
    // The bug this pins: with a hardcoded sibling target, pasting while
    // editing the block the surface is zoomed into moved the cut blocks to
    // a slot OUTSIDE that surface. They left the source and never visibly
    // arrived, which reads as data loss. `resolveRootDestination` applies
    // its scope-root rule for BOTH placements, so the move must too.
    // 'inner' is the render-scope root here — the pane is zoomed into it.
    await resolveEditorPasteMove(repo, repo.block('inner'), cutPayload(['a']), 'inner')

    expect(repo.block('a').peek()?.parentId).toBe('inner')
    expect(await childIds('inner')).toEqual(['a', 'innerkid'])
  })

  it('does NOT move on the paste-as-plain-text chord — that command means "insert the text here"', async () => {
    // Cmd/Ctrl+Shift+V. Completing the cut would relocate 'a' and insert
    // nothing at the caret, which is the opposite of what was asked.
    const result = await resolveEditorPasteMove(
      repo, repo.block('dest'), cutPayload(['a']), undefined, 'single-block',
    )

    expect(result).toBe(false)
    expect(repo.block('a').peek()?.parentId).toBe('src') // untouched
  })

  it('still moves on the ordinary paste chord', async () => {
    // The control: same call, default intent.
    const result = await resolveEditorPasteMove(
      repo, repo.block('dest'), cutPayload(['a']), undefined, 'split',
    )

    expect(result).toBe(true)
    expect(repo.block('a').peek()?.parentId).toBe('dest')
  })

  it('is a no-op fallback (not a move) when the payload is a COPY rather than a cut', async () => {
    const payload: ClipboardPayload = { blockIds: ['a'], workspaceId: WS, intent: 'copy' }

    const result = await resolveEditorPasteMove(repo, repo.block('dest'), payload, undefined)

    expect(result).toBe(false)
    expect(repo.block('a').peek()?.parentId).toBe('src') // untouched
  })
})
