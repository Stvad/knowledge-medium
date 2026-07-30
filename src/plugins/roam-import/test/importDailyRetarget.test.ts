// @vitest-environment node
/**
 * Isolates the SECOND half of the issue-#378 daily-page fix: reconciling every
 * daily reconciliation against the id `getOrCreateDailyNote` ACTUALLY returned,
 * rather than trusting the alias-first prediction `reconcilePages` made.
 *
 * The prediction and the materialization are two separate reads, so they can
 * disagree — a sync-applied write claims or frees the date's alias in between,
 * or the adoption guard refuses a claimant the prediction accepted. When they
 * do, `finalId` names a row step 4 never created, and the damage is silent:
 * `mergePageAliases` / `applyPromotedAttributes` no-op on a missing target and
 * the descendant reparent map has no entry to route children.
 *
 * Forcing a real race deterministically isn't practical, so this file stubs
 * `predictDailyNoteId` to return the raw deterministic id — which is BOTH the
 * exact pre-fix behavior and a maximally-stale prediction — while leaving
 * `getOrCreateDailyNote` real. Everything landing correctly anyway is what
 * proves the ground-truth reconciliation carries the fix by itself, not just
 * as a rubber-stamp on an already-correct prediction.
 *
 * Separate file because `vi.mock` is hoisted and applies to the whole module
 * graph for the file — import.test.ts must keep the real prediction.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { aliasesProp } from '@/data/properties'
import { getOrCreatePropertiesPage } from '@/data/propertiesPage'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import { importRoam } from '../import'
import { roamBlockId } from '../ids'
import type { RoamExport } from '../types'

vi.mock('@/plugins/daily-notes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/plugins/daily-notes')>()
  return {
    ...actual,
    // The pre-#378-fix prediction: always the raw deterministic id, blind to
    // any live claimant. `getOrCreateDailyNote` stays untouched, so it still
    // adopts the claimant and the two disagree by construction.
    predictDailyNoteId: (_repo: Repo, workspaceId: string, iso: string) =>
      Promise.resolve(actual.dailyNoteBlockId(workspaceId, iso)),
  }
})

const {dailyNoteBlockId, dailyNotesDataExtension, journalBlockId} =
  await import('@/plugins/daily-notes')

const WORKSPACE = 'ws-daily-retarget'
const USER_ID = 'user-1'
const APR27_ISO = '2026-04-27'
const CLAIMANT_ID = 'claimant-2026-04-27-retarget'

const dailyPageExport: RoamExport = [
  {
    title: 'April 27th, 2026',
    uid: '04-27-2026',
    children: [
      {string: 'mood:: great', uid: 'retargetAttr'},
      {string: 'morning notes', uid: 'retargetChild'},
    ],
  },
]

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({
    db: sharedDb.db,
    user: {id: USER_ID},
    startSyncObserver: true,
    extensions: [kernelValuePresetsExtension, dailyNotesDataExtension],
  }).repo
  repo.setActiveWorkspaceId(WORKSPACE)
  await getOrCreatePropertiesPage(repo, WORKSPACE)
})
afterEach(() => { repo.stopSyncObserver() })

const readBlock = (id: string) =>
  sharedDb.db.getOptional<{parent_id: string | null; properties_json: string}>(
    'SELECT parent_id, properties_json FROM blocks WHERE id = ?', [id],
  )

describe('daily-page reconciliation against ground truth (issue #378)', () => {
  it('retargets aliases, promoted attrs and descendants when the prediction is stale', async () => {
    await repo.tx(async tx => {
      await tx.create({
        id: CLAIMANT_ID, workspaceId: WORKSPACE, parentId: null, orderKey: 'a0', content: APR27_ISO,
      })
      await tx.setProperty(CLAIMANT_ID, aliasesProp, [APR27_ISO])
    }, {scope: ChangeScope.BlockDefault})

    const summary = await importRoam(dailyPageExport, repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    // Precondition: the stub really did mispredict — `getOrCreateDailyNote`
    // adopted the claimant and minted nothing at the deterministic id.
    expect(await readBlock(dailyNoteBlockId(WORKSPACE, APR27_ISO))).toBeNull()

    // ...and the reconciliation caught it, saying so rather than silently
    // dropping the page's data.
    expect(summary.diagnostics.some(d =>
      d.includes(`resolved to block ${CLAIMANT_ID}`) && d.includes(APR27_ISO),
    )).toBe(true)

    const claimant = await readBlock(CLAIMANT_ID)
    expect(claimant!.parent_id).toBe(journalBlockId(WORKSPACE))
    const props = JSON.parse(claimant!.properties_json) as Record<string, unknown>
    expect(props['roam:mood']).toBe('great')
    expect(props[aliasesProp.name]).toContain('April 27th, 2026')

    expect((await readBlock(roamBlockId(WORKSPACE, 'retargetChild')))!.parent_id).toBe(CLAIMANT_ID)
  })

  it('stays silent and unchanged when the prediction was already right', async () => {
    // No claimant: the stubbed prediction and `getOrCreateDailyNote` agree on
    // the deterministic id, so nothing is retargeted and no diagnostic fires.
    const summary = await importRoam(dailyPageExport, repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    const noteId = dailyNoteBlockId(WORKSPACE, APR27_ISO)
    expect(summary.diagnostics.some(d => d.includes('resolved to block'))).toBe(false)
    expect((await readBlock(roamBlockId(WORKSPACE, 'retargetChild')))!.parent_id).toBe(noteId)
    const props = JSON.parse((await readBlock(noteId))!.properties_json) as Record<string, unknown>
    expect(props['roam:mood']).toBe('great')
  })
})
