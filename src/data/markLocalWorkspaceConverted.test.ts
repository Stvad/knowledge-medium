// @vitest-environment happy-dom
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { markLocalWorkspaceConverted } from '@/data/workspaces'
import { readWorkspaceEncryptionMode } from '@/data/workspaceSchema'
import { InMemoryWorkspaceKeyStore } from '@/sync/keys/keyStore'
import { setModePin } from '@/sync/keys/modePin'
import { createSyncResolver } from '@/sync/keys/resolver'

const USER = 'user-1'
const WS = 'ws-converted'

let testDb: TestDb
beforeAll(async () => { testDb = await createTestDb() })
afterAll(async () => { await testDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(testDb.db)
  localStorage.clear()
  await testDb.db.execute(
    `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time, encryption_mode)
     VALUES (?, 'converted', ?, 1, 1, 'none')`,
    [WS, USER],
  )
  setModePin(USER, WS, 'plaintext')
})

describe('markLocalWorkspaceConverted', () => {
  it('makes this plaintext-pinned device hold its uploads instead of sending plaintext', async () => {
    const resolver = createSyncResolver(() => USER, new InMemoryWorkspaceKeyStore(), id => readWorkspaceEncryptionMode(testDb.db, id))
    expect(await resolver.getUploadMode(WS)).toBe('none')

    await markLocalWorkspaceConverted(testDb.db, WS, 'enc:v1:canary')

    expect(await resolver.getUploadMode(WS)).toBe('hold')
    expect(await testDb.db.get('SELECT encryption_mode, wk_canary FROM workspaces WHERE id = ?', [WS]))
      .toEqual({encryption_mode: 'e2ee', wk_canary: 'enc:v1:canary'})
  })
})
