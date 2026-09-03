/** One owner for what this page session can honestly say — is there a
 *  durable identity to file history under, may we write, are the counters
 *  attributable. Consumers ASK rather than re-derive, since recorder and
 *  reader are independently togglable. Scope follows `repo.metrics()`: one
 *  SPAN, monotonic since the last `resetMetrics()` and not segmented by
 *  workspace — a reset invalidates every claim made about it. */
import { appEffectsFacet, type AppEffect } from '@/extensions/core.js'
import type { Repo } from '@/data/repo'
import { awaitLocalMemberRole } from '@/data/workspaces.js'
import { isRemoteSyncActive } from '@/data/repoProvider.js'
import { isClientIdPersistent } from '@/utils/clientId.js'

/** Why this session may not persist metrics, or null when it may. */
export type RecordingBlocker = 'no-persistent-client' | 'read-only-workspace'

export interface MetricsSessionContext {
  canRecord: boolean
  /** Populated exactly when `canRecord` is false. */
  blockedBy: RecordingBlocker | null
  /** Attributable to this one workspace? False once seen in more than one. */
  attributable: boolean
  /** This page session's record block in `workspaceId`, if any. */
  recordId: string | null
}

/** The identity of the counter span a reading came from — every entry point
 *  takes this much of a Repo, since everything here is a claim ABOUT a span.
 *  `metricsSpan()`, not `metrics()`: identifying a span must not cost a full
 *  snapshot, since these checks run from render-path getters. */
export interface MetricsSpanSource {
  metricsSpan: () => { epoch: number; epochWorkspaceId: string | null }
}

/** Minimal read surface (no Repo import), so this module stays cheap to call
 *  from a test. */
export interface SessionRepoFacts extends MetricsSpanSource {
  isReadOnly: boolean
}

/** Facts are held PER REPO, not a global slot with a rebind: a local sign-out
 *  swaps the Repo without a reload, and a global slot would let a stale
 *  in-flight callback clobber the new Repo's facts. Keyed by Repo, it only
 *  ever touches its own. */
interface SessionFacts {
  seenWorkspace: string | null
  unattributable: boolean
  /** The `repo.metrics().epoch` these facts describe — a reset zeroes the
   *  counters, so everything here describes a span that no longer exists. */
  epoch: number
  pageRecord: { blockId: string; workspaceId: string; startedAt: number } | null
}

const facts = new WeakMap<object, SessionFacts>()

const factsFor = (repo: object): SessionFacts => {
  let f = facts.get(repo)
  if (!f) {
    f = { seenWorkspace: null, unattributable: false, epoch: 0, pageRecord: null }
    facts.set(repo, f)
  }
  return f
}

/** `repo`'s facts for the CURRENT counter span, rebased on reset since
 *  attribution belongs to the span, not the session. Seeded from the span's
 *  OWN starting workspace, not left empty — empty would let a session that
 *  reset in one workspace and switched to another claim the second's
 *  attribution while carrying the first's work, the permissive direction. */
const factsForSpan = (repo: MetricsSpanSource): SessionFacts => {
  const f = factsFor(repo)
  const { epoch, epochWorkspaceId } = repo.metricsSpan()
  if (f.epoch !== epoch) {
    f.epoch = epoch
    f.seenWorkspace = epochWorkspaceId
    f.unattributable = false
    f.pageRecord = null
  }
  return f
}

/** Where this PAGE first activated — module-scoped, neither per-Repo nor
 *  per-span, since no reset changes it. Claimed by whoever asks first; the
 *  always-on observe effect asks on every activation, so it's set even while
 *  a recorder's plugin is off (claiming it itself would record wherever
 *  ENABLED, not where boot began). */
let origin: { repo: object; workspaceId: string } | null = null

export const pageOrigin = (
  repo: object,
  workspaceId: string,
): { repo: object; workspaceId: string } => (origin ??= { repo, workspaceId })

/** Test helper — forget where this "page" started. */
export const resetPageOrigin = (): void => { origin = null }

/** Note that `workspaceId` is now active in this page session. Called on
 *  workspace ACTIVATION, not when a sample is written, since a session can
 *  enter and leave before the first sample is due and the page-global
 *  counters carry that work regardless. Every enabled consumer calls this
 *  (recorder/monitor are independent toggles); idempotent, so all of them
 *  calling is correct, not merely harmless. */
export const observeWorkspace = (repo: MetricsSpanSource, workspaceId: string): void => {
  pageOrigin(repo, workspaceId)
  const f = factsForSpan(repo)
  if (f.seenWorkspace === null) f.seenWorkspace = workspaceId
  else if (f.seenWorkspace !== workspaceId) f.unattributable = true
}

/** The always-on half of the rule: `observeWorkspace` must see EVERY
 *  workspace this session activates. If observation lived only in the
 *  consuming plugins' effects, enabling one mid-session would silently
 *  attribute earlier work to whatever workspace was active — so this runs in
 *  the composition root outside either toggle. */
export const observeWorkspaceEffect: AppEffect = {
  id: 'metrics.observe-workspace',
  start: ({ repo, workspaceId }) => {
    if (workspaceId) observeWorkspace(repo, workspaceId)
  },
}

export const observeWorkspaceEffectContribution = appEffectsFacet.of(observeWorkspaceEffect, {
  source: 'interaction-metrics',
})

/** Remember the record block this page session owns. */
export const setPageRecord = (
  repo: MetricsSpanSource,
  workspaceId: string,
  blockId: string,
  startedAt: number,
  /** `metrics().epoch` the sample being claimed was READ under. */
  sampleEpoch: number,
): void => {
  // The row belongs to the span it was MEASURED in — a reset landing before
  // this callback would inherit a row from the old span. Costs one sample.
  const f = factsForSpan(repo)
  if (f.epoch !== sampleEpoch) return
  f.pageRecord = { blockId, workspaceId, startedAt }
}

/** Forget it — the block was deleted underneath us, so a replacement is due. */
export const clearPageRecord = (repo: object): void => { factsFor(repo).pageRecord = null }

/** Start of the page session that owns `workspaceId`'s record, if any. */
export const pageRecordStartedAt = (repo: object, workspaceId: string): number | null => {
  const r = factsFor(repo).pageRecord
  return r?.workspaceId === workspaceId ? r.startedAt : null
}

/** Why recording is impossible here, or null; order matters only for which
 *  blocker is REPORTED. No persistent client id: history is written where
 *  the next session never looks. Read-only workspace: Automation admits the
 *  write locally and RLS then refuses it into the rejection quarantine.
 *  Exported (not cached) since `repo.isReadOnly` is LIVE and follows a
 *  server-pushed role change. */
export const recordingBlockedBy = (
  repo: Pick<Repo, 'isReadOnly'>,
): RecordingBlocker | null =>
  !isClientIdPersistent()
    ? 'no-persistent-client'
    : repo.isReadOnly
      ? 'read-only-workspace'
      : null

export const metricsSessionContext = (
  repo: SessionRepoFacts,
  workspaceId: string,
): MetricsSessionContext => {
  const f = factsForSpan(repo)
  const blockedBy = recordingBlockedBy(repo)
  return {
    canRecord: blockedBy === null,
    blockedBy,
    // Requires an EXPLICIT observation — defaulting to attributable would let
    // an unregistered caller claim the counters, the permissive direction.
    attributable: !f.unattributable && f.seenWorkspace === workspaceId,
    recordId: f.pageRecord?.workspaceId === workspaceId ? f.pageRecord.blockId : null,
  }
}

/** One reading of the live counters, with the session facts that qualify
 *  them. `resetMetrics()` is a supported hook, so a reader that misses a
 *  span change keeps updating a stale record — recorder and monitor are both
 *  entry points, which is why the span is adopted here once, not per call. */
export const readLiveSession = (
  repo: Repo,
  workspaceId: string,
): { metrics: ReturnType<Repo['metrics']>; session: MetricsSessionContext } => {
  // Belt and braces over `observeWorkspaceEffect` (idempotent); also adopts
  // the current span, so the reading below is taken after this, not before.
  observeWorkspace(repo, workspaceId)
  return peekLiveSession(repo, workspaceId)
}

/** The same reading, WITHOUT registering an observation — for a consumer
 *  that is only looking. Observing is a claim about presence, and a stale
 *  analysis can be wrong to make: observing the workspace being analysed
 *  after the user moved on and reset would mark the fresh span
 *  unattributable. The span is still adopted (rebases to the current epoch);
 *  only the "seen" claim is skipped. */
export const peekLiveSession = (
  repo: Repo,
  workspaceId: string,
): { metrics: ReturnType<Repo['metrics']>; session: MetricsSessionContext } =>
  ({ metrics: repo.metrics(), session: metricsSessionContext(repo, workspaceId) })

/** Test helper — forget one Repo's session facts, and where the "page"
 *  started: a test simulating a second page session means both. */
export const resetMetricsSession = (repo: object): void => {
  facts.delete(repo)
  resetPageOrigin()
}

/** How long to wait for the membership row before giving up on this attempt.
 *  The callers are idle-scheduled and retry, so a timeout costs one sample. */
const ROLE_WAIT_MS = 10_000

/**
 * The authoritative "may I write here?" — awaited, unlike `canRecord`.
 * `repo.isReadOnly` alone is NOT sufficient: it defaults to FALSE until the
 * `workspace_members` row replicates, so a fresh-device viewer reads as
 * writable during the initial sync, and writes then land in the rejection
 * quarantine via Automation-then-RLS. Mirrors `src/data/definitionSeeds.ts`'s
 * shape for seed writes, including the active-workspace re-check.
 *
 * An unresolved role is NOT allowed (callers retry, so refusing is cheap).
 * Short-circuits when remote sync is inactive: nothing uploads, so there is
 * nothing to protect against, and no membership row to wait for.
 */
export const awaitRecordingAllowed = async (
  repo: Repo,
  workspaceId: string,
): Promise<boolean> => {
  if (!metricsSessionContext(repo, workspaceId).canRecord) return false
  // `canRecord` already implies not read-only, so there is nothing left to
  // check here: with no uploads there is no refusal to avoid.
  if (!isRemoteSyncActive()) return true
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ROLE_WAIT_MS)
  try {
    const role = await awaitLocalMemberRole(repo, workspaceId, repo.user.id, {
      signal: controller.signal,
    })
    if (repo.activeWorkspaceId !== workspaceId) return false
    return role !== 'viewer' && !repo.isReadOnly
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** What an artifact was computed under: a Repo, a workspace, and a span of
 *  the page-global counters, each separately replaceable in flight (sign-out
 *  swaps the Repo, a switch changes the workspace, `resetMetrics()` starts a
 *  new span) — so an artifact outliving any of them describes a world that
 *  no longer exists. Tracked together so a consumer cannot guard one and
 *  miss the others; captured where work starts, compared where it's used. */
export interface MetricsContext {
  readonly repo: object
  readonly workspaceId: string
  readonly epoch: number
}

export const metricsContext = (repo: Repo, workspaceId: string): MetricsContext =>
  ({ repo, workspaceId, epoch: repo.metrics().epoch })

/** Does `ctx` still describe the world? Identity on the Repo, because a
 *  discarded one keeps its own `activeWorkspaceId` forever and so answers every
 *  question about itself in the affirmative. */
export const contextHolds = (ctx: MetricsContext, repo: Repo): boolean =>
  ctx.repo === repo &&
  ctx.workspaceId === repo.activeWorkspaceId &&
  ctx.epoch === repo.metrics().epoch

/** Thrown to roll back a record write whose eligibility lapsed mid-transaction. */
export class NoLongerEligible extends Error {}

/** Re-read writability INSIDE the writing transaction: the checks before it
 *  are separated from the commit by several awaits, and an Automation-scope
 *  write is admitted locally regardless, so refusal must be re-taken here. */
export const assertStillWritable = (repo: Repo, workspaceId: string): void => {
  if (repo.activeWorkspaceId !== workspaceId) throw new NoLongerEligible()
  if (!metricsSessionContext(repo, workspaceId).canRecord) throw new NoLongerEligible()
}

// ACCEPTED, not overlooked: `repo.isReadOnly` lags the membership row, so a
// demotion here can commit one refused write — not worth a DB read per
// transaction to close a microsecond window that self-heals next sample.

/** Additionally require the counters to be attributable to this workspace —
 *  INTERACTION only, since a startup record is a boot timeline, not derived
 *  from the counters. The active workspace is also checked directly: a
 *  switch's effect may not have run yet, so `attributable` can still read
 *  true for a record whose snapshot already holds new work. */
export const assertStillAttributable = (
  repo: Repo,
  workspaceId: string,
  /** `metrics().epoch` the sample was READ under. A reset landing between the
   *  read and this transaction starts a new span; without this check the
   *  write lands on the new span's terms while holding the old span's
   *  counters, and nothing later corrects the resulting stale row. */
  sampleEpoch: number,
): void => {
  assertStillWritable(repo, workspaceId)
  if (repo.metrics().epoch !== sampleEpoch) throw new NoLongerEligible()
  if (!metricsSessionContext(repo, workspaceId).attributable) throw new NoLongerEligible()
}
