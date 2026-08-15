// @vitest-environment happy-dom
/**
 * `paste_after` / `paste_before` (bound to `p` / `Shift+p` in NORMAL_MODE)
 * completing a pending cut→move (block-move-ui review item D).
 *
 * NORMAL_MODE is activated SOLELY by the vim plugin, and it's the ONLY
 * surface that can reach single-block `cut_block` (`$mod+x` in normal
 * mode) — so before this fix, vim users were the only ones who could
 * invoke a single-block cut but never complete it as a move: `p`/`Shift+p`
 * called `pasteFromClipboard` directly, never `tryPasteAsMove`, so cut→p
 * silently re-parsed the cut markdown into new blocks while the originals
 * (never deleted) stayed put.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { pasteAsMoveVerb } from '@/paste/moveOnPasteVerb'
import { pasteAsMoveImpl } from '@/plugins/move-blocks/pasteAsMoveImpl'
import { rememberPayload, resetRememberedPayloads } from '@/paste/clipboardPayload'
import { ActionContextTypes, type ActionConfig, type ActionTrigger, type BlockShortcutDependencies } from '@/shortcuts/types'
import { getVimNormalModeActions } from '../actions.ts'

const WS = 'ws-1'

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  resetRememberedPayloads()
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({ db: sharedDb.db, user: { id: 'user-1' } }).repo
  repo.setActiveWorkspaceId(WS)
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    pasteAsMoveVerb.impl(pasteAsMoveImpl),
  ]))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const childIds = async (parentId: string): Promise<string[]> => {
  const rows = await repo.db.getAll<{ id: string }>(
    'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id',
    [parentId],
  )
  return rows.map(r => r.id)
}

const findAction = (id: string): ActionConfig<typeof ActionContextTypes.NORMAL_MODE> => {
  const action = getVimNormalModeActions({ repo }).find(a => a.id === id)
  if (!action) throw new Error(`action not found: ${id}`)
  return action
}

const trigger = { preventDefault: vi.fn() } as unknown as ActionTrigger

/** Seeds `root` → `{src → a, dest}`. `dest` is deliberately nested under
 *  `root` rather than itself being a workspace root — a workspace root
 *  always takes pasted/moved content as children regardless of position
 *  (see `resolveVisiblePasteMoveTarget`'s doc), which would mask whether a
 *  test is actually landing "after" vs "as a child". */
const seed = async (): Promise<void> => {
  await repo.tx(async tx => {
    await tx.create({ id: 'root', workspaceId: WS, parentId: null, orderKey: 'r0', content: 'root' })
    await tx.create({ id: 'src', workspaceId: WS, parentId: 'root', orderKey: 'a0', content: 'src' })
    await tx.create({ id: 'a', workspaceId: WS, parentId: 'src', orderKey: 'a0', content: 'a' })
    await tx.create({ id: 'dest', workspaceId: WS, parentId: 'root', orderKey: 'a1', content: 'dest' })
  }, { scope: ChangeScope.BlockDefault })
}

describe('vim paste_after / paste_before completing a pending cut as a move', () => {
  it('paste_after moves the cut block (same id) instead of duplicating it, when the pasted text matches the remembered payload', async () => {
    await seed()
    rememberPayload('a', { blockIds: ['a'], workspaceId: WS, intent: 'cut' , cutId: 'cut-17'})
    const readText = vi.fn(async () => 'a')
    vi.stubGlobal('navigator', { clipboard: { readText, writeText: vi.fn() } })

    const action = findAction('paste_after')
    await action.handler({
      block: repo.block('dest'),
      uiStateBlock: repo.block('dest'),
      scopeRootId: undefined,
    } as BlockShortcutDependencies, trigger)

    // Moved, not duplicated: the SAME id 'a' is gone from 'src' and now
    // sits alongside 'dest' under 'root' — no new block was minted by
    // re-parsing the pasted markdown.
    expect(await childIds('src')).toEqual([])
    expect(repo.block('a').peek()?.parentId).toBe('root')
    // Single up-front clipboard read — not re-read again for a fallback
    // (there's no fallback here since the move completed).
    expect(readText).toHaveBeenCalledTimes(1)
  })

  it('paste_before also completes the move', async () => {
    await seed()
    rememberPayload('a', { blockIds: ['a'], workspaceId: WS, intent: 'cut' , cutId: 'cut-18'})
    vi.stubGlobal('navigator', { clipboard: { readText: vi.fn(async () => 'a'), writeText: vi.fn() } })

    const action = findAction('paste_before')
    await action.handler({
      block: repo.block('dest'),
      uiStateBlock: repo.block('dest'),
      scopeRootId: undefined,
    } as BlockShortcutDependencies, trigger)

    expect(await childIds('src')).toEqual([])
    expect(repo.block('a').peek()?.parentId).toBe('root')
  })

  it('falls back to an ordinary text paste (not a move) when the clipboard no longer matches the remembered payload', async () => {
    await seed()
    rememberPayload('a', { blockIds: ['a'], workspaceId: WS, intent: 'cut' , cutId: 'cut-19'})
    const readText = vi.fn(async () => 'unrelated text copied since the cut')
    vi.stubGlobal('navigator', { clipboard: { readText, writeText: vi.fn() } })

    const before = await childIds('root')
    const action = findAction('paste_after')
    await action.handler({
      block: repo.block('dest'),
      uiStateBlock: repo.block('dest'),
      scopeRootId: undefined,
    } as BlockShortcutDependencies, trigger)

    // 'a' was NOT moved — still exactly where it was.
    expect(repo.block('a').peek()?.parentId).toBe('src')
    const added = (await childIds('root')).filter(id => !before.includes(id))
    expect(added.map(id => repo.block(id).peek()?.content)).toEqual(['unrelated text copied since the cut'])
    // Exactly one read overall: the up-front read that checked the move,
    // threaded into the fallback rather than re-read there.
    expect(readText).toHaveBeenCalledTimes(1)
  })

  it('lands the move at a SCOPE ROOT as first child, not literally after it as a sibling (matches the visible-placement fallback policy)', async () => {
    await repo.tx(async tx => {
      await tx.create({ id: 'workspaceRoot', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'workspaceRoot' })
      await tx.create({ id: 'scope', workspaceId: WS, parentId: 'workspaceRoot', orderKey: 'a0', content: 'scope' })
      await tx.create({ id: 'a', workspaceId: WS, parentId: 'workspaceRoot', orderKey: 'a1', content: 'a' })
    }, { scope: ChangeScope.BlockDefault })
    rememberPayload('a', { blockIds: ['a'], workspaceId: WS, intent: 'cut' , cutId: 'cut-20'})
    vi.stubGlobal('navigator', { clipboard: { readText: vi.fn(async () => 'a'), writeText: vi.fn() } })

    const action = findAction('paste_after')
    await action.handler({
      block: repo.block('scope'),
      uiStateBlock: repo.block('scope'),
      scopeRootId: 'scope',
    } as BlockShortcutDependencies, trigger)

    expect(repo.block('a').peek()?.parentId).toBe('scope')
  })
})
