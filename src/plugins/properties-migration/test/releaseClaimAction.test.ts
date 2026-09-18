// @vitest-environment happy-dom
/**
 * The command that clears a claim nobody will release.
 *
 * It is the only way a user reaches `releaseStrandedGraphBackfillClaim`, and
 * the only way out of the migration lock from inside the app — the delete that
 * used to be the documented recovery is refused by the lock along with every
 * other write. So what it refuses to do matters as much as what it does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '@/data/repo'
import {
  graphBackfillClaimBlockId,
  releaseStrandedGraphBackfillClaim,
} from '@/data/internals/graphBackfillClaim'
import { PROPERTY_CELL_BACKFILL_ID } from '@/data/internals/propertyCellBackfill'

const showInfo = vi.fn()
vi.mock('@/utils/toast.js', () => ({
  showInfo: (...args: unknown[]) => showInfo(...args),
}))
vi.mock('@/data/internals/graphBackfillClaim', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/data/internals/graphBackfillClaim')>()),
  releaseStrandedGraphBackfillClaim: vi.fn(),
}))

const { releaseMigrationClaimAction } = await import('../releaseClaimAction.ts')

const WS = 'ws-release'
const CLAIM_ID = graphBackfillClaimBlockId(WS, PROPERTY_CELL_BACKFILL_ID)

/** A Repo stub whose only job is to answer the claim read. */
const repoHolding = (properties: Record<string, unknown> | null): Repo => ({
  activeWorkspaceId: WS,
  db: {
    getOptional: async (_sql: string, params: unknown[]) =>
      params[0] === CLAIM_ID && properties !== null
        ? {properties_json: JSON.stringify(properties)}
        : null,
  },
} as unknown as Repo)

const inFlight = {'migration:claimant': 'a-device-that-is-gone', 'migration:claimed-at': 1}
const completed = {...inFlight, 'migration:completed-at': 2}

const invoke = (repo: Repo): Promise<void> =>
  releaseMigrationClaimAction({repo}).handler({} as never, {} as never) as Promise<void>

/** The confirmation's button, which is the only thing that releases anything. */
const confirmButton = (): (() => void) | undefined =>
  (showInfo.mock.calls.at(-1)?.[1] as {action?: {onClick: () => void}} | undefined)?.action?.onClick

beforeEach(() => { vi.mocked(releaseStrandedGraphBackfillClaim).mockResolvedValue('released') })
afterEach(() => { showInfo.mockReset(); vi.mocked(releaseStrandedGraphBackfillClaim).mockReset() })

describe('when nothing is holding the workspace', () => {
  it('releases nothing and offers no button, with no claim at all', async () => {
    await invoke(repoHolding(null))

    expect(releaseStrandedGraphBackfillClaim).not.toHaveBeenCalled()
    expect(confirmButton()).toBeUndefined()
    expect(showInfo.mock.calls[0]?.[0]).toContain('nothing to release')
  })

  it('leaves a COMPLETED claim alone — it is the record of the run, not a lock', async () => {
    // Deleting it would leave the graph reading as never-migrated, and it locks
    // nothing, so the command must not even offer.
    await invoke(repoHolding(completed))

    expect(releaseStrandedGraphBackfillClaim).not.toHaveBeenCalled()
    expect(confirmButton()).toBeUndefined()
  })
})

describe('when a claim is holding the workspace', () => {
  it('does not release until the user confirms', async () => {
    await invoke(repoHolding(inFlight))

    expect(releaseStrandedGraphBackfillClaim).not.toHaveBeenCalled()
    expect(showInfo.mock.calls[0]?.[0]).toContain('not accepting edits')
    expect(confirmButton()).toBeDefined()
  })

  it('releases against the claim it SHOWED, not merely against whatever is there', async () => {
    // The gap to the click is a human pause; consent was for this claim.
    await invoke(repoHolding(inFlight))

    confirmButton()!()
    await vi.waitFor(() => { expect(releaseStrandedGraphBackfillClaim).toHaveBeenCalled() })

    expect(releaseStrandedGraphBackfillClaim).toHaveBeenCalledWith(
      expect.anything(), WS, PROPERTY_CELL_BACKFILL_ID,
      {claimantId: 'a-device-that-is-gone', claimedAt: 1},
    )
  })

  it('says the claim changed rather than reporting a release that did not happen', async () => {
    vi.mocked(releaseStrandedGraphBackfillClaim).mockResolvedValue('changed')
    await invoke(repoHolding(inFlight))

    confirmButton()!()

    await vi.waitFor(() => {
      expect(showInfo.mock.calls.at(-1)?.[0]).toContain('claim changed while this was open')
    })
  })

  it('reports a failure instead of leaving the user believing it worked', async () => {
    vi.mocked(releaseStrandedGraphBackfillClaim).mockRejectedValue(new Error('db is gone'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await invoke(repoHolding(inFlight))

    confirmButton()!()

    await vi.waitFor(() => {
      expect(showInfo.mock.calls.at(-1)?.[0]).toContain('Could not release')
    })
  })
})
