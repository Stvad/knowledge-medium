/**
 * Interaction-metrics persistence: fold a `repo.metrics()` snapshot into a
 * durable per-session record, stored as a block-per-session under a hidden
 * per-user ui-state subtree — block-per-session so two devices never write the
 * same row.
 *
 * The data layer already measures all of this on every run; what it does not do
 * is survive a reload, which is the whole of what this adds. The recorder takes
 * no measurement of its own: it snapshots counters that are maintained
 * regardless, so its only runtime cost is one snapshot and one small write per
 * sample, on genuine idle (see `./schedule`).
 *
 * `@/plugins/perf-monitor` is the half that reads the series.
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
  pageRecordStartedAt,
  readLiveSession,
  setPageRecord,
} from './sessionContext.js'

/** Safety valve on the stored query set, NOT a policy about which queries
 *  matter — `interactionComparable` says why the selector must not be cost. A
 *  real session measures ~13 queries in ~3KB, so this bound only exists so a
 *  pathological future cannot grow the record without limit. */
const MAX_QUERIES = 64

/** One timing distribution as stored. A subset of `TimingSnapshot` — the fields
 *  a trend can act on. `p95Ms` is over the reservoir's last 256 samples, NOT the
 *  whole session, so on a long session it describes recent behaviour; `calls`
 *  and `totalMs` are lifetime. Comparing p95 across sessions is therefore
 *  comparing recent-window to recent-window, which is what we want, but it is
 *  not "the session's p95" and must not be described as one. */
export interface TimingSample {
  calls: number
  p50Ms: number
  p95Ms: number
  totalMs: number
}

/** The subset of a sample a trend actually compares. Split out from the stored
 *  record so a live `repo.metrics()` snapshot can be compared against stored
 *  history WITHOUT first being written and read back — which would otherwise
 *  make the monitor's verdict depend on the recorder having sampled first. */
export interface InteractionComparable {
  /** `metrics().excludingTelemetry.writes`: row-changing, non-telemetry
   *  transactions this span. The denominator that turns a raw resolve count
   *  into resolves-per-write, which is the signal that catches an over-broad
   *  invalidation dep (a query re-resolving on every write instead of on writes
   *  that concern it). Latency metrics are blind to that class -- each resolve
   *  looks perfectly normal. */
  writes: number
  /** Per-query resolve timings for every query this session measured, keyed by
   *  query NAME (`repo.metrics().queries` is already name-keyed, not
   *  handle-keyed). Bounded only by `MAX_QUERIES`.
   *
   *  PAGE TOTALS, unlike `writes` and `fanout` beside them: these INCLUDE the
   *  loader reruns caused by the recorder's own writes. The `telemetry` flag
   *  covers a transaction and its synchronous fan-out counters, but a loader
   *  rerun happens in a later microtask and is timed unconditionally, with no
   *  provenance saying which transaction invalidated it.
   *
   *  ACCEPTED, with its shape stated because it is not uniform: against a busy
   *  session's thousands of resolutions, a couple of telemetry transactions per
   *  five minutes are noise. On a nearly IDLE session — which is when this
   *  recorder samples — they can be a large share of all query activity, so the
   *  p95 partly describes the app reacting to its own bookkeeping. Read a
   *  low-`writes` session's query timings with that in mind.
   *
   *  Excluding them needs the invalidating transaction's provenance carried to
   *  the asynchronous loader run it causes — HandleStore to dispatcher, in the
   *  hottest path in the app. Its own change, not a line here. */
  queries: Record<string, TimingSample>
  /** `handleStore` fan-out counters, restricted to what a transaction's own
   *  invalidation walk can attribute -- invalidations, handlesWalked/Matched,
   *  loaderInvalidations, midLoadInvalidations. A flat number map, stored
   *  whole: it is bounded, and which counter matters depends on the regression
   *  being chased. Settle-path counters (`notifiesFired`, `reloadsAfterSettle`)
   *  are ABSENT, not zero -- they are bumped after the walk, outside any
   *  window a tx can claim. Read a missing key as "not measured". */
  fanout: Record<string, number>
}

/** One persisted interaction sample: the state of the data layer's own counters
 *  at a point in a page session. */
export interface InteractionRecordData extends InteractionComparable {
  /** Wall-clock epoch ms of this (possibly re-)write. A session's record is
   *  updated in place as the session goes on, so this advances. */
  recordedAt: number
  /** Wall-clock epoch ms at which the page session began. */
  startedAt: number
  appVersion: string
  appSha: string
  /** Stable per-installation id (see `@/utils/clientId`), so one device's
   *  history is separable from the fleet's. */
  clientId: string
  deviceLabel: string
  /** Session wall-clock at sample time. A very short session's counters are
   *  dominated by boot, so a reader should weight or floor on this. */
  sessionMs: number
  /** Live blocks in the workspace. The dominant confound for every timing
   *  below — without it a trend reads graph growth as a regression. */
  blockCount: number
  /** Per-DB-method timings (`getAll`, `execute`, `writeTransaction`, …).
   *
   *  PAGE TOTALS, like `queries` and unlike `writes` and `fanout`: the
   *  `telemetry` flag keeps a transaction out of the write and fan-out counters,
   *  but `DbMetrics` times every call, so a session that took a previous sample
   *  has that sample's lookups, count, retention query and transaction in here.
   *  ACCEPTED, on two grounds. Nothing COMPARES these — `series.ts` derives
   *  regressions from `query:*`, `fanout:*` and `startup:*` only, so recorder
   *  calls in here cannot produce a verdict, false or otherwise; this is
   *  recorded for someone reading a session by hand. And every session pays the
   *  same handful of calls, so what they add sits on both sides of any
   *  comparison later made rather than skewing one. Judge a movement here
   *  accordingly on a quiet session, where they are a large share of a small
   *  denominator. */
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

/** The whole record rides one identity-codec property (an engine-controlled
 *  blob) so the shape can evolve without per-field schema churn — same call as
 *  `startupRecord`.
 *
 *  Deliberately ONE cell, against the record-grain rule's usual direction. The
 *  addressable record here is the session sample, and it IS a block: typed,
 *  queryable, auditable. What the cell holds is that one measurement's fixed
 *  field vector — nobody links to, undoes, or hand-edits the p95 of a single
 *  query in a single session, which is the rule's own test. Exploding it would
 *  mint ~15 child blocks per sample against a retention bound of thousands per
 *  device, all of them in the user's tree, to make individually addressable
 *  something no surface addresses. */
export const interactionRecordProp = seedProperty<InteractionRecordData | undefined>({
  seedKey: 'system:interaction-metrics/property/interaction-record',
  revision: 1,
  // Namespaced: property names share one workspace-wide schema namespace, so a
  // flat `interactionRecord` is a name an installed extension could plausibly
  // claim -- and the winner of that race decides the codec and scope these
  // records decode under. Free to fix now; after records persist under a name
  // it orphans them.
  name: 'interaction-metrics:record',
  preset: 'optional-json',
  defaultValue: undefined,
  // Automation scope, like `startupRecord`: synced and non-undoable, but NOT in
  // the property-panel hidden set, so the record stays inspectable by hand.
  changeScope: ChangeScope.Automation,
})

/** The record blocks themselves. Typing the rows -- not just their container --
 *  is what lets them be found by typed query, audited, and migrated, instead of
 *  being inferred from position in the tree plus the presence of a property. */
export const interactionRecordType = seedType({
  seedKey: 'system:interaction-metrics/type/interaction-record',
  revision: 1,
  id: 'interaction-metrics-record',
  label: 'Interaction metrics record',
  hideFromCompletion: true,
  // The payload is part of the record's CONTRACT, not an ad hoc cell: declaring
  // it means type-aware schema and property tooling sees a typed record with a
  // field rather than a JSON blob it has no account of.
  properties: [interactionRecordProp],
})

/** ~4 page sessions/day on an active device at ~1.7KB each: about three months
 *  of history for ~680KB per client group. The reader never looks past 40, so
 *  this is purely how far back an investigation can reach. */
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
 * (`query:<name>@<registryEpoch>` plus `:<serialized args>` when the query
 * takes them; the serialization always starts with `[`).
 *
 * The args split is a PRIVACY boundary: args carry block ids and raw search
 * text, and this record is a synced block someone may paste into an issue. It
 * fails SAFE — a name containing `:[` truncates EARLIER, never later, and
 * neither cosmetic trim can lengthen the result. The epoch has to go for a
 * different reason: a registry swap bumps it, which would file the same query
 * under a new name mid-session and break the grouping a trend depends on.
 */
export const queryNameFromHandleKey = (key: string): string =>
  key.split(':[')[0].replace(/^query:/, '').replace(/@\d+$/, '')

/** Pure: the comparable subset of a metrics snapshot. Shared by the stored
 *  record and by the monitor's live reading of the current session, so the two
 *  can never diverge in what "the same measurement" means. */
export const interactionComparable = (
  metrics: ReturnType<Repo['metrics']>,
): InteractionComparable => {
  const queries: Record<string, TimingSample> = {}
  // Ordered by NAME, not by cost. Truncating a cost-ranked list drops exactly
  // the queries this exists to catch: one that was cheap has no stored
  // baseline, so when it becomes expensive the comparison meets a name it has
  // never seen and reads it as a newly mounted surface rather than a
  // regression. A stable selector keeps the retained set the same session over
  // session, which is what makes the history comparable at all.
  for (const [name, timing] of Object.entries(metrics.queries)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_QUERIES)) {
    queries[name] = toTimingSample(timing)
  }
  return {
    // `excludingTelemetry`, not the page totals: the Repo counts the recorders'
    // own transactions on the other side of that line, in the same synchronous
    // block as the invalidation walk they cause. A correction applied out here
    // instead cannot be exact — the window would span this function's awaits.
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

// Session-scoped facts (identity, attributability, the record this session
// owns) live in `./sessionContext`; this module asks rather than deciding.

/** Live blocks in a workspace. Shared with the monitor, which pairs it with a
 *  LIVE `repo.metrics()` snapshot and so needs the same measurement, not the
 *  size recorded by some earlier session. ~15ms on a 327k-block graph:
 *  affordable for an idle-gated caller, not for a hot path. */
export const countLiveBlocks = async (repo: Repo, workspaceId: string): Promise<number> => {
  const row = await repo.db.getOptional<{ n: number }>(
    'SELECT COUNT(*) AS n FROM blocks WHERE workspace_id = ? AND deleted = 0',
    [workspaceId],
  )
  return row?.n ?? 0
}

/** Still OURS to write to: live, under the group the reader matches on, and
 *  still carrying a record.
 *
 *  All three, and the same three retention asks. A row whose record was
 *  stripped is user content by that rule — so accepting it would let the next
 *  sample write telemetry back onto a block a person had just repurposed, with
 *  retention then refusing to clean up what the recorder had restored. Placement
 *  matters for a different reason: a record moved elsewhere is invisible to
 *  `loadRecords`, so updating it writes the session where nothing reads.
 *
 *  `== null` rather than `=== undefined`: clearing the property through its
 *  codec leaves the key present holding JSON null, which `json_extract` reports
 *  as absent — the same spelling retention had to handle.
 *
 *  ONE predicate over a row shape both sources produce. It is asked twice — to
 *  decide whether a replacement is due, and again inside the writing
 *  transaction, which several awaits later is the only place the answer is
 *  still true — and the two must not be able to drift. */
const isUsableRow = (
  row: { deleted?: boolean; parentId: string | null; properties: Record<string, unknown> } | null,
  repo: Repo,
  workspaceId: string,
): boolean =>
  !!row && !row.deleted &&
  row.parentId === clientGroupId(repo, workspaceId, interactionMetricsUIStateType) &&
  row.properties[interactionRecordProp.name] != null

/** The pre-check, before any transaction. Selects the fields the predicate
 *  reads rather than asking SQL the question — `tx.get` cannot filter, so
 *  letting the WHERE clause answer half of it is what made these two drift. */
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
 * Sample `repo.metrics()` into this page session's record, creating the record
 * block on the first sample and UPDATING it in place afterwards. Returns the
 * record's block id, or null when this session is not one that may be sampled.
 *
 * Update-in-place rather than append-per-sample: the series a trend reads is
 * one point per session, and a mid-session sample is a strictly worse version
 * of the session's final one. Re-writing one small block costs a write; a
 * growing append log would cost the graph.
 */
export const writeInteractionSample = async (
  repo: Repo,
  workspaceId: string,
): Promise<string | null> => {
  observeWorkspace(repo, workspaceId)
  const context = metricsSessionContext(repo, workspaceId)
  if (!context.attributable) return null
  if (!(await awaitRecordingAllowed(repo, workspaceId))) return null

  // Snapshot BEFORE any of this sample's own setup work, so a first sample does
  // not report the transactions that created its own record block. Taken again
  // HERE rather than reused from the check above: the other recorder can commit
  // during the await between them, which the snapshot would then include and a
  // stale correction would fail to discount.
  const { metrics, session: current } = readLiveSession(repo, workspaceId)
  // The record can be deleted from another device, or by a user browsing the
  // metrics tree. Writing a property to a tombstone does not restore it, so
  // without this the session would keep updating a row no reader can see.
  const existing =
    current.recordId && (await isUsableRecord(repo, current.recordId, workspaceId))
      ? { blockId: current.recordId, startedAt: pageRecordStartedAt(repo, workspaceId)! }
      : null
  if (!existing) clearPageRecord(repo)

  // The SPAN's start, not the page's. `sessionMs` is derived from this and the
  // counters it sits beside cover one span, so after a `resetMetrics()` the
  // page's time origin would describe a window containing work the figures no
  // longer count — inflating the very denominator a reader is told to floor on.
  const startedAt = existing?.startedAt ?? metrics.epochStartedAt
  const data = buildInteractionRecord(metrics, {
    recordedAt: Date.now(),
    startedAt,
    appVersion: appVersion.display,
    appSha: appVersion.sha,
    clientId: getClientId(),
    deviceLabel: getDeviceLabel(),
    // Re-counted per sample rather than cached from session start: this is the
    // dominant confound for every timing in the record, and a session that
    // imports or syncs a lot of blocks would otherwise report the final
    // timings against the opening graph size.
    blockCount: await countLiveBlocks(repo, workspaceId),
  })

  try {
    {
      if (existing) {
        // Placement re-taken INSIDE the transaction, not just before it: the
        // pre-check is separated from this write by the block count, and a
        // sync-applied or hand edit landing in that window leaves us writing
        // this session into a row the reader can no longer find. Refusing costs
        // one sample — the next one finds the row unusable and opens a
        // replacement — while writing costs the session.
        await updateClientRecord(repo, {
          workspaceId,
          blockId: existing.blockId,
          description: 'interaction metrics record',
          assertEligible: (r, ws) => assertStillAttributable(r, ws, metrics.epoch),
          isStillOurs: (row) => isUsableRow(row, repo, workspaceId),
          // `skipMetadata`: a metrics sample is bookkeeping, not user intent.
          // Without it every resample stamps `user_updated_at`, and the
          // block-ref picker orders by exactly that — so a hidden ISO-timestamp
          // block would hold the top of the (( completion list on any
          // five-minute pause.
          setProperty: async (tx, id) => {
            await tx.setProperty(id, interactionRecordProp, data, { skipMetadata: true })
          },
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
        // STRONGER than the shared default: these counters are only meaningful
        // if they belong to one workspace, and a switch during the awaits above
        // invalidates them. The shared path cannot know that rule.
        assertEligible: (r, ws) => assertStillAttributable(r, ws, metrics.epoch),
        setProperty: async (tx, id) => {
          await tx.setProperty(id, interactionRecordProp, data, { skipMetadata: true })
        },
        // Claimed at commit, not from the return value: the append also awaits
        // a retention pass, and an analysis in that window would find the row
        // readable but unclaimed and count this session twice.
        onCommitted: (id) => setPageRecord(repo, workspaceId, id, startedAt, metrics.epoch),
      })
      return blockId
    }
  } catch (err) {
    if (err instanceof NoLongerEligible) return null
    throw err
  }
}
