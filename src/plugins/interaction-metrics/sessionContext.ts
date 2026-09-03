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
 * Scope follows `repo.metrics()`: one page session, one Repo, and one SPAN of
 * the counters — they are monotonic from the last `resetMetrics()` and are not
 * segmented by workspace, so a reset invalidates every claim made about them.
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
  /** The record block this page session owns in `workspaceId`, if any. */
  recordId: string | null
}

/** The identity of the counter span a reading came from. Everything here is a
 *  claim ABOUT a span, so every entry point takes this much of a Repo. */
export interface MetricsSpanSource {
  metrics: () => { epoch: number; epochWorkspaceId: string | null }
}

/** Minimal read surface, so this module needs no Repo import (and stays cheap
 *  to call from a test). */
export interface SessionRepoFacts extends MetricsSpanSource {
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
  /** The `repo.metrics().epoch` these facts describe. A reset zeroes the
   *  counters, so everything here — the record opened against them and the
   *  attribution claimed for them — describes a span that no longer exists. */
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

/**
 * `repo`'s facts for the CURRENT counter span, rebased if there has been a
 * reset since they were last touched.
 *
 * Attribution is a claim about a span, so it belongs to the span rather than to
 * the page session: `resetMetrics()` starts a new one, and neither the record
 * opened against the old counters nor the workspaces observed under them says
 * anything about the new one.
 *
 * Seeded from the span's OWN starting workspace, not left empty. A reset can
 * land in any workspace, and the work between it and the first observation
 * afterwards belongs to whatever was active then — starting empty would let a
 * session that reset in one workspace and switched to another claim the
 * second's attribution while carrying the first's work, which is the permissive
 * direction on a rule whose whole job is to refuse.
 */
const factsForSpan = (repo: MetricsSpanSource): SessionFacts => {
  const f = factsFor(repo)
  const { epoch, epochWorkspaceId } = repo.metrics()
  if (f.epoch !== epoch) {
    f.epoch = epoch
    f.seenWorkspace = epochWorkspaceId
    f.unattributable = false
    f.pageRecord = null
  }
  return f
}

/** Where this PAGE first activated — the Repo and workspace a boot happened in.
 *
 *  Module-scoped, and neither per-Repo nor per-span: it answers "where did this
 *  page start", which no metrics reset changes. Claimed by whoever asks first,
 *  and the always-on observe effect asks on EVERY activation — so it is set
 *  even while a recorder's own plugin is switched off. A recorder claiming it
 *  itself would instead record wherever it was ENABLED, and file page-global
 *  boot timings collected in another workspace under that one. */
let origin: { repo: object; workspaceId: string } | null = null

export const pageOrigin = (
  repo: object,
  workspaceId: string,
): { repo: object; workspaceId: string } => (origin ??= { repo, workspaceId })

/** Test helper — forget where this "page" started. */
export const resetPageOrigin = (): void => { origin = null }

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
export const observeWorkspace = (repo: MetricsSpanSource, workspaceId: string): void => {
  pageOrigin(repo, workspaceId)
  const f = factsForSpan(repo)
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

/** Remember the record block this page session owns. */
export const setPageRecord = (
  repo: MetricsSpanSource,
  workspaceId: string,
  blockId: string,
  startedAt: number,
  /** `metrics().epoch` the sample being claimed was READ under. */
  sampleEpoch: number,
): void => {
  // The row belongs to the span it was MEASURED in. A `resetMetrics()` landing
  // between the transaction's epoch check and this callback rebases the facts,
  // and claiming into the new span would hand it a row whose counters and
  // `startedAt` describe the old one — the next sample then updates that row in
  // place, mixing fresh counters into an inflated session duration. Declining
  // costs the new span one sample, which it mints for itself.
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

/** Why recording is impossible here, or null.
 *
 *  Order matters only for which blocker is REPORTED; both are disqualifying.
 *
 *  Without a persistent client id, per-client history is written where the next
 *  session will never look for it — unreadable groups accumulating in the graph
 *  forever. In a read-only workspace the Automation scope admits the write
 *  locally and the server's RLS then refuses the upload, parking it in the
 *  rejection quarantine the status chip reports to the user.
 *
 *  Exported because it is a LIVE fact: `repo.isReadOnly` follows a
 *  server-pushed role change without anything else moving, so a reader that
 *  stored the answer would keep reporting the world as it was.
 */
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
  // Order matters only for which blocker is REPORTED; both are disqualifying.
  //
  // Without a persistent client id, per-client history is written where the
  // next session will never look for it — unreadable groups accumulating in the
  // graph forever. In a read-only workspace the Automation scope admits the
  // write locally and the server's RLS then refuses the upload, parking it in
  // the rejection quarantine the status chip reports to the user.
  const blockedBy = recordingBlockedBy(repo)
  return {
    canRecord: blockedBy === null,
    blockedBy,
    // Requires an EXPLICIT observation. Defaulting to attributable when nobody
    // has observed would let a caller that never registered the workspace claim
    // the counters anyway — the permissive direction on a rule whose whole job
    // is to refuse.
    attributable: !f.unattributable && f.seenWorkspace === workspaceId,
    recordId: f.pageRecord?.workspaceId === workspaceId ? f.pageRecord.blockId : null,
  }
}

/**
 * One reading of the live counters, together with the session facts that
 * qualify them.
 *
 * `resetMetrics()` is a supported hook, and a consumer that reads the figures
 * without noticing the span moved keeps updating a record describing counters
 * that no longer exist. The recorder does this on every sample; the monitor's
 * manual "re-analyze" is a second entry point into the same snapshot, which is
 * why the span is adopted here rather than at each call site.
 */
export const readLiveSession = (
  repo: Repo,
  workspaceId: string,
): { metrics: ReturnType<Repo['metrics']>; session: MetricsSessionContext } => {
  // Belt and braces over `observeWorkspaceEffect`, which is registered outside
  // both plugin toggles and is the one that actually guarantees this. Idempotent.
  // It also adopts the current span, which is why the reading below is taken
  // after it rather than before.
  observeWorkspace(repo, workspaceId)
  return peekLiveSession(repo, workspaceId)
}

/** The same reading, WITHOUT registering an observation.
 *
 *  For a consumer that is only looking. Observing is a claim about where this
 *  page has been, and a reader making it can be wrong about the present: an
 *  analysis for one workspace is still reading history when the user moves to
 *  another and resets the counters, and observing the workspace it was
 *  analysing marks the fresh span unattributable — disabling interaction
 *  sampling for a workspace that never blended anything, until the next reset.
 *
 *  The span is still adopted, because `metricsSessionContext` rebases to the
 *  current epoch; what is not done is asserting that this workspace was seen. */
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

/**
 * What an artifact was computed under.
 *
 * Everything this feature produces — an analysis, a boot timeline, the rows in
 * an open dialog — is derived from a Repo, a workspace, and a span of the
 * page-global counters. Each is separately replaceable while the work is in
 * flight: a local sign-out swaps the Repo without a reload, a switch changes
 * the workspace, `resetMetrics()` starts a new span. An artifact outliving any
 * of them describes a world that no longer exists.
 *
 * All three together, so a consumer cannot guard one and miss the others.
 * Captured where the work starts and compared where its result is used.
 */
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
export const assertStillAttributable = (
  repo: Repo,
  workspaceId: string,
  /** `metrics().epoch` the sample being written was READ under. A
   *  `resetMetrics()` landing between the read and this transaction starts a
   *  new span, and the attribution check adopts it — so without this the write
   *  is approved on the new span's terms while the payload still holds the old
   *  span's counters, and `onCommitted` then claims that stale row as the new
   *  span's current record. Nothing later corrects it: the row reads as this
   *  session's, so the next sample updates it rather than opening a
   *  replacement, and a session ending first leaves it in the trend. */
  sampleEpoch: number,
): void => {
  assertStillWritable(repo, workspaceId)
  if (repo.metrics().epoch !== sampleEpoch) throw new NoLongerEligible()
  if (!metricsSessionContext(repo, workspaceId).attributable) throw new NoLongerEligible()
}
