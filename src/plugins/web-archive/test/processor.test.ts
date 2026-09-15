// @vitest-environment node
/**
 * The notice processor, end to end through a real Repo: what actually lands
 * in the graph when a user types a link.
 *
 * The opt-in cases are the point of the file. "Off by default" is only true
 * if it is true through the real write path, not just in the schema default.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, type BlockData } from '@/data/api'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { webArchiveDataExtension } from '../dataExtension.ts'
import {
  archiveDenylistProp,
  archiveEnabledProp,
  loadPrefsBlock,
} from '../prefs.ts'
import { ARCHIVE_SNAPSHOT_TYPE } from '../schema.ts'
import { toArchiveRecord } from '../snapshots.ts'

const WS = 'ws-1'
const SOURCE = 'source-block'

let sharedDb: TestDb
let repo: Repo

const records = async (): Promise<BlockData[]> =>
  repo.queryBlocks({workspaceId: WS, types: [ARCHIVE_SNAPSHOT_TYPE], order: 'created-asc'})

const allBlockIds = async (): Promise<string[]> => {
  const rows = await sharedDb.db.getAll<{id: string}>(
    'SELECT id FROM blocks WHERE deleted = 0 ORDER BY id',
  )
  return rows.map(row => row.id)
}

const childRecordsOf = async (parentId: string) =>
  (await records()).filter(row => row.parentId === parentId).map(toArchiveRecord)

const enable = async (extra: (block: Awaited<ReturnType<typeof loadPrefsBlock>>) => Promise<void> = async () => {}) => {
  const prefs = await loadPrefsBlock(repo, WS)
  await prefs.set(archiveEnabledProp, true)
  await extra(prefs)
  await repo.awaitProcessors()
}

const writeSource = async (content: string, id = SOURCE) => {
  await repo.tx(async tx => {
    const existing = await tx.get(id)
    if (existing && !existing.deleted) {
      await tx.update(id, {content})
      return
    }
    await tx.create({id, workspaceId: WS, parentId: null, orderKey: 'a0', content})
  }, {scope: ChangeScope.BlockDefault})
  await repo.awaitProcessors()
}

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    extensions: [webArchiveDataExtension],
  }).repo
  repo.setActiveWorkspaceId(WS)
})

describe('opt-in gate', () => {
  it('records nothing at all with the default (untouched) preferences', async () => {
    await writeSource('read [this](https://example.com/a) today')
    expect(await records()).toEqual([])
  })

  // "Off" has to mean inert, not "does the work and discards it". Reading the
  // preference through the get-or-create helper would materialize the user
  // page and the whole Preferences subtree from inside a post-commit
  // processor, for a feature nobody switched on.
  it('creates no blocks whatsoever while switched off', async () => {
    const before = await allBlockIds()
    await writeSource('read [this](https://example.com/a) today')
    expect(await allBlockIds()).toEqual([...before, SOURCE])
  })

  it('still records nothing when the plugin prefs block exists but is off', async () => {
    // Materialising the prefs block is what a user visiting Preferences does.
    // Merely looking at the settings must not arm the feature.
    await loadPrefsBlock(repo, WS)
    await repo.awaitProcessors()
    await writeSource('read [this](https://example.com/a) today')
    expect(await records()).toEqual([])
  })

  it('starts recording once the user opts in', async () => {
    await enable()
    await writeSource('read [this](https://example.com/a) today')

    const found = await childRecordsOf(SOURCE)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      url: 'https://example.com/a',
      status: 'pending',
      attempts: 0,
      archiveUrl: '',
    })
    // Nothing has been sent — `pending` is a note to self, not a submission.
    expect(found[0]!.submittedAt).toBeUndefined()
  })

  it('does not retroactively archive links written before the opt-in', async () => {
    await writeSource('older [link](https://example.com/old)')
    await enable()
    expect(await records()).toEqual([])
  })
})

describe('what gets recorded', () => {
  beforeEach(async () => { await enable() })

  it('parents the record under the block that carried the link', async () => {
    await writeSource('see [a](https://example.com/a)')
    const [record] = await childRecordsOf(SOURCE)
    expect(record?.parentId).toBe(SOURCE)
  })

  it('reads as a sensible outline line without this plugin', async () => {
    await writeSource('see [a](https://example.com/a)')
    const [row] = (await records())
    expect(row?.content).toBe('Queued for archiving: https://example.com/a')
  })

  it('records one block per distinct public URL', async () => {
    await writeSource('[a](https://example.com/a) [b](https://example.org/b)')
    const found = await childRecordsOf(SOURCE)
    expect(found.map(r => r.url).sort()).toEqual([
      'https://example.com/a',
      'https://example.org/b',
    ])
  })

  it('skips private, local, and credential-bearing URLs', async () => {
    await writeSource([
      '[local](http://localhost:5173/x)',
      '[lan](http://192.168.1.4/admin)',
      '[creds](https://u:p@example.com/x)',
      '[token](https://example.com/x?access_token=zz)',
      '[ok](https://example.com/fine)',
    ].join(' '))

    expect((await childRecordsOf(SOURCE)).map(r => r.url))
      .toEqual(['https://example.com/fine'])
  })

  it('honours the user denylist, subdomains included', async () => {
    const prefs = await loadPrefsBlock(repo, WS)
    await prefs.set(archiveDenylistProp, ['example.com'])
    await repo.awaitProcessors()

    await writeSource('[a](https://mail.example.com/x) [b](https://elsewhere.org/y)')
    expect((await childRecordsOf(SOURCE)).map(r => r.url)).toEqual(['https://elsewhere.org/y'])
  })
})

describe('idempotency and loop safety', () => {
  beforeEach(async () => { await enable() })

  it('does not re-queue a URL when the block is edited again', async () => {
    await writeSource('see [a](https://example.com/a)')
    await writeSource('see [a](https://example.com/a) — good read')
    expect(await childRecordsOf(SOURCE)).toHaveLength(1)
  })

  it('queues only the newly added URL on a later edit', async () => {
    await writeSource('[a](https://example.com/a)')
    await writeSource('[a](https://example.com/a) [b](https://example.org/b)')
    expect((await childRecordsOf(SOURCE)).map(r => r.url).sort())
      .toEqual(['https://example.com/a', 'https://example.org/b'])
  })

  it('keeps records for the same URL in different blocks separate', async () => {
    await writeSource('[a](https://example.com/a)', 'block-1')
    await writeSource('[a](https://example.com/a)', 'block-2')
    expect(await childRecordsOf('block-1')).toHaveLength(1)
    expect(await childRecordsOf('block-2')).toHaveLength(1)
  })

  // The record block's own content holds a URL, and the processor watches
  // `content`. Without the type guard this recurses; without the
  // service-host rule an archive link would be submitted back to the
  // archive. Both are asserted, because a passing total count could hide
  // either one being the only thing working.
  it('does not archive its own records', async () => {
    await writeSource('see [a](https://example.com/a)')
    const [record] = await records()
    expect(await childRecordsOf(record!.id)).toEqual([])
  })

  it('does not archive a link that already points at the archive', async () => {
    await writeSource('see [old](https://web.archive.org/web/2020/https://example.com/a)')
    expect(await childRecordsOf(SOURCE)).toEqual([])
  })
})
