/**
 * Interaction-metrics persistence: folds a `repo.metrics()` snapshot into a
 * durable per-session record, one block per session under a hidden per-user
 * ui-state subtree (so two devices never write the same row). Takes no
 * measurement of its own, so cost is one snapshot + write per sample, on
 * genuine idle (see `./schedule`). `@/plugins/perf-monitor` reads the series.
 */
import { ChangeScope, seedProperty, seedType } from '@/data/api'
import type { Repo } from '@/data/repo'
import { appVersion } from '@/appVersion.js'
import { getClientId, getDeviceLabel } from '@/utils/clientId.js'
import { appendClientRecord, clientGroupId, updateClientRecord } from './recordStore.js'
import {
  assertStillAttributable,
  awaitRecordingAllowed,
  clearPageRecord,
  NoLongerEligible,
  metricsSessionContext,
  observeWorkspace,
  pageRecordFor,
  readLiveSession,
  setPageRecord,
} from './sessionContext.js'

/** Safety valve, not policy — `interactionComparable` covers the selector
 *  itself. Only guards unbounded future growth; real sessions are nowhere near it. */
const MAX_QUERIES = 64

/** One timing distribution as stored (subset of `TimingSnapshot`). `p95Ms` is
 *  over the reservoir's last 256 samples, not the whole session — comparable
 *  window-to-window across sessions, but never "the session's p95" (`calls`/`totalMs` are lifetime). */
export interface TimingSample {
  calls: number
  p50Ms: number
  p95Ms: number
  totalMs: number
}

/** The subset of a sample a trend actually compares — split out so a live
 *  `repo.metrics()` snapshot can be compared to stored history without a write+readback round trip first. */
export interface InteractionComparable {
  /** `metrics().excludingTelemetry.writes`: denominator for resolves-per-write
   *  — the signal that catches an over-broad invalidation dep; latency metrics are blind to it. */
  writes: number
  /** Per-query resolve timings, keyed by query NAME. Bounded by `MAX_QUERIES`.
   *  PAGE TOTALS, unlike `writes`/`fanout` — includes loader reruns from the
   *  recorder's own writes, since the `telemetry` flag only covers a
   *  transaction's synchronous fan-out. ACCEPTED: noise on a busy session, but
   *  can dominate the idle sessions this recorder actually samples — read a
   *  low-`writes` session's p95 with that in mind. */
  queries: Record<string, TimingSample>
  /** `handleStore` fan-out counters attributable to a transaction's own
   *  invalidation walk (flat map, bounded). Settle-path counters
   *  (`notifiesFired`, `reloadsAfterSettle`) are ABSENT, not zero — bumped
   *  after the walk, outside any window a tx can claim; read a missing key as "not measured". */
  fanout: Record<string, number>
}

/** One persisted interaction sample: the data layer's own counters at a point in a page session. */
export interface InteractionRecordData extends InteractionComparable {
  /** Wall-clock epoch ms of this (possibly re-)write — advances as the session's record is updated in place. */
  recordedAt: number
  /** Wall-clock epoch ms at which the page session began. */
  startedAt: number
  appVersion: string
  appSha: string
  /** Stable per-installation id (see `@/utils/clientId`) — separates one device's history from the fleet's. */
  clientId: string
  deviceLabel: string
  /** Session wall-clock at sample time — a very short session's counters are dominated by boot; weight or floor on this. */
  sessionMs: number
  /** Live blocks in the workspace — the dominant confound for every timing below; without it a trend reads graph growth as a regression. */
  blockCount: number
  /** Per-DB-method timings (`getAll`, `execute`, `writeTransaction`, …).
   *  PAGE TOTALS like `queries`: `DbMetrics` times every call, so a prior
   *  sample's own lookups show up here too. ACCEPTED — `series.ts` never
   *  compares these (only `query:*`/`fanout:*`/`startup:*`), and every
   *  session pays the same handful of calls, so they wash out of later
   *  comparisons; expect a large share on a quiet session. */
  db: Record<string, TimingSample>
  handles: {
    count: number
    totalDeps: number
    maxDeps: number
    p50Deps: number
    p95Deps: number
    /** Resolvers registering the most deps, by query name. */
    topHeavy: Array<{ query: string; depCount: number }>
  }
}

/** One identity-codec property (engine-controlled blob), not per-field
 *  schema — same call as `startupRecord`. Deliberately ONE cell, against the
 *  record-grain rule's usual direction: the addressable unit is the session
 *  sample itself; nobody links to, undoes, or hand-edits one query's p95
 *  within it, which is the rule's own test. Exploding it would mint ~15
 *  child blocks per sample for no surface that addresses them individually. */
export const interactionRecordProp = seedProperty<InteractionRecordData | undefined>({
  seedKey: 'system:interaction-metrics/property/interaction-record',
  revision: 1,
  // Namespaced: property names share one workspace-wide namespace, so a flat
  // `interactionRecord` could collide with an extension's claim — free to fix now, but renaming after records persist orphans them.
  name: 'interaction-metrics:record',
  preset: 'optional-json',
  defaultValue: undefined,
  // Automation scope, like `startupRecord`: synced, non-undoable, but not in the property-panel hidden set — stays inspectable by hand.
  changeScope: ChangeScope.Automation,
})

/** The record blocks themselves — typing the rows, not just the container, lets them be found by typed query, audited, and migrated. */
export const interactionRecordType = seedType({
  seedKey: 'system:interaction-metrics/type/interaction-record',
  revision: 1,
  id: 'interaction-metrics-record',
  label: 'Interaction metrics record',
  hideFromCompletion: true,
  // The payload is part of the record's CONTRACT: declaring it means typed
  // schema/property tooling sees a field, not an unaccounted JSON blob.
  properties: [interactionRecordProp],
})

/** ~4 sessions/day at ~1.7KB each: about three months of history per client group. The reader never looks past 40. */
export const INTERACTION_RETAIN = 400

/** Parent ui-state container; each session adds one child under its client's group. */
export const interactionMetricsUIStateType = seedType({
  seedKey: 'system:interaction-metrics/type/interaction-metrics',
  revision: 1,
  id: 'interaction-metrics',
  label: 'Interaction metrics',
  hideFromCompletion: true,
  properties: [],
})

const round2 = (ms: number): number => Math.round(ms * 100) / 100

const toTimingSample = (t: {
  calls: number
  p50Ms: number
  p95Ms: number
  totalMs: number
}): TimingSample => ({
  calls: t.calls,
  p50Ms: round2(t.p50Ms),
  p95Ms: round2(t.p95Ms),
  totalMs: round2(t.totalMs),
})

/**
 * Recover the query name from a HandleStore key
 * (`query:<name>@<registryEpoch>[:<serialized args>]`). PRIVACY boundary:
 * args can carry block ids and raw search text, so stripping at `:[` fails
 * safe (truncates early, never late). Epoch is stripped too — a registry
 * swap would file the same query under a new name mid-session.
 */
export const queryNameFromHandleKey = (key: string): string =>
  key.split(':[')[0].replace(/^query:/, '').replace(/@\d+$/, '')

/** Pure: the comparable subset of a metrics snapshot, shared by the stored
 *  record and the monitor's live reading so the two can't diverge. */
export const interactionComparable = (
  metrics: ReturnType<Repo['metrics']>,
): InteractionComparable => {
  const queries: Record<string, TimingSample> = {}
  // Ordered by NAME, not cost: a cost-ranked truncation would drop exactly
  // the queries this catches — one that was cheap and became expensive has
  // no baseline, so a stable selector is what keeps history comparable.
  for (const [name, timing] of Object.entries(metrics.queries)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_QUERIES)) {
    queries[name] = toTimingSample(timing)
  }
  return {
    // `excludingTelemetry`, not page totals: the Repo already excludes the
    // recorder's own tx synchronously; a correction applied here can't be exact (the window spans this function's awaits).
    writes: metrics.excludingTelemetry.writes,
    queries,
    fanout: { ...metrics.excludingTelemetry.handleStore },
  }
}

/** Pure: fold a metrics snapshot + session metadata into a storable record. */
export const buildInteractionRecord = (
  metrics: ReturnType<Repo['metrics']>,
  meta: {
    recordedAt: number
    startedAt: number
    appVersion: string
    appSha: string
    clientId: string
    deviceLabel: string
    blockCount: number
  },
): InteractionRecordData => {
  const db: Record<string, TimingSample> = {}
  for (const [method, timing] of Object.entries(metrics.db)) {
    db[method] = toTimingSample(timing)
  }
  const inventory = metrics.handleStoreInventory
  return {
    recordedAt: meta.recordedAt,
    startedAt: meta.startedAt,
    appVersion: meta.appVersion,
    appSha: meta.appSha,
    clientId: meta.clientId,
    deviceLabel: meta.deviceLabel,
    sessionMs: meta.recordedAt - meta.startedAt,
    blockCount: meta.blockCount,
    ...interactionComparable(metrics),
    db,
    handles: {
      count: inventory.handleCount,
      totalDeps: inventory.totalDeps,
      maxDeps: inventory.maxDeps,
      p50Deps: inventory.p50Deps,
      p95Deps: inventory.p95Deps,
      topHeavy: inventory.topHeavy.map((h) => ({
        query: queryNameFromHandleKey(h.key),
        depCount: h.depCount,
      })),
    },
  }
}

// ──── per-session write ────

// Session-scoped facts (identity, attributability, the record owned) live in `./sessionContext`; this module asks rather than deciding.

/** Live blocks in a workspace. Shared with the monitor, which needs a LIVE
 *  measurement, not one from an earlier session — ~15ms, affordable idle-gated but not on a hot path. */
export const countLiveBlocks = async (repo: Repo, workspaceId: string): Promise<number> => {
  const row = await repo.db.getOptional<{ n: number }>(
    'SELECT COUNT(*) AS n FROM blocks WHERE workspace_id = ? AND deleted = 0',
    [workspaceId],
  )
  return row?.n ?? 0
}

/** Still OURS to write to: live, right parent, still carrying a record
 *  (retention's own three checks). A stripped record means a user
 *  repurposed the block — writing back would restore telemetry retention
 *  won't clean up; wrong parent means invisible to `loadRecords`.
 *
 *  `== null`, not `=== undefined`: clearing the property via its codec
 *  leaves JSON null in place, which `json_extract` reports as absent — same
 *  spelling retention handles. ONE predicate, asked twice (pre-check, then
 *  inside the writing tx) so the two answers cannot drift. */
const isUsableRow = (
  row: { deleted?: boolean; parentId: string | null; properties: Record<string, unknown> } | null,
  repo: Repo,
  workspaceId: string,
): boolean =>
  !!row && !row.deleted &&
  row.parentId === clientGroupId(repo, workspaceId, interactionMetricsUIStateType) &&
  row.properties[interactionRecordProp.name] != null

/** The pre-check, before any transaction. Selects raw fields for the shared
 *  predicate rather than asking SQL directly — a WHERE clause answering half of it is how these two drift. */
const isUsableRecord = async (
  repo: Repo,
  blockId: string,
  workspaceId: string,
): Promise<boolean> => {
  const row = await repo.db.getOptional<{ parent_id: string | null; properties_json: string }>(
    'SELECT parent_id, properties_json FROM blocks WHERE id = ? AND deleted = 0',
    [blockId],
  )
  return isUsableRow(
    !row ? null : {
      parentId: row.parent_id,
      properties: JSON.parse(row.properties_json ?? '{}') as Record<string, unknown>,
    },
    repo, workspaceId,
  )
}

/**
 * Sample `repo.metrics()` into this page session's record: creates the block
 * on first sample, updates it in place after. Returns the block id, or null
 * when this session may not be sampled. Update-in-place, not append-per-
 * sample — the series reads one point per session, and re-writing one block
 * costs a write where a growing append log would cost the graph.
 */
export const writeInteractionSample = async (
  repo: Repo,
  workspaceId: string,
): Promise<string | null> => {
  observeWorkspace(repo, workspaceId)
  const context = metricsSessionContext(repo, workspaceId)
  if (!context.attributable) return null
  if (!(await awaitRecordingAllowed(repo, workspaceId))) return null

  // Snapshot BEFORE this sample's own setup work, so it doesn't report the
  // transactions that create its own record block. Re-taken HERE, not reused
  // from the check above: another recorder can commit in the await between them.
  const { metrics } = readLiveSession(repo, workspaceId)
  // The record can be deleted elsewhere (another device, or a user browsing
  // the tree); writing to a tombstone doesn't restore it, so without this check the session updates a row nothing reads.
  const stored = pageRecordFor(repo, workspaceId)
  const existing =
    stored && (await isUsableRecord(repo, stored.blockId, workspaceId)) ? stored : null
  if (!existing) clearPageRecord(repo)

  // The SPAN's start, not the page's: after a `resetMetrics()` the page's
  // time origin would inflate `sessionMs` with work the counters beside it no longer count.
  const startedAt = existing?.startedAt ?? metrics.epochStartedAt
  const data = buildInteractionRecord(metrics, {
    recordedAt: Date.now(),
    startedAt,
    appVersion: appVersion.display,
    appSha: appVersion.sha,
    clientId: getClientId(),
    deviceLabel: getDeviceLabel(),
    // Re-counted per sample, not cached from session start: the dominant
    // confound for every timing here — a big import/sync would otherwise measure against the opening graph size.
    blockCount: await countLiveBlocks(repo, workspaceId),
  })

  try {
    {
      if (existing) {
        // Re-checked INSIDE the tx, not just before it: a sync or hand edit
        // landing in the block-count await between would write into a row
        // nothing reads. Refusing costs one sample; writing costs the session.
        await updateClientRecord(repo, {
          workspaceId,
          blockId: existing.blockId,
          containerType: interactionMetricsUIStateType,
          description: 'interaction metrics record',
          assertEligible: (r, ws) => assertStillAttributable(r, ws, metrics.epoch),
          isStillOurs: (row) => isUsableRow(row, repo, workspaceId),
          record: { property: interactionRecordProp, data },
        })
        return existing.blockId
      }

      const { blockId } = await appendClientRecord(repo, {
        workspaceId,
        containerType: interactionMetricsUIStateType,
        recordType: interactionRecordType,
        description: 'interaction metrics record',
        retain: INTERACTION_RETAIN,
        recordName: interactionRecordProp.name,
        // STRONGER than the shared default: a workspace switch during the
        // awaits above invalidates these counters — the shared path can't know that rule.
        assertEligible: (r, ws) => assertStillAttributable(r, ws, metrics.epoch),
        record: { property: interactionRecordProp, data },
        // Claimed at commit, not the return value: the append also awaits a
        // retention pass, and reading in that window would count this session twice.
        onCommitted: (id) => setPageRecord(repo, workspaceId, id, startedAt, metrics.epoch),
      })
      return blockId
    }
  } catch (err) {
    if (err instanceof NoLongerEligible) return null
    throw err
  }
}
