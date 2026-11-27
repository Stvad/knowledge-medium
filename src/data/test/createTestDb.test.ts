// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb, type TestDb, waitForTemplateReadyOrLockRelease } from './createTestDb'
import { BLOCKS_TABLE_COLUMN_NAMES } from '@/data/blockSchema'
import {
  ALIAS_BACKFILL_MARKER_KEY,
  BLOCK_TYPES_BACKFILL_MARKER_KEY,
  CLIENT_SCHEMA_TRIGGER_NAMES,
} from '@/data/internals/clientSchema'
import { resolveLocalSchemaContributions } from '@/data/localSchema.js'
import { staticDataExtensions } from '@/extensions/staticDataExtensions.js'

const localSchemaTriggerNames = resolveLocalSchemaContributions(staticDataExtensions)
  .flatMap(contribution => [...(contribution.triggerNames ?? [])])

describe('createTestDb harness', () => {
  let h: TestDb
  beforeAll(async () => {
    h = await createTestDb()
  })
  afterAll(async () => {
    await h.cleanup()
  })

  it('opens a writable PowerSyncDatabase with the v2 blocks shape (storage + local columns)', async () => {
    // `blocks` = storage columns + LOCAL-only columns
    // (`reference_target_id`), appended last.
    const cols = (await h.db.getAll<{name: string}>(
      "SELECT name FROM pragma_table_info('blocks') ORDER BY cid",
    )).map(r => r.name)
    expect(cols).toEqual(BLOCKS_TABLE_COLUMN_NAMES)
  })

  it('seeds tx_context with one NULL row across all six tx fields', async () => {
    const row = await h.db.get<Record<string, unknown>>('SELECT * FROM tx_context')
    expect(row).toEqual({id: 1, tx_id: null, tx_seq: null, user_id: null, scope: null, source: null, group_id: null})
  })

  it('installs the documented set of blocks triggers', async () => {
    // CLIENT_SCHEMA_TRIGGER_NAMES spans triggers on `blocks`, `block_aliases`,
    // `blocks_synced` (the Layout B change-capture triggers), and `ps_crud`
    // (the checkpoint reset); see the analogous test in clientSchema.test.ts.
    const names = (await h.db.getAll<{name: string}>(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('blocks', 'block_aliases', 'blocks_synced', 'ps_crud') ORDER BY name",
    )).map(r => r.name)
    const expected = [
      ...CLIENT_SCHEMA_TRIGGER_NAMES,
      ...localSchemaTriggerNames,
    ]
    expect(names.sort()).toEqual(expected.sort())
    expect(names).toHaveLength(expected.length)
  })

  it('installs production blocks indexes', async () => {
    const names = (await h.db.getAll<{name: string}>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='blocks'",
    )).map(r => r.name)
    expect(names).toEqual(expect.arrayContaining([
      'idx_blocks_parent_order',
      'idx_blocks_workspace_active',
    ]))
  })

  it('installs the block_types side index', async () => {
    const columns = (await h.db.getAll<{name: string}>(
      "SELECT name FROM pragma_table_info('block_types') ORDER BY cid",
    )).map(r => r.name)
    expect(columns).toEqual(['block_id', 'workspace_id', 'type'])

    const indexes = (await h.db.getAll<{name: string}>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='block_types'",
    )).map(r => r.name)
    expect(indexes).toEqual(expect.arrayContaining([
      'sqlite_autoindex_block_types_1',
      'idx_block_types_type_workspace',
    ]))
  })

  it('records side-index backfill completion markers', async () => {
    const keys = (await h.db.getAll<{key: string}>(
      'SELECT key FROM client_schema_state ORDER BY key',
    )).map(r => r.key)
    expect(keys).toEqual(expect.arrayContaining([
      ALIAS_BACKFILL_MARKER_KEY,
      BLOCK_TYPES_BACKFILL_MARKER_KEY,
    ]))
  })

  it('writeTransaction commits on success, rolls back on throw', async () => {
    await h.db.writeTransaction(async tx => {
      await tx.execute(
        `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json, references_json, created_at, updated_at, created_by, updated_by, deleted)
         VALUES ('t-commit', 'ws', NULL, 'a0', '', '{}', '[]', 0, 0, 'u', 'u', 0)`,
      )
    })
    expect(await h.db.get<{id: string}>('SELECT id FROM blocks WHERE id = ?', ['t-commit'])).toEqual({id: 't-commit'})

    await expect(
      h.db.writeTransaction(async tx => {
        await tx.execute(
          `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json, references_json, created_at, updated_at, created_by, updated_by, deleted)
           VALUES ('t-rollback', 'ws', NULL, 'a1', '', '{}', '[]', 0, 0, 'u', 'u', 0)`,
        )
        throw new Error('intentional')
      }),
    ).rejects.toThrow('intentional')

    expect(await h.db.getOptional('SELECT id FROM blocks WHERE id = ?', ['t-rollback'])).toBeNull()
  })

  it('reads the last committed value while a write is pending, then sees its commit', async () => {
    const id = 't-read-isolation'
    await h.db.execute(
      `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json, references_json, created_at, updated_at, created_by, updated_by, deleted)
       VALUES (?, 'ws', NULL, 'a0', 'committed', '{}', '[]', 0, 0, 'u', 'u', 0)`,
      [id],
    )

    let markUpdated!: () => void
    const updated = new Promise<void>(resolve => { markUpdated = resolve })
    let allowCommit!: () => void
    const commitAllowed = new Promise<void>(resolve => { allowCommit = resolve })
    const writing = h.db.writeTransaction(async tx => {
      await tx.execute('UPDATE blocks SET content = ? WHERE id = ?', ['pending', id])
      markUpdated()
      await commitAllowed
    })

    try {
      await Promise.race([updated, writing])
      expect(await h.db.get<{content: string}>('SELECT content FROM blocks WHERE id = ?', [id]))
        .toEqual({content: 'committed'})
    } finally {
      allowCommit()
      await writing
    }

    expect(await h.db.get<{content: string}>('SELECT content FROM blocks WHERE id = ?', [id]))
      .toEqual({content: 'pending'})
  })
})

describe('the template build lock', () => {
  let dir: string
  let templateDir: string
  let lockDir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'template-lock-'))
  })
  afterAll(() => rmSync(dir, {recursive: true, force: true}))

  const lock = (owner?: string) => {
    templateDir = mkdtempSync(join(dir, 'template-'))
    rmSync(templateDir, {recursive: true})
    lockDir = `${templateDir}.lock`
    mkdirSync(lockDir)
    if (owner !== undefined) writeFileSync(join(lockDir, 'pid'), owner)
  }
  const exitedPid = () => spawnSync(process.execPath, ['-e', '']).pid

  it('steals a lock whose builder has exited, instead of waiting it out', async () => {
    lock(String(exitedPid()))
    await expect(waitForTemplateReadyOrLockRelease(templateDir, lockDir)).resolves.toBe(false)
    expect(existsSync(lockDir)).toBe(false)
  })

  it('steals an ownerless lock once it is older than any real build', async () => {
    lock()
    const longAgo = new Date(Date.now() - 10 * 60_000)
    utimesSync(lockDir, longAgo, longAgo)
    await expect(waitForTemplateReadyOrLockRelease(templateDir, lockDir)).resolves.toBe(false)
    expect(existsSync(lockDir)).toBe(false)
  })

  it.each([
    ['a live builder', () => String(process.pid)],
    ['a builder that has not written its pid yet', () => undefined],
  ])('waits on %s until its template is ready', async (_case, owner) => {
    lock(owner())
    const waiting = waitForTemplateReadyOrLockRelease(templateDir, lockDir)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(existsSync(lockDir)).toBe(true)
    mkdirSync(templateDir)
    writeFileSync(join(templateDir, '.ready'), '')
    await expect(waiting).resolves.toBe(true)
  })
})
