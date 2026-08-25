/**
 * Interaction-metrics persistence: fold a `repo.metrics()` snapshot into a
 * durable per-session record, stored as a block-per-session under a hidden
 * per-user ui-state subtree — the same storage shape (and for the same
 * conflict-freedom reason) as `src/plugins/startup-metrics/record.ts`.
 *
 * Why this exists: `repo.metrics()` already measures everything here, on every
 * run. What it does not do is survive a reload, so a regression is only ever
 * visible to whoever happens to be looking at a live tab. Two real regressions
 * shipped in one week under exactly that blind spot (#818). This is the "keep
 * the series so the trend is checkable" half; `@/plugins/perf-monitor` is the
 * half that reads it.
 *
 * The recorder adds NO measurement of its own — it snapshots counters the data
 * layer maintains regardless. Its only runtime cost is one snapshot + one small
 * write per sample, and sampling is gated on genuine idle (see `schedule.ts`).
 */

import { ChangeScope, seedProperty, seedType } from '@/data/api'
import type { Repo } from '@/data/repo'
import { getPluginUIStateBlock, getPluginUIStateChild } from '@/data/stateBlocks.js'
import { keyAtStart } from '@/data/orderKey.js'
import { appVersion } from '@/appVersion.js'
import { getClientId, getDeviceLabel } from '@/utils/clientId.js'
import {
  awaitRecordingAllowed,
  clearPageRecord,
  metricsSessionContext,
  noteOwnWrites,
  observeWorkspace,
  pageRecordStartedAt,
  setPageRecord,
} from './sessionContext.js'
import { v4 as uuidv4 } from 'uuid'

/** Safety valve on the stored query set, NOT a policy about which queries
 *  matter. Every measured query is kept, because ranking by cost and truncating
 *  hides precisely the transition worth catching: a query that was cheap has no
 *  stored baseline, so when it becomes expensive the comparison sees a name it
 *  has never met and treats it as a newly mounted surface rather than a
 *  regression. A real session measures ~13 queries in ~3KB, so this bound only
 *  exists so a pathological future cannot grow the record without limit. */
const MAX_QUERIES = 64

/** Fat-handle outliers retained. Mirrors `handleStoreInventory.topHeavy`, which
 *  is already capped upstream; re-stated here so the record's own bound is
 *  visible at the shape. */
const TOP_HEAVY = 5

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
  /** `db.writeTransaction.calls`: writes this session. The denominator that
   *  turns a raw resolve count into resolves-per-write, which is the signal
   *  that catches an over-broad invalidation dep (a query re-resolving on every
   *  write instead of on writes that concern it). Latency metrics are blind to
   *  that class -- each resolve looks perfectly normal. */
  writes: number
  /** Per-query resolve timings for every query this session measured, keyed by
   *  query NAME (`repo.metrics().queries` is already name-keyed, not
   *  handle-keyed). Bounded only by `MAX_QUERIES`. */
  queries: Record<string, TimingSample>
  /** `handleStore` fan-out counters -- invalidations, handlesWalked/Matched,
   *  loaderRuns, midLoadInvalidations, reloadsAfterSettle. A flat number map,
   *  stored whole: it is bounded, and which counter matters depends on the
   *  regression being chased. */
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
  /** Per-DB-method timings (`getAll`, `execute`, `writeTransaction`, …). */
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
 *  `startupRecord`. */
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
  properties: [],
})

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
 * Recover the query name from a HandleStore key.
 *
 * A query handle is keyed `query:<name>@<registryEpoch>` plus, when the query
 * takes arguments, `:<serialized args>` — and the serialization always starts
 * with `[`, so the first `:[` in a key is its args boundary.
 *
 * The args split is a PRIVACY boundary, not a cosmetic one: args carry block
 * ids and raw search text (quick-find keys on the typed query), and this record
 * is a synced block that a human or agent may paste into an issue. It fails
 * SAFE — any name that did contain `:[` would truncate EARLIER, never later, so
 * no argument content can survive it whatever the name looks like, and neither
 * of the two cosmetic trims below can lengthen the result.
 *
 * The epoch has to go for a different reason: a registry swap bumps it, so
 * leaving it in would file the same query under a new name mid-session and
 * silently break the grouping a trend depends on.
 */
export const queryNameFromHandleKey = (key: string): string =>
  key.split(':[')[0].replace(/^query:/, '').replace(/@\d+$/, '')

/** Pure: the comparable subset of a metrics snapshot. Shared by the stored
 *  record and by the monitor's live reading of the current session, so the two
 *  can never diverge in what "the same measurement" means. */
export const interactionComparable = (
  metrics: ReturnType<Repo['metrics']>,
  /** Transactions the recorder issued itself, discounted from `writes`.
   *
   *  A monitor must not measure its own bookkeeping. `writes` is the
   *  DENOMINATOR of the fan-out ratio, so counting the recorder's own
   *  transactions deflates it — the direction that hides regressions rather
   *  than inventing them. The numerator needs no matching correction: nothing
   *  subscribes to the hidden ui-state blocks these writes touch, so they
   *  invalidate no handles. */
  ownWrites = 0,
): InteractionComparable => {
  const queries: Record<string, TimingSample> = {}
  for (const [name, timing] of Object.entries(metrics.queries)
    .sort(([, a], [, b]) => b.totalMs - a.totalMs)
    .slice(0, MAX_QUERIES)) {
    queries[name] = toTimingSample(timing)
  }
  return {
    writes: Math.max(0, (metrics.db.writeTransaction?.calls ?? 0) - ownWrites),
    queries,
    fanout: { ...metrics.handleStore },
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
    ownWrites: number
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
    ...interactionComparable(metrics, meta.ownWrites),
    db,
    handles: {
      count: inventory.handleCount,
      totalDeps: inventory.totalDeps,
      maxDeps: inventory.maxDeps,
      p50Deps: inventory.p50Deps,
      p95Deps: inventory.p95Deps,
      topHeavy: inventory.topHeavy.slice(0, TOP_HEAVY).map((h) => ({
        query: queryNameFromHandleKey(h.key),
        depCount: h.depCount,
      })),
    },
  }
}

// ──── per-session write ────

/** Session-scoped facts (identity, attributability, own writes, the record this
 *  session owns) live in `./sessionContext`; this module asks rather than
 *  deciding. See that module for why. */

const countLiveBlocksImpl = async (repo: Repo, workspaceId: string): Promise<number> => {
  const row = await repo.db.getOptional<{ n: number }>(
    'SELECT COUNT(*) AS n FROM blocks WHERE workspace_id = ? AND deleted = 0',
    [workspaceId],
  )
  return row?.n ?? 0
}

/** Live blocks in a workspace. Shared with the monitor, which pairs it with a
 *  LIVE `repo.metrics()` snapshot and so needs the same measurement, not the
 *  size recorded by some earlier session. Measured at ~15ms on a 327k-block
 *  graph — affordable for an idle-gated caller, not for a hot path. */
export const countLiveBlocks = countLiveBlocksImpl

const isLive = async (repo: Repo, blockId: string): Promise<boolean> => {
  const row = await repo.db.getOptional<{ id: string }>(
    'SELECT id FROM blocks WHERE id = ? AND deleted = 0',
    [blockId],
  )
  return Boolean(row)
}

/** Everything the recorders' own transactions must be measured around — see
 *  `noteOwnWrites`. Returns whatever `body` returns. */
const countingOwnWrites = async <T>(repo: Repo, body: () => Promise<T>): Promise<T> => {
  const before = repo.metrics().db.writeTransaction.calls
  try {
    return await body()
  } finally {
    noteOwnWrites(repo.metrics().db.writeTransaction.calls - before)
  }
}

/** Records kept per client group. The reader never looks past this many, and
 *  nothing else prunes: a session-per-row series replicated to every device
 *  otherwise grows for the life of the graph. Only THIS client's own group is
 *  touched, so two devices can never fight over the same rows. */
const RETAIN_RECORDS = 60

const pruneOwnGroup = async (repo: Repo, groupId: string, keepId: string): Promise<void> => {
  const stale = await repo.db.getAll<{ id: string }>(
    `SELECT id FROM blocks
      WHERE parent_id = ? AND deleted = 0 AND id != ?
      ORDER BY order_key
      LIMIT -1 OFFSET ?`,
    [groupId, keepId, RETAIN_RECORDS],
  )
  if (stale.length === 0) return
  await repo.tx(async (tx) => {
    // Retention of this client's own telemetry rows in a hidden ui-state
    // subtree: no user gesture, no user-visible block, so the deletion guards —
    // which exist to protect user-authored content — have nothing to say here.
    for (const row of stale) {
      // eslint-disable-next-line no-restricted-syntax -- programmatic delete: telemetry retention
      await tx.delete(row.id)
    }
  }, { scope: ChangeScope.Automation, description: 'interaction metrics record' })
}

/** Thrown to roll back a record write whose eligibility lapsed mid-transaction. */
class NoLongerEligible extends Error {}

/** Re-read eligibility INSIDE the writing transaction. The checks before it
 *  are separated from the commit by several awaits — a workspace switch or a
 *  role resolving to viewer lands in that window, and an Automation-scope write
 *  is admitted locally regardless, so the refusal has to be re-taken where the
 *  write actually happens. */
const assertStillEligible = (repo: Repo, workspaceId: string): void => {
  const now = metricsSessionContext(repo, workspaceId)
  if (!now.canRecord || !now.attributable) throw new NoLongerEligible()
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
  observeWorkspace(workspaceId)
  const context = metricsSessionContext(repo, workspaceId)
  if (!context.attributable) return null
  if (!(await awaitRecordingAllowed(repo, workspaceId))) return null

  // Snapshot BEFORE any of this sample's own setup work, so a first sample does
  // not report the transactions that created its own record block.
  const metrics = repo.metrics()
  // The record can be deleted from another device, or by a user browsing the
  // metrics tree. Writing a property to a tombstone does not restore it, so
  // without this the session would keep updating a row no reader can see.
  const existing =
    context.recordId && (await isLive(repo, context.recordId))
      ? { blockId: context.recordId, startedAt: pageRecordStartedAt(workspaceId)! }
      : null
  if (!existing) clearPageRecord()

  const startedAt = existing?.startedAt ?? Date.now() - performance.now()
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
    ownWrites: context.ownWrites,
  })

  try {
    return await countingOwnWrites(repo, async () => {
      if (existing) {
        await repo.tx(async (tx) => {
          assertStillEligible(repo, workspaceId)
          // `skipMetadata`: a metrics sample is bookkeeping, not user intent.
          // Without it every resample stamps `user_updated_at`, and the block-ref
          // picker orders by exactly that — so a hidden ISO-timestamp block would
          // hold the top of the (( completion list on any five-minute pause.
          await tx.setProperty(existing.blockId, interactionRecordProp, data, { skipMetadata: true })
        }, { scope: ChangeScope.Automation, description: 'interaction metrics record' })
        return existing.blockId
      }

      const root = await getPluginUIStateBlock(repo, workspaceId, repo.user, interactionMetricsUIStateType)
      const clientId = getClientId()
      const group = await getPluginUIStateChild(root, clientId, `${getDeviceLabel()} · ${clientId.slice(0, 8)}`)
      const blockId = uuidv4()
      // Newest-first within the client's group, matching startup-metrics.
      const first = await repo.db.getOptional<{ order_key: string }>(
        'SELECT order_key FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key LIMIT 1',
        [group.id],
      )
      // Create, type-tag and populate in ONE transaction. Split across two, a
      // failure or a closed page between them leaves a durable typed child with
      // no record on it — and the reader applies its row limit before skipping
      // such children, so they crowd real history out of the baseline.
      await repo.tx(async (tx) => {
        assertStillEligible(repo, workspaceId)
        await tx.create(
          {
            id: blockId,
            workspaceId,
            parentId: group.id,
            orderKey: keyAtStart(first?.order_key ?? null),
            content: new Date(startedAt).toISOString(),
            properties: {},
          },
          { systemMint: true },
        )
        await repo.addTypeInTx(tx, blockId, interactionRecordType.id, {})
        await tx.setProperty(blockId, interactionRecordProp, data, { skipMetadata: true })
      }, { scope: ChangeScope.Automation, description: 'interaction metrics record' })
      setPageRecord(workspaceId, blockId, startedAt)
      await pruneOwnGroup(repo, group.id, blockId)
      return blockId
    })
  } catch (err) {
    if (err instanceof NoLongerEligible) return null
    throw err
  }
}
