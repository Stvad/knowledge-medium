/**
 * Startup-metrics persistence: assemble the cold-start timeline into a durable
 * record and store it as a block-per-session under a hidden per-user ui-state
 * subtree. Block-per-session (a fresh block id each boot) keeps the log
 * conflict-free across devices — two devices booting never touch the same row,
 * unlike a shared JSON-array property which would LWW-clobber. Each record
 * carries the device + version so a fleet-wide history is groupable.
 *
 * Why a record exists at all: see `src/utils/startupTimeline.ts`. This is the
 * "store it so we can see TTI trend, not just feel it" half.
 */

import { ChangeScope, seedProperty, seedType } from '@/data/api'
import type { Repo } from '@/data/repo'
import type { AppEffect } from '@/extensions/core.js'
import { onFirstSync, type SyncStatusDb } from '@/data/internals/firstSync.js'
import { appVersion } from '@/appVersion.js'
import { getClientId, getDeviceLabel } from '@/utils/clientId.js'
import {
  awaitRecordingAllowed,
  NoLongerEligible,
  pageOrigin,
  resetPageOrigin,
} from '@/plugins/interaction-metrics/sessionContext.js'
import { appendClientRecord } from '@/plugins/interaction-metrics/recordStore.js'
import { scheduleIdle } from '@/utils/scheduleIdle.js'
import {
  getLastLongTaskEndMs,
  getStartupTimeline,
  hasStartupMark,
  longTasksSupported,
  markStartup,
  markStartupAt,
  onLongTask,
  type StartupTimeline,
} from '@/utils/startupTimeline.js'

/** One persisted cold-start sample. All `*Ms` fields are ms-since-boot
 *  (`performance.timeOrigin`); a field is absent if its phase wasn't reached
 *  this session (e.g. `settled` on a session the user closed mid-sync). */
export interface StartupRecordData {
  /** Wall-clock epoch ms at which the record was written. */
  recordedAt: number
  /** Build id (`appVersion.display`) + short sha, so a regression can be tied
   *  to a deploy. */
  appVersion: string
  appSha: string
  /** Stable per-installation client id (see `@/utils/clientId`). Records are
   *  grouped under one block per client so a single browser/device's history is
   *  legible; the id rides the record too so it's self-describing. */
  clientId: string
  /** Coarse device/surface label for grouping ("installed:MacIntel"). */
  deviceLabel: string
  /** Boot start as epoch ms (`performance.timeOrigin`). */
  timeOriginMs: number
  repoReadyMs?: number
  workspaceResolvedMs?: number
  bootstrapDoneMs?: number
  /** First paint of the actual workspace layout — pixels appeared. NOT the
   *  same as interactive: the thread can be hammered right after paint. */
  firstContentPaintMs?: number
  syncedMs?: number
  drainedMs?: number
  /** Time to interactivity — boot contention stopped and the UI became usable
   *  (end of the last long task after first paint). The headline metric. */
  interactiveMs?: number
}

/** The whole record rides one identity-codec property (an engine-controlled
 *  blob), so the shape can evolve without per-field schema churn. A future
 *  trend view reads the child blocks and parses these — fine at this volume. */
export const startupRecordProp = seedProperty<StartupRecordData | undefined>({
  seedKey: 'system:startup-metrics/property/startup-record',
  revision: 1,
  name: 'startupRecord',
  preset: 'optional-json',
  defaultValue: undefined,
  // Automation scope (not UiState) so the record is VISIBLE in the property
  // panel — it renders raw (no editor for an object blob), so the metrics are
  // inspectable.
  changeScope: ChangeScope.Automation,
})

/** ~439 bytes each, so a far longer horizon costs little: about 1.3 years of
 *  boots for ~880KB per client group. */
export const STARTUP_RETAIN = 2000


/** The record blocks themselves. Typing the rows -- not just their container --
 *  is what lets them be found by typed query, audited and migrated instead of
 *  being inferred from tree position plus the presence of a property.
 *
 *  Records written before this type existed stay untagged, and nothing is
 *  backfilled: the readers of this series match on the container's children, so
 *  untyped history keeps working, and rewriting hundreds of historical rows to
 *  add a tag no reader requires would be a migration bought for nothing. */
export const startupRecordType = seedType({
  seedKey: 'system:startup-metrics/type/startup-record',
  revision: 1,
  id: 'startup-metrics-record',
  label: 'Startup metrics record',
  hideFromCompletion: true,
  // See the interaction record: the payload belongs to the type's contract.
  properties: [startupRecordProp],
})

/** Parent ui-state container; each boot adds one child under it. */
export const startupMetricsUIStateType = seedType({
  seedKey: 'system:startup-metrics/type/startup-metrics',
  revision: 1,
  id: 'startup-metrics',
  label: 'Startup metrics',
  // Plumbing for the # dropdown, but the chip is informative on the
  // record block itself.
  hideFromCompletion: true,
  properties: [],
})

/** Pure: fold the timeline + metadata into a storable record. */
export const buildStartupRecord = (
  timeline: StartupTimeline,
  meta: { recordedAt: number; appVersion: string; appSha: string; clientId: string; deviceLabel: string },
): StartupRecordData => {
  const { marks } = timeline
  return {
    recordedAt: meta.recordedAt,
    appVersion: meta.appVersion,
    appSha: meta.appSha,
    clientId: meta.clientId,
    deviceLabel: meta.deviceLabel,
    timeOriginMs: timeline.timeOriginMs,
    repoReadyMs: marks.repoReady,
    workspaceResolvedMs: marks.workspaceResolved,
    bootstrapDoneMs: marks.bootstrapDone,
    firstContentPaintMs: marks.firstContentPaint,
    syncedMs: marks.synced,
    drainedMs: marks.drained,
    interactiveMs: marks.interactive,
  }
}

/** Append one startup record as a fresh child block under this client's group
 *  block (one per browser/device installation) inside the per-user
 *  startup-metrics ui-state subtree. Returns the new block id. */
export const writeStartupRecord = async (repo: Repo, workspaceId: string): Promise<string | null> => {
  // Eligibility is owned by `sessionContext`, not re-derived here: the same
  // rules bind both recorders.
  if (!(await awaitRecordingAllowed(repo, workspaceId))) return null
  try {
    {
      const clientId = getClientId()
      const data = buildStartupRecord(getStartupTimeline(), {
        recordedAt: Date.now(),
        appVersion: appVersion.display,
        appSha: appVersion.sha,
        clientId,
        deviceLabel: getDeviceLabel(),
      })
      return (await appendClientRecord(repo, {
        workspaceId,
        containerType: startupMetricsUIStateType,
        recordType: startupRecordType,
        description: 'startup metrics record',
        retain: STARTUP_RETAIN,
        recordName: startupRecordProp.name,
        record: { property: startupRecordProp, data },
      })).blockId
    }
  } catch (err) {
    if (err instanceof NoLongerEligible) return null
    throw err
  }
}

// ──── collection effect ────

/** A main thread quiet for this long (no long task) after first paint is treated
 *  as "boot contention stopped" — the `interactive` mark lands at the end of the
 *  last long task before this window. */
const INTERACTIVE_QUIET_MS = 2_000

/** If `interactive` is never reached (sync never completes, thread never quiets),
 *  still persist what we have so the earlier marks aren't lost. */
export const SETTLE_FALLBACK_MS = 60_000

/** Attempts at the write itself, and the gap between them. A decline is
 *  expected while a fresh device waits for its membership row to replicate. */
const WRITE_ATTEMPTS = 3
export const WRITE_RETRY_MS = 30_000

// Once per page session: boot happens once, and the marks are boot-relative, so
// a later workspace switch must not record a second "startup".
let recorded = false
/** Test helper — re-arm the once-per-session guard. */
export const resetStartupMetricsRecorded = (): void => {
  recorded = false
  bootWrite = null
  resetPageOrigin()
}


/** The ONE write for this boot, whoever triggers it.
 *
 *  Retries live INSIDE it, so there is no second entry point for a superseded
 *  collector to race through. A restart overlaps two collectors, and what this
 *  replaces was each instance trying to notice the other — a check at the
 *  attempt, a check at the retry, and a pair of module flags between them, none
 *  of which a test could drive.
 *
 *  Teardown does NOT cancel it, deliberately. The boot happened; a toggle
 *  flipped mid-write does not un-happen it, and cancelling was only ever
 *  reachable through per-instance state that no longer exists. Teardown stops a
 *  collector LISTENING. */
let bootWrite: Promise<void> | null = null

const untilIdle = (): Promise<void> => new Promise((resolve) => { scheduleIdle(() => resolve()) })
const afterMs = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/** Attempts, in order, until one lands or they run out. A decline is transient
 *  — the membership role may not have replicated yet — and a rejection is no
 *  different, so both take the same path rather than one being logged and
 *  dropped. */
const attemptBootRecord = async (repo: Repo, workspaceId: string): Promise<void> => {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    if (attempt > 0) await afterMs(WRITE_RETRY_MS)
    // Deferred to idle so the bookkeeping never re-adds boot contention.
    await untilIdle()
    try {
      if (await writeStartupRecord(repo, workspaceId) !== null) {
        recorded = true
        return
      }
    } catch (err) {
      console.warn('[startup-metrics] failed to write record', err)
    }
  }
}

const writeBootRecord = (repo: Repo, workspaceId: string): Promise<void> => {
  bootWrite ??= attemptBootRecord(repo, workspaceId).finally(() => {
    // Out of attempts with nothing on disk: let a later collector try again,
    // which a restart could not otherwise do.
    if (!recorded) bootWrite = null
  })
  return bootWrite
}

/**
 * On first workspace open, detect time-to-interactivity and persist one record.
 *
 * The headline `interactive` mark is the end of the last long task after first
 * paint — i.e. when boot contention stopped and the UI became usable — found by
 * waiting for a sustained quiet window in the Long Tasks stream. (Without the
 * Long Tasks API we fall back to a single post-paint idle frame, a coarser
 * proxy.) `synced`/`drained` are captured alongside as warm-vs-cold diagnostics
 * (both ~immediate on a warm start; on a cold start the materialization long
 * tasks push `interactive` out on their own). The write itself is deferred to
 * idle so the bookkeeping never re-adds boot contention.
 */
export const collectStartupMetricsEffect: AppEffect = {
  id: 'startup-metrics.collect',
  start: ({ repo, workspaceId }) => {
    if (!workspaceId || recorded) return
    // The timeline is page-global and measures loading THAT graph, so only the
    // context the page started in may receive it. Both halves matter: a
    // workspace switch before the write lands would otherwise file these
    // timings as the new workspace's, and a local sign-out swaps the Repo
    // without a reload, so the next user opening the same shared workspace
    // would receive the previous user's boot.
    //
    // Read from `pageOrigin`, never claimed here: this effect is behind a
    // toggle, so claiming would make the workspace it was ENABLED in the
    // origin. Declining is the safe direction — one boot unrecorded, against a
    // permanently skewed series.
    const origin = pageOrigin(repo, workspaceId)
    if (origin.repo !== repo || origin.workspaceId !== workspaceId) return
    let done = false
    const cleanups: Array<() => void> = []
    const runCleanups = () => { for (const c of cleanups.splice(0)) c() }

    const record = () => {
      if (done) return
      done = true
      runCleanups()
      // One owner, so a second collector arriving here joins the write rather
      // than starting one: two instances cannot produce two records.
      void writeBootRecord(repo, workspaceId)
    }

    const fallback = setTimeout(record, SETTLE_FALLBACK_MS)
    cleanups.push(() => clearTimeout(fallback))

    // Diagnostics — sync complete + materialization caught up. Don't gate the
    // record: warm starts hit both ~instantly; cold starts surface their cost
    // through `interactive` (materialization long tasks) regardless.
    cleanups.push(onFirstSync(repo.db as unknown as SyncStatusDb, () => {
      if (done) return
      markStartup('synced')
      // A drain that FAILS now rejects the barrier rather than resolving over
      // its own failure; there is no 'drained' mark to make in that case, and
      // the observer has already reported it.
      void repo.flushSyncObserver()
        .then(() => { if (!done) markStartup('drained') })
        .catch(() => {})
    }))

    // Headline TTI — the boot contention stopping: a sustained quiet window (no
    // long task for INTERACTIVE_QUIET_MS) after first paint. The window is
    // DEBOUNCED off the long-task stream (reset on each task via onLongTask),
    // not polled — so the quiet timer always resets from the same event that
    // advances the last-long-task time, with no poll-vs-observer stale read.
    let paintTimer: ReturnType<typeof setTimeout> | undefined
    let quietTimer: ReturnType<typeof setTimeout> | undefined
    cleanups.push(() => {
      if (paintTimer) clearTimeout(paintTimer)
      if (quietTimer) clearTimeout(quietTimer)
    })

    const acceptInteractive = () => {
      if (done) return
      const fcp = getStartupTimeline().marks.firstContentPaint ?? 0
      // The instant it became usable (end of the last long task), not "now".
      markStartupAt('interactive', Math.max(getLastLongTaskEndMs() ?? 0, fcp))
      record()
    }
    const armQuietTimer = () => {
      if (done) return
      if (quietTimer) clearTimeout(quietTimer)
      quietTimer = setTimeout(acceptInteractive, INTERACTIVE_QUIET_MS)
    }
    const waitForPaint = () => {
      paintTimer = undefined
      if (done) return
      if (!hasStartupMark('firstContentPaint')) {
        paintTimer = setTimeout(waitForPaint, 250) // not painted yet — re-poll
        return
      }
      if (!longTasksSupported()) {
        // No Long Tasks API (Safari/test): coarse proxy — one idle frame after
        // paint, via the shared scheduleIdle. The `done` guard makes a disposer
        // unnecessary (a post-teardown callback no-ops).
        scheduleIdle(() => {
          if (done) return
          markStartup('interactive')
          record()
        })
        return
      }
      cleanups.push(onLongTask(armQuietTimer))
      armQuietTimer()
    }
    waitForPaint()

    // Stops this collector LISTENING, and nothing more. A write already
    // triggered belongs to the boot rather than to any instance, and runs to
    // completion — see `writeBootRecord`.
    return () => { done = true; runCleanups() }
  },
}
