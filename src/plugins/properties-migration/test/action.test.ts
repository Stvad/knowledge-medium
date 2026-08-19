// @vitest-environment happy-dom
/**
 * The palette entry for the one-time properties migration. What matters here
 * is the gesture's guard and what the user is told afterwards — the pass
 * itself is covered in `propertyCellBackfill.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const openDialog = vi.fn()
const progressHandle = {update: vi.fn(), done: vi.fn(), fail: vi.fn()}

vi.mock('@/utils/dialogs.js', () => ({openDialog: (...args: unknown[]) => openDialog(...args)}))
vi.mock('@/utils/toast.js', () => ({showProgress: () => progressHandle}))
vi.mock('../ConfirmMigrationDialog.tsx', () => ({ConfirmMigrationDialog: () => null}))

import type { OperatorBackfillResult, Repo } from '@/data/repo'
import { migratePropertiesToBlocksAction } from '../action.ts'

const makeRepo = (result: OperatorBackfillResult) => {
  const runWorkspaceBackfillNow = vi.fn(async () => result)
  const repo = {
    activeWorkspaceId: 'ws-1',
    db: {getAll: async () => [{n: 7}]},
    runWorkspaceBackfillNow,
  } as unknown as Repo
  return {repo, runWorkspaceBackfillNow}
}

const invoke = (repo: Repo) =>
  migratePropertiesToBlocksAction({repo}).handler({} as never, {} as never)

afterEach(() => {
  openDialog.mockReset()
  progressHandle.update.mockReset()
  progressHandle.done.mockReset()
  progressHandle.fail.mockReset()
})

describe('migrate_properties_to_blocks action', () => {
  it('writes nothing when the user cancels the confirmation', async () => {
    // The confirmation is the whole guard on a pass that uploads hundreds of
    // thousands of rows and drops the workspace's undo history.
    openDialog.mockResolvedValue(null)
    const {repo, runWorkspaceBackfillNow} = makeRepo(
      {outcome: 'ran', undoHistoryCleared: true},
    )

    await invoke(repo)

    expect(runWorkspaceBackfillNow).not.toHaveBeenCalled()
  })

  it('tells the user their undo history went with it', async () => {
    openDialog.mockResolvedValue(true)
    const {repo} = makeRepo({outcome: 'ran', undoHistoryCleared: true})

    await invoke(repo)

    expect(progressHandle.done).toHaveBeenCalledWith(expect.stringMatching(/undo history/i))
  })

  it('reports a deferred pass as unfinished rather than as done', async () => {
    // `deferred` means a precondition that clears on its own. Reporting it
    // through `done` would read as "migration complete" to the one person who
    // needs to come back and re-run it.
    openDialog.mockResolvedValue(true)
    const {repo} = makeRepo({
      outcome: 'deferred',
      undoHistoryCleared: false,
      reason: 'this device is not caught up with the server',
    })

    await invoke(repo)

    expect(progressHandle.done).not.toHaveBeenCalled()
    expect(progressHandle.fail).toHaveBeenCalledWith(expect.stringMatching(/not caught up/))
  })
})
