// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { ensurePowerSyncReady } from '@/data/repoProvider'
import {
  discardDbOpenTimeline,
  getStartupTimeline,
  markStartup,
  recordStartupDbFiles,
  resetStartupTimeline,
} from '@/utils/startupTimeline'

// Marks are first-write-wins and page-global, while one page can attempt more
// than one open: a failed boot can be followed by a sign-out from the error
// screen and another user's boot, with no reload in between.
describe('a failed local-database open', () => {
  beforeEach(() => { resetStartupTimeline() })

  it('leaves none of its marks for the next attempt to inherit', async () => {
    // Node has no OPFS, so the open rejects at its first step — after
    // `dbRequested` was stamped.
    await expect(ensurePowerSyncReady('user-a', false)).rejects.toThrow()

    expect(getStartupTimeline().marks).toEqual({})
  })

  it('lets the next attempt record its own file sizes', () => {
    markStartup('repoReady')
    recordStartupDbFiles({main: 1, '-wa0': 2})

    discardDbOpenTimeline()
    recordStartupDbFiles({main: 3, '-wa0': null})

    const timeline = getStartupTimeline()
    expect(timeline.dbFileBytes).toEqual({main: 3, '-wa0': null})
    // Only the open's own marks go; the rest of the boot's timeline stays.
    expect(timeline.marks.repoReady).toBeDefined()
  })
})
