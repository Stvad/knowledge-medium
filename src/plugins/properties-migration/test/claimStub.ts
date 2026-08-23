/**
 * A stand-in for `Repo.withOperatorBackfillClaim` in the action's tests.
 *
 * Modelled on the real thing rather than on what a test needs to see: take the
 * claim, run the body, hand it back on every exit. Shared by the two action
 * test files so a fixture that lets the body run without a claim — the exact
 * bug these tests exist to pin — cannot exist in one of them.
 */
import type {
  OperatorBackfillClaimOutcome, OperatorBackfillPass, OperatorBackfillResult,
} from '@/data/repo'

export interface ClaimStubLog {
  /** In call order, so a test can assert the claim came BEFORE a write. */
  readonly events: string[]
}

export const claimStub = (
  runBackfill: () => Promise<OperatorBackfillResult>,
  {
    log,
    refuse,
  }: {
    log?: ClaimStubLog
    /** What a device that may not take the claim is told. */
    refuse?: () => OperatorBackfillResult | null
  } = {},
) => async (
  _workspaceId: string,
  _backfillId: string,
  body: (pass: OperatorBackfillPass) => Promise<void>,
): Promise<OperatorBackfillClaimOutcome> => {
  const refused = refuse?.() ?? null
  if (refused !== null) {
    log?.events.push('claim-refused')
    return {claimed: false, result: refused}
  }
  log?.events.push('claim')
  try {
    await body({
      run: async () => {
        log?.events.push('run')
        return runBackfill()
      },
    })
    return {claimed: true}
  } finally {
    log?.events.push('release')
  }
}
