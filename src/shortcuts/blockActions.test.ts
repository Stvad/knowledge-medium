// @vitest-environment happy-dom
/**
 * The block-level "copy *" actions' clipboard write (item 2 of the
 * block-move-ui review): `copyBlockRef` / `copyBlockEmbed` /
 * `copyBlockContent` / `copyBlockLink` all funnel through a local
 * `writeToClipboard` distinct from `@/utils/copy.js`'s — it must ALSO
 * clear a pending cut→move, or cutting a block then using one of these on
 * another block leaves the register pointing at the cut block; the next
 * paste silently MOVES it instead of pasting the ref/embed/content/link
 * that was actually just copied.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { ChangeScope } from '@/data/api'
import { clearPendingMove, getPendingMove, setPendingMove } from '@/utils/pendingMove'
import { createSharedBlockActions } from './blockActions'

const WS = 'ws-1'

let sharedDb: TestDb
let repo: Repo
beforeEach(async () => {
  sharedDb = await createTestDb()
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({ db: sharedDb.db, user: { id: 'user-1' } }).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({ id: 'a', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'a' })
    await tx.create({ id: 'b', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'b' })
  }, { scope: ChangeScope.BlockDefault })
})

afterEach(async () => {
  clearPendingMove()
  vi.unstubAllGlobals()
  await sharedDb.cleanup()
})

describe('the block-level copy actions clear an unrelated pending cut→move', () => {
  const armPendingMove = (): void => {
    setPendingMove({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })
  }

  it('copyBlockRef clears it', () => {
    armPendingMove()
    const { copyBlockRef } = createSharedBlockActions({ repo })
    copyBlockRef.handler({ block: repo.block('b'), uiStateBlock: repo.block('b'), scopeRootId: undefined } as never, {} as never)
    expect(getPendingMove()).toBeNull()
  })

  it('copyBlockEmbed clears it', () => {
    armPendingMove()
    const { copyBlockEmbed } = createSharedBlockActions({ repo })
    copyBlockEmbed.handler({ block: repo.block('b'), uiStateBlock: repo.block('b'), scopeRootId: undefined } as never, {} as never)
    expect(getPendingMove()).toBeNull()
  })

  it('copyBlockLink clears it', () => {
    armPendingMove()
    const { copyBlockLink } = createSharedBlockActions({ repo })
    copyBlockLink.handler({ block: repo.block('b'), uiStateBlock: repo.block('b'), scopeRootId: undefined } as never, {} as never)
    expect(getPendingMove()).toBeNull()
  })

  it('copyBlockContent clears it', async () => {
    armPendingMove()
    const { copyBlockContent } = createSharedBlockActions({ repo })
    await copyBlockContent.handler({ block: repo.block('b'), uiStateBlock: repo.block('b'), scopeRootId: undefined } as never, {} as never)
    expect(getPendingMove()).toBeNull()
  })
  // The clear is unconditional — placed BEFORE the `typeof navigator ===
  // 'undefined' || !navigator.clipboard` early-return, not after — so it
  // fires even in a genuinely clipboard-less context (no `navigator.clipboard`
  // at all), which is exactly the branch that early-return exists for.
  it('clears even when there is no clipboard API to write to at all', () => {
    armPendingMove()
    vi.stubGlobal('navigator', {})
    const { copyBlockRef } = createSharedBlockActions({ repo })
    copyBlockRef.handler({ block: repo.block('b'), uiStateBlock: repo.block('b'), scopeRootId: undefined } as never, {} as never)
    expect(getPendingMove()).toBeNull()
  })
})
