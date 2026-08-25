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
  /** Transactions the recorders issued themselves, to be discounted from any
   *  write count derived from the live counters. */
  ownWrites: number
  /** The record block this page session owns in `workspaceId`, if any. */
  recordId: string | null
}

/** Minimal read surface, so this module needs no Repo import (and stays cheap
 *  to call from a test). */
export interface SessionRepoFacts {
  isReadOnly: boolean
}

interface PageRecord {
  blockId: string
  workspaceId: string
  startedAt: number
}

let seenWorkspace: string | null = null
let unattributable = false
let ownWrites = 0
let pageRecord: PageRecord | null = null

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
export const observeWorkspace = (workspaceId: string): void => {
  if (seenWorkspace === null) seenWorkspace = workspaceId
  else if (seenWorkspace !== workspaceId) unattributable = true
}

/**
 * The always-on half of the rule.
 *
 * `observeWorkspace` has to see EVERY workspace this page session activates,
 * and the plugins that consume it are independently togglable — so if
 * observation lived only in their effects, enabling one mid-session would start
 * the history at whatever workspace happened to be active, silently attributing
 * work done in an earlier one to it. This effect is registered in the
 * composition root outside either toggle, so the counters cannot outrun what
 * has been observed.
 */
export const observeWorkspaceEffect: AppEffect = {
  id: 'metrics.observe-workspace',
  start: ({ workspaceId }) => {
    if (workspaceId) observeWorkspace(workspaceId)
  },
}

export const observeWorkspaceEffectContribution = appEffectsFacet.of(observeWorkspaceEffect, {
  source: 'interaction-metrics',
})

/** Record transactions a recorder issued itself.
 *
 *  Counted as a DELTA measured around the write rather than incremented per
 *  `repo.tx` call, because the recorders do not issue all their own
 *  transactions: `getPluginUIStateBlock` / `getPluginUIStateChild` each commit
 *  one on first use, and those land in the same lifetime counter. Both
 *  recorders must report, since the count they feed is the denominator of the
 *  other's fan-out ratio. */
export const noteOwnWrites = (count: number): void => {
  if (count > 0) ownWrites += count
}

/** Remember the record block this page session owns. */
export const setPageRecord = (workspaceId: string, blockId: string, startedAt: number): void => {
  pageRecord = { workspaceId, blockId, startedAt }
}

/** Forget it — the block was deleted underneath us, so a replacement is due. */
export const clearPageRecord = (): void => { pageRecord = null }

/** Start of the page session that owns `workspaceId`'s record, if any. */
export const pageRecordStartedAt = (workspaceId: string): number | null =>
  pageRecord?.workspaceId === workspaceId ? pageRecord.startedAt : null

export const metricsSessionContext = (
  repo: SessionRepoFacts,
  workspaceId: string,
): MetricsSessionContext => {
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
    attributable: !unattributable && seenWorkspace === workspaceId,
    ownWrites,
    recordId: pageRecord?.workspaceId === workspaceId ? pageRecord.blockId : null,
  }
}

/** Test helper — forget this process's session. */
export const resetMetricsSession = (): void => {
  seenWorkspace = null
  unattributable = false
  ownWrites = 0
  pageRecord = null
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
  if (!isRemoteSyncActive()) return !repo.isReadOnly
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
