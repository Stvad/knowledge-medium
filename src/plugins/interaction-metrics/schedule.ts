/**
 * Sampling cadence for the interaction record.
 *
 * Runs on genuine idle only, behind a wall-clock floor — the tier the
 * consistency audit uses, so a sample can never land in the
 * time-to-interactivity window. A session where the user never goes idle
 * records nothing, and that is the correct trade for a monitor that must not
 * cost the thing it monitors.
 */
import { appEffectsFacet, type AppEffect } from '@/extensions/core.js'
import { LAZY_DEEP_IDLE } from '@/utils/scheduleIdle.js'
import { cadencedIdleJob } from '@/utils/cadencedIdleJob.js'
import { metricsSessionContext, observeWorkspace } from './sessionContext.js'
import { writeInteractionSample } from './record.js'

/** Wall clock between samples. Each rewrites one small block, so this trades
 *  series resolution against write volume: a record is only ever read as its
 *  session's endpoint, and the intermediate samples exist so a session that
 *  ends abruptly still leaves one. */
const RESAMPLE_MS = 5 * 60_000

const job = cadencedIdleJob({
  firstDelayMs: LAZY_DEEP_IDLE.minDelayMs,
  repeatDelayMs: RESAMPLE_MS,
  label: 'interaction-metrics',
})

/** Test helper — drain in-flight samples. */
export const drainInteractionSamples = (): Promise<void> => job.drain()

export const interactionMetricsEffect: AppEffect = {
  id: 'interaction-metrics.sample',
  start: ({ repo, workspaceId }) => {
    if (!workspaceId) return
    observeWorkspace(repo, workspaceId)
    // Asking the same context the write asks, one layer earlier: a client with
    // no durable identity can never accumulate readable history, and that is
    // fixed for the whole page session, so there is no point arming timers. The
    // read-only half is NOT decided here — it resolves asynchronously after
    // mount, so the write consults it again at the moment it matters.
    if (metricsSessionContext(repo, workspaceId).blockedBy === 'no-persistent-client') return
    return job.start(async () => { await writeInteractionSample(repo, workspaceId) })
  },
}

export const interactionMetricsEffectContribution = appEffectsFacet.of(
  interactionMetricsEffect,
  { source: 'interaction-metrics' },
)
