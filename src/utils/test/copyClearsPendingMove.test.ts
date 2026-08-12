// @vitest-environment happy-dom
/**
 * Item 2 of the block-move-ui review: every clipboard WRITE must clear any
 * pending cut→move, EXCEPT the cut's own (which re-arms it right after —
 * covered by `cutBlockIdsToClipboard.test.ts`). Without this, cutting block
 * A then copying block B leaves the register still pointing at A — the
 * next paste teleports A instead of pasting B's copy.
 *
 * This file covers the ORDINARY copy paths (`copyBlockToClipboard` /
 * `copyBlockIdsToClipboard`), which go through the SAME `writeToClipboard`
 * in `@/utils/copy.js` as cut, but never call `setPendingMove` afterward —
 * so for these paths the clear must actually stick.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { clearPendingMove, getPendingMove, setPendingMove } from '@/utils/pendingMove'
import { copyBlockIdsToClipboard, copyBlockToClipboard } from '@/utils/copy'

const WS = 'ws-1'

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({ db: sharedDb.db, user: { id: 'user-1' } }).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({ id: 'a', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'a' })
    await tx.create({ id: 'b', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'b' })
  }, { scope: ChangeScope.BlockDefault })
})

afterEach(() => {
  clearPendingMove()
  vi.unstubAllGlobals()
})

describe('an ordinary copy clears an unrelated pending cut→move', () => {
  it('copyBlockToClipboard clears it', async () => {
    setPendingMove({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })
    vi.stubGlobal('ClipboardItem', class {})
    vi.stubGlobal('navigator', { clipboard: { write: vi.fn(async () => {}) } })

    await copyBlockToClipboard(repo.block('b'))

    expect(getPendingMove()).toBeNull()
  })

  it('copyBlockIdsToClipboard clears it', async () => {
    setPendingMove({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })
    vi.stubGlobal('ClipboardItem', class {})
    vi.stubGlobal('navigator', { clipboard: { write: vi.fn(async () => {}) } })

    await copyBlockIdsToClipboard(['b'], repo)

    expect(getPendingMove()).toBeNull()
  })

  it('clears even when the OS write itself is refused — the user\'s intent to copy something else is what invalidates the register, not whether the write landed', async () => {
    setPendingMove({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })
    vi.stubGlobal('ClipboardItem', class {})
    vi.stubGlobal('navigator', {
      clipboard: { write: vi.fn(async () => { throw new DOMException('refused', 'NotAllowedError') }) },
    })

    await expect(copyBlockToClipboard(repo.block('b'))).rejects.toThrow()

    expect(getPendingMove()).toBeNull()
  })
})
