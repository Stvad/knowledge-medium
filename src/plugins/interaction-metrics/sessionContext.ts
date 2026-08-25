/**
 * One owner for the question every part of the metrics feature asks: **what can
 * this page session honestly say?**
 *
 * The answers are independent — is there a durable identity to file history
 * under, may we write here, are the counters attributable to one workspace, how
 * much of them is our own bookkeeping — and consumers must ASK rather than
 * re-derive. A consumer that answers for itself is a place the rule can be
 * forgotten, and the rules bind a recorder and a reader that are separately
 * togglable.
 *
 * Everything here is page-session scoped, because `repo.metrics()` is: its
 * counters are monotonic from Repo construction and are not segmented by
 * workspace.
 */
import { appEffectsFacet, type AppEffect } from '@/extensions/core.js'
import type { Repo } from '@/data/repo'
import { awaitLocalMemberRole } from '@/data/workspaces.js'
import { isRemoteSyncActive } from '@/data/repoProvider.js'
import { isClientIdPersistent } from '@/utils/clientId.js'

/** Why this session may not persist metrics, or null when it may. */
export type RecordingBlocker = 'no-persistent-client' | 'read-only-workspace'

export interface MetricsSessionContext {
  /** May this session persist a record at all? */
  canRecord: boolean
  /** Populated exactly when `canRecord` is false. */
  blockedBy: RecordingBlocker | null
  /** Are the live counters attributable to this one workspace? False once the
   *  page session has been in more than one. */
  attributable: boolean
  /** What the recorders themselves cost, to be discounted from any reading of
   *  the live counters. */
  own: OwnActivity
  /** The record block this page session owns in `workspaceId`, if any. */
  recordId: string | null
}

/**
 * The recorders' own contribution to the page-global counters.
 *
 * BOTH sides, because the fan-out metric is a ratio of one to the other and
 * correcting only the denominator is worse than correcting neither: it moves
 * the ratio UP, which is the direction that invents regressions. A record
 * create changes live-set membership, which fires `kernel.content` and
 * `typedBlocks.live` — so any mounted workspace-wide handle (Recents, an open
 * search, a typed-block view) really is invalidated by our own bookkeeping.
 */
export interface OwnActivity {
  /** Transactions the recorders issued. */
  writes: number
  /** `handleStore` counter deltas measured across those transactions. */
  fanout: Readonly<Record<string, number>>
}

/** Minimal read surface, so this module needs no Repo import (and stays cheap
 *  to call from a test). */
export interface SessionRepoFacts {
  isReadOnly: boolean
}

/**
 * Facts are held PER REPO, not in globals with a rebind.
 *
 * A local sign-out swaps the Repo without a reload, and an old recorder can
 * still be awaiting or writing when it does. With one global slot, that stale
 * callback rebinds the facts back to the Repo it belongs to and clears the new
 * one's — losing a multi-workspace refusal or the record the new session owns.
 * Keyed by Repo, a stale callback simply reads its own (correct) facts and
 * cannot touch anyone else's, and a discarded Repo's entry is collected with
 * it.
 */
interface SessionFacts {
  seenWorkspace: string | null
  unattributable: boolean
  ownWrites: number
  ownFanout: Record<string, number>
  /** Highest `writeTransaction.calls` OBSERVED — only ever assigned from a
   *  reading of the live counter, never advanced by a delta. A drop below it
   *  means the counters were zeroed under us (`repo.resetMetrics()` is a
   *  supported hook), which the own-write count is a subtrahend of.
   *
   *  Advancing it by a delta instead would detect slightly more resets, and puts
   *  it above the true counter whenever a reading lands between one of our
   *  transactions committing and it being credited — inventing a reset, which
   *  clears the correction and forks a second record block into the graph.
   *  Missing a reset costs one stale comparison; inventing one writes to the
   *  user's data. */
  writeWatermark: number
  pageRecord: { blockId: string; workspaceId: string; startedAt: number } | null
}

const facts = new WeakMap<object, SessionFacts>()

const factsFor = (repo: object): SessionFacts => {
  let f = facts.get(repo)
  if (!f) {
    f = { seenWorkspace: null, unattributable: false, ownWrites: 0, ownFanout: {}, writeWatermark: 0, pageRecord: null }
    facts.set(repo, f)
  }
  return f
}

/**
 * Note that `workspaceId` is now active in this page session.
 *
 * Called when a workspace becomes ACTIVE, not when a sample is written: a
 * session can enter a second workspace and leave again before that workspace's
 * first sample is ever due, and the page-global counters carry its work
 * regardless. Every enabled consumer calls this — the recorder and the monitor
 * are independent toggles, so neither can be relied on to be the one watching.
 * Idempotent, so all of them calling is correct rather than merely harmless.
 */
export const observeWorkspace = (repo: object, workspaceId: string): void => {
  const f = factsFor(repo)
  if (f.seenWorkspace === null) f.seenWorkspace = workspaceId
  else if (f.seenWorkspace !== workspaceId) f.unattributable = true
}

/**
 * The always-on half of the rule.
 *
 * `observeWorkspace` has to see EVERY workspace this page session activates,
 * and the plugins that consume it are independently togglable — so if
 * observation lived only in their effects, enabling one mid-session would start
 * the history at whatever workspace happened to be active, silently attributing
 * work done in an earlier one to it. This effect is registered in the
 * composition root outside either toggle.
 */
export const observeWorkspaceEffect: AppEffect = {
  id: 'metrics.observe-workspace',
  start: ({ repo, workspaceId }) => {
    if (workspaceId) observeWorkspace(repo, workspaceId)
  },
}

export const observeWorkspaceEffectContribution = appEffectsFacet.of(observeWorkspaceEffect, {
  source: 'interaction-metrics',
})

/** Re-base from an observed counter total — see `writeWatermark`. Returns
 *  whether that reading showed the counters had been zeroed under us, which
 *  starts a new accounting epoch AND a new record, since the old row describes
 *  a span the counters no longer cover. */
export const noteCounterTotal = (repo: object, totalWrites: number): boolean => {
  const f = factsFor(repo)
  const reset = totalWrites < f.writeWatermark
  if (reset) {
    f.ownWrites = 0
    // `resetMetrics()` zeroes the handle-store counters in the same call, so
    // the fan-out subtrahend belongs to the old epoch exactly as the write one
    // does. Left behind it would be subtracted from counters that never
    // contained it.
    f.ownFanout = {}
    f.pageRecord = null
  }
  f.writeWatermark = totalWrites
  return reset
}

/** Credit the recorders' own activity. Deliberately does NOT touch
 *  `writeWatermark` — see its declaration. */
const noteOwnActivity = (repo: object, writes: number, fanout: Record<string, number>): void => {
  const f = factsFor(repo)
  // Fan-out is credited whatever `writes` is: the `ensure` helpers write through
  // `repo.tx` directly, so a body can invalidate without issuing a counted one.
  for (const [k, v] of Object.entries(fanout)) f.ownFanout[k] = (f.ownFanout[k] ?? 0) + v
  f.ownWrites += writes
}

/** Remember the record block this page session owns. */
export const setPageRecord = (
  repo: object, workspaceId: string, blockId: string, startedAt: number,
): void => { factsFor(repo).pageRecord = { blockId, workspaceId, startedAt } }

/** Forget it — the block was deleted underneath us, so a replacement is due. */
export const clearPageRecord = (repo: object): void => { factsFor(repo).pageRecord = null }

/** Start of the page session that owns `workspaceId`'s record, if any. */
export const pageRecordStartedAt = (repo: object, workspaceId: string): number | null => {
  const r = factsFor(repo).pageRecord
  return r?.workspaceId === workspaceId ? r.startedAt : null
}

export const metricsSessionContext = (
  repo: SessionRepoFacts,
  workspaceId: string,
): MetricsSessionContext => {
  const f = factsFor(repo)
  // Order matters only for which blocker is REPORTED; both are disqualifying.
  //
  // Without a persistent client id, per-client history is written where the
  // next session will never look for it — unreadable groups accumulating in the
  // graph forever. In a read-only workspace the Automation scope admits the
  // write locally and the server's RLS then refuses the upload, parking it in
  // the rejection quarantine the status chip reports to the user.
  const blockedBy: RecordingBlocker | null = !isClientIdPersistent()
    ? 'no-persistent-client'
    : repo.isReadOnly
      ? 'read-only-workspace'
      : null
  return {
    canRecord: blockedBy === null,
    blockedBy,
    // Requires an EXPLICIT observation. Defaulting to attributable when nobody
    // has observed would let a caller that never registered the workspace claim
    // the counters anyway — the permissive direction on a rule whose whole job
    // is to refuse.
    attributable: !f.unattributable && f.seenWorkspace === workspaceId,
    // Copied, not aliased: the live map keeps accumulating while a consumer
    // holds this reading across its awaits.
    own: { writes: f.ownWrites, fanout: { ...f.ownFanout } },
    recordId: f.pageRecord?.workspaceId === workspaceId ? f.pageRecord.blockId : null,
  }
}

/**
 * One reading of the live counters, together with the session facts that
 * qualify them.
 *
 * The rebase and the snapshot must come from the SAME reading. `resetMetrics()`
 * is a supported hook, and a consumer that snapshots without re-basing
 * subtracts a previous epoch's own-writes from post-reset counters — inflating
 * the fan-out ratio and excluding a record block that no longer describes the
 * live span. The recorder does this on every sample; the monitor's manual
 * "re-analyze" is a second entry point into the same snapshot, which is exactly
 * why it is taken here rather than at each call site.
 */
export const readLiveSession = (
  repo: Repo,
  workspaceId: string,
): { metrics: ReturnType<Repo['metrics']>; session: MetricsSessionContext } => {
  // Belt and braces over `observeWorkspaceEffect`, which is registered outside
  // both plugin toggles and is the one that actually guarantees this. Idempotent.
  observeWorkspace(repo, workspaceId)
  const metrics = repo.metrics()
  noteCounterTotal(repo, metrics.db.writeTransaction?.calls ?? 0)
  return { metrics, session: metricsSessionContext(repo, workspaceId) }
}

/** Test helper — forget one Repo's session facts. */
export const resetMetricsSession = (repo: object): void => {
  facts.delete(repo)
}

/** How long to wait for the membership row before giving up on this attempt.
 *  The callers are idle-scheduled and retry, so a timeout costs one sample. */
const ROLE_WAIT_MS = 10_000

/**
 * The authoritative "may I write here?" — awaited, unlike `canRecord`.
 *
 * `repo.isReadOnly` is NOT sufficient on its own: it defaults to FALSE until
 * the `workspace_members` row replicates, so a viewer opening a shared
 * workspace on a fresh device reads as writable for as long as the initial
 * sync takes. Every record written in that window is admitted locally by the
 * Automation scope and then refused by RLS, landing in the rejection quarantine
 * the status chip reports to the user as changes that could not sync — and the
 * interaction recorder would keep manufacturing them every five minutes.
 *
 * `src/data/definitionSeeds.ts` reached the same conclusion for seed writes and
 * this mirrors its shape, including the re-check that the workspace is still
 * the active one after the await.
 *
 * An unresolved role is treated as NOT allowed: the callers retry, so refusing
 * costs one sample while allowing costs a quarantined upload.
 *
 * Short-circuits when remote sync is inactive (local-only, tests). The whole
 * point of the wait is to avoid an upload the server will refuse; with nothing
 * uploading there is nothing to refuse, and waiting for a membership row that
 * a local-only workspace has no reason to replicate would disable recording
 * outright.
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

/** Run `body`, counting the transactions the recorder issues through the
 *  `recordTx` it is handed.
 *
 *  Counted per transaction WE issue, not as a delta on the global counter
 *  across our awaits: a user write landing in that window would be attributed
 *  to us and subtracted from `writes`, shrinking the fan-out denominator and
 *  inventing regressions. Transactions the `ensure`-style helpers commit on
 *  first use are deliberately NOT counted — they cannot be told apart from a
 *  concurrent user write, and under-counting only shrinks the reported ratio,
 *  which suppresses a finding rather than fabricating one.
 *
 *  Shared by BOTH recorders: they feed one lifetime counter, so a correction
 *  applied to only one of them is worse than none. */
export const countingOwnWrites = async <T>(
  repo: Repo,
  body: (recordTx: Repo['tx']) => Promise<T>,
): Promise<T> => {
  let issued = 0
  const recordTx = (async (fn, opts) => {
    issued++
    return repo.tx(fn, opts)
  }) as Repo['tx']
  // Fan-out is measured across the WHOLE body, not per counted transaction: the
  // `ensure`-style helpers commit their own transactions on first use and fire
  // the same workspace-wide channels, and leaving them out would inflate the
  // numerator on precisely the session with the least other traffic. Reading the
  // handle-store counters directly rather than through `repo.metrics()`, which
  // additionally sorts every query's 256-sample reservoir to build percentiles.
  //
  // KNOWN GAP: two overlapping bodies (the two recorders share one Repo) credit
  // the intersection twice, and `ownFanout` only ever grows, so one overlap
  // biases the rest of the session. It errs toward suppressing a finding.
  const before = repo.handleStore.metrics.snapshot()
  try {
    return await body(recordTx)
  } finally {
    // Re-base the watermark from an OBSERVED total now that our own writes have
    // landed. Taking a reading at both ends of our own work is what lets the
    // watermark detect a reset without ever being advanced by a delta — see its
    // declaration for why a delta is not an option. One reservoir's snapshot,
    // not `repo.metrics()`, which additionally sorts every query's.
    const reset = noteCounterTotal(repo, repo.dbMetrics.writeTransaction.snapshot().calls)
    const after = repo.handleStore.metrics.snapshot()
    const fanout: Record<string, number> = {}
    for (const [k, v] of Object.entries(after)) fanout[k] = v - (before[k] ?? 0)
    // A reset inside the body leaves our own delta spanning two epochs, so
    // crediting it would re-poison the accounting the line above just cleared.
    // Credited to the Repo the writes actually happened in, which a stale
    // callback finishing after a sign-out still names correctly.
    if (!reset) noteOwnActivity(repo, issued, fanout)
  }
}

/** Thrown to roll back a record write whose eligibility lapsed mid-transaction. */
export class NoLongerEligible extends Error {}

/** Re-read writability INSIDE the writing transaction. The checks before it are
 *  separated from the commit by several awaits — a workspace switch or a role
 *  resolving to viewer lands in that window, and an Automation-scope write is
 *  admitted locally regardless, so the refusal has to be re-taken where the
 *  write actually happens. Both recorders need this. */
export const assertStillWritable = (repo: Repo, workspaceId: string): void => {
  if (repo.activeWorkspaceId !== workspaceId) throw new NoLongerEligible()
  if (!metricsSessionContext(repo, workspaceId).canRecord) throw new NoLongerEligible()
}

// ACCEPTED, not overlooked: this reads `repo.isReadOnly`, which App updates from
// a React effect and so lags the membership row. A demotion landing between
// `awaitRecordingAllowed` and the transaction it guards therefore still commits
// one Automation write that RLS refuses. Re-reading the authoritative role would
// mean a database read inside every telemetry transaction, forever, to close a
// window measured in microseconds whose cost is a single quarantined row — and
// the next sample's gate refuses, so it does not repeat.

/** Additionally require the counters to be attributable to this workspace.
 *
 *  INTERACTION only. A startup record is a timeline of this boot and does not
 *  derive from the page-global counters, so blending across workspaces says
 *  nothing about whether it is truthful — gating it on attributability would
 *  refuse a perfectly good record.
 *
 *  The active workspace is checked directly rather than only through
 *  attributability: a switch is observed by the new workspace's effect, which
 *  may not have run yet, so `attributable` can still read true for a record
 *  whose snapshot already contains the new workspace's work. */
export const assertStillAttributable = (repo: Repo, workspaceId: string): void => {
  assertStillWritable(repo, workspaceId)
  if (!metricsSessionContext(repo, workspaceId).attributable) throw new NoLongerEligible()
}
