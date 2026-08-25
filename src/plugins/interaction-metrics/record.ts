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
import { v4 as uuidv4 } from 'uuid'

/** Queries retained per record, ranked by `totalMs`. The tail of a session's
 *  query set is long and uninteresting; the cost that shows up in a trend is
 *  concentrated in the head. Bounds the stored payload to a predictable size. */
const TOP_QUERIES = 12

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
  /** Per-query resolve timings, top `TOP_QUERIES` by `totalMs`. Keyed by query
   *  NAME (`repo.metrics().queries` is already name-keyed, not handle-keyed). */
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
  name: 'interactionRecord',
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
): InteractionComparable => {
  const queries: Record<string, TimingSample> = {}
  for (const [name, timing] of Object.entries(metrics.queries)
    .sort(([, a], [, b]) => b.totalMs - a.totalMs)
    .slice(0, TOP_QUERIES)) {
    queries[name] = toTimingSample(timing)
  }
  return {
    writes: metrics.db.writeTransaction?.calls ?? 0,
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
      topHeavy: inventory.topHeavy.slice(0, TOP_HEAVY).map((h) => ({
        query: queryNameFromHandleKey(h.key),
        depCount: h.depCount,
      })),
    },
  }
}

// ──── per-session write ────

interface PageSession {
  blockId: string
  /** The workspace this page session's counters are attributable to. */
  workspaceId: string
  startedAt: number
}

/** ONE record per page session, not per workspace.
 *
 *  `repo.metrics()` counters are monotonic from Repo construction and are not
 *  segmented by workspace, so a second workspace opened in the same page
 *  session inherits the first one's queries and writes while reporting its own
 *  block count. Rather than pretend to attribute that, sampling STOPS: the
 *  record written while only one workspace had been seen stays correct, and no
 *  blended one is ever written. Losing the (rare) multi-workspace session beats
 *  poisoning the baseline every later comparison is measured against. */
let pageSession: PageSession | null = null
let unattributable = false

/** Test helper — forget this process's session so the next sample re-creates. */
export const resetInteractionSessions = (): void => {
  pageSession = null
  unattributable = false
}

const countLiveBlocks = async (repo: Repo, workspaceId: string): Promise<number> => {
  const row = await repo.db.getOptional<{ n: number }>(
    'SELECT COUNT(*) AS n FROM blocks WHERE workspace_id = ? AND deleted = 0',
    [workspaceId],
  )
  return row?.n ?? 0
}

const isLive = async (repo: Repo, blockId: string): Promise<boolean> => {
  const row = await repo.db.getOptional<{ id: string }>(
    'SELECT id FROM blocks WHERE id = ? AND deleted = 0',
    [blockId],
  )
  return Boolean(row)
}

const openSession = async (repo: Repo, workspaceId: string): Promise<PageSession> => {
  const root = await getPluginUIStateBlock(repo, workspaceId, repo.user, interactionMetricsUIStateType)
  const clientId = getClientId()
  const group = await getPluginUIStateChild(root, clientId, `${getDeviceLabel()} · ${clientId.slice(0, 8)}`)
  const blockId = uuidv4()
  const startedAt = Date.now() - performance.now()
  // Newest-first within the client's group, matching startup-metrics.
  const first = await repo.db.getOptional<{ order_key: string }>(
    'SELECT order_key FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key LIMIT 1',
    [group.id],
  )
  await repo.tx(async (tx) => {
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
    // Same tx as the create, so a record is never briefly untyped.
    await repo.addTypeInTx(tx, blockId, interactionRecordType.id, {})
  }, { scope: ChangeScope.Automation, description: 'interaction metrics record' })
  const session: PageSession = { blockId, workspaceId, startedAt }
  pageSession = session
  return session
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
  if (unattributable) return null
  // Checked HERE rather than at scheduling time: the workspace role resolves
  // asynchronously after mount, so a check when the effect starts can run
  // before `isReadOnly` is known. In a viewer workspace the Automation scope
  // admits this write locally and the server's RLS then refuses the upload,
  // parking it in the rejection quarantine -- which the status chip reports to
  // the user as changes that could not sync. A recurring sampler would keep
  // manufacturing those.
  if (repo.isReadOnly) return null
  if (pageSession && pageSession.workspaceId !== workspaceId) {
    unattributable = true
    return null
  }
  // The record can be deleted from another device, or by a user browsing the
  // metrics tree. Writing a property to a tombstone does not restore it, so
  // without this the session would keep updating a row no reader can see.
  const live = pageSession && (await isLive(repo, pageSession.blockId)) ? pageSession : null
  const session = live ?? (await openSession(repo, workspaceId))
  const data = buildInteractionRecord(repo.metrics(), {
    recordedAt: Date.now(),
    startedAt: session.startedAt,
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
  await repo.tx(async (tx) => {
    await tx.setProperty(session.blockId, interactionRecordProp, data)
  }, { scope: ChangeScope.Automation, description: 'interaction metrics record' })
  return session.blockId
}
