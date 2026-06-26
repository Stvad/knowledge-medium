/**
 * Cadenced scheduling for the built-in consistency audit (L3), as a plugin
 * AppEffect — replacing the old Repo.scheduleConsistencyAudit idle job. The
 * engine + scheduling live here (not core) so the engine can import other
 * plugins' code (the deep checks in a later step) without inverting the layering.
 */
import { appEffectsFacet, type AppEffect } from '@/extensions/core.js'
import type { Repo } from '@/data/repo'
import { PendingIdleJobs } from '@/data/internals/idleMarkerJobs.js'
import { scheduleDeepIdle, LAZY_DEEP_IDLE } from '@/utils/scheduleIdle.js'
import { runConsistencyAudit, type ConsistencyAuditResult } from './audit.js'
import { publishConsistencyAudit } from './store.js'

const CADENCE_MS = 30 * 60 * 1000
// Debounce transient mid-sync divergence: a dirty divergence pass re-measures
// after this delay and reports the settled counts.
const DIVERGENCE_RECHECK_MS = 4000

// Per-session, in-memory: workspaceId → epoch ms of the last completed audit, so
// each page session runs once per workspace per cadence window and repopulates
// the diagnostics store. A fresh session starts empty (always runs once).
const lastRun = new Map<string, number>()
// Shared idle-job queue so tests can drain in-flight audits deterministically.
// The audit is the heaviest cold-start idle job (≈13 scan queries + bounded
// decrypt spot-checks) and a 30-min-cadence smoke alarm with no urgency, so it
// runs on GENUINE idle only (deep idle, no force-run fallback) — it must never
// land in the time-to-interactivity window, and skipping a never-idle session
// is fine.
const jobs = new PendingIdleJobs((fn) => scheduleDeepIdle(fn, LAZY_DEEP_IDLE))

/** True if the workspace is due for a cadenced audit (never run this session, or
 *  older than the cadence window). Exposed for tests. */
export const isAuditDue = (workspaceId: string, now: number): boolean => {
  const last = lastRun.get(workspaceId)
  return last === undefined || now - last >= CADENCE_MS
}

/** Run the audit now (bypassing the cadence gate), publish the result, and stamp
 *  the cadence. Used by both the on-demand action and the cadenced effect. Passes
 *  the §6 mode/key resolver so the divergence check can decrypt-compare e2ee
 *  rows. Throws on failure so callers can surface it. */
export const runConsistencyAuditNow = async (
  repo: Repo,
  workspaceId: string,
): Promise<ConsistencyAuditResult> => {
  const result = await runConsistencyAudit(repo.db, workspaceId, Date.now(), {
    divergenceRecheckMs: DIVERGENCE_RECHECK_MS,
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    // The observer's §6 resolver (real in production via repoProvider; undefined
    // in tests/plaintext Repos ⇒ the divergence spot-check runs cleartext-only).
    decrypt: repo.syncObserverDeps,
  })
  lastRun.set(workspaceId, Date.now())
  publishConsistencyAudit(result)
  return result
}

/** Long-lived effect: on each workspace open, schedule one cadenced audit on
 *  idle. The effect lifecycle restarts on workspaceId change, so `start` is the
 *  "workspace opened" hook. */
export const consistencyAuditEffect: AppEffect = {
  id: 'data-integrity.consistency-audit',
  start: ({ repo, workspaceId }) => {
    if (!workspaceId || !isAuditDue(workspaceId, Date.now())) return
    let cancelled = false
    jobs.schedule(async () => {
      // Re-check at run time: a rapid workspace re-open may have queued twice.
      if (cancelled || !isAuditDue(workspaceId, Date.now())) return
      try {
        await runConsistencyAuditNow(repo, workspaceId)
      } catch (err) {
        console.error(`[data-integrity] audit for workspace ${workspaceId} failed`, err)
      }
    })
    return () => {
      cancelled = true
    }
  },
}

export const consistencyAuditEffectContribution = appEffectsFacet.of(
  consistencyAuditEffect,
  { source: 'data-integrity' },
)

/** Test helper — drain in-flight cadenced audits. */
export const drainConsistencyAudits = (): Promise<void> => jobs.drain()

/** Test helper — clear the per-session cadence map. */
export const resetConsistencyAuditCadence = (): void => lastRun.clear()
