/**
 * One owner for the question every part of the metrics feature keeps asking:
 * **what can this page session honestly say?**
 *
 * That question has several independent answers — is there a durable identity
 * to file history under, may we write here, are the counters attributable to
 * one workspace, how much of them is our own bookkeeping — and each one was
 * previously checked by whichever module needed it first. That is a defect
 * generator, not a style problem: every consumer that re-derives an answer is a
 * place the rule can be forgotten, and six separate defects on this feature were
 * exactly that (a recorder and a reader disagreeing, an effect and a write
 * disagreeing, a chip and a dialog disagreeing).
 *
 * So the facts live here and the consumers ASK. The recorder asks "may I
 * write?", the monitor asks "may I compare?", and both get the same answer from
 * the same place.
 *
 * Everything here is page-session scoped, because `repo.metrics()` is: its
 * counters are monotonic from Repo construction and are not segmented by
 * workspace.
 */
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

/** Record that a recorder issued one transaction of its own. */
export const noteOwnWrite = (): void => { ownWrites++ }

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
    attributable: !unattributable && (seenWorkspace === null || seenWorkspace === workspaceId),
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
