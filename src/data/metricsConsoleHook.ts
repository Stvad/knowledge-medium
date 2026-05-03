/**
 * Devtools-console hook for `repo.metrics()`. Mirrors the
 * `ensureRoamImportWindowHook` pattern — idempotent, hung off the
 * same `window.__omniliner` namespace.
 *
 * Quickest cold-start workflow:
 *
 *   __omniliner.metrics.reset()
 *   // do the thing (open page, type a keystroke, scroll, etc.)
 *   __omniliner.metrics.print()
 *
 * `print()` formats the snapshot as console.table groups so percentile
 * timings line up at a glance. `snapshot()` returns the raw frozen
 * object if you want to programmatically diff two captures.
 *
 * Also exposes the `Repo` instance directly as
 * `window.__omniliner.repo` so devtools-console one-liners
 * (`__omniliner.repo.handleStore.size()`) work without a hook.
 */

import { Repo } from './repo'

interface MetricsConsoleAPI {
  /** Raw frozen snapshot — same shape as `repo.metrics()`. */
  snapshot: () => ReturnType<Repo['metrics']>
  /** Zero every counter / reservoir. */
  reset: () => void
  /** Pretty-print to console.table. Splits into three groups:
   *  counters (handleStore + blockCache), per-query timings, per-DB
   *  method timings. */
  print: () => void
  /** Print only the per-query-name timings (no counters / DB). */
  printQueries: () => void
  /** Print only the per-DB-method timings. */
  printDb: () => void
}

// The `__omniliner` window slot is shared with `roamImport/runtime.ts`.
// Use `Window['__omniliner']` & {…extension…} via reading-then-writing
// at runtime (see `ensureMetricsConsoleHook` below) instead of trying
// to declaration-merge the interface (TS rejects mismatched per-file
// shapes for the same property; we'd need to keep both files in sync).
//
// At type level we cast the namespace to a wider shape inside the hook.
interface OmnilinerWindowExtension {
  metrics?: MetricsConsoleAPI
  repo?: Repo
}

let installed = false

const round = (n: number, decimals = 3): number =>
  Math.round(n * 10 ** decimals) / 10 ** decimals

const counterRows = (snap: ReturnType<Repo['metrics']>) => {
  const rows: Array<{section: string; field: string; value: number}> = []
  for (const [k, v] of Object.entries(snap.handleStore)) {
    rows.push({section: 'handleStore', field: k, value: v})
  }
  for (const [k, v] of Object.entries(snap.blockCache)) {
    rows.push({section: 'blockCache', field: k, value: v})
  }
  return rows
}

const timingRows = (snap: Record<string, ReturnType<Repo['metrics']>['db'][keyof ReturnType<Repo['metrics']>['db']]>, labelKey: string) => {
  // Build one row per timing entry. Sort by totalMs descending so the
  // worst offender shows up first — that's the first thing you want
  // to see during cold-start investigation.
  return Object.entries(snap)
    .map(([name, t]) => ({
      [labelKey]: name,
      calls: t.calls,
      meanMs: round(t.meanMs),
      p50Ms: round(t.p50Ms),
      p95Ms: round(t.p95Ms),
      p99Ms: round(t.p99Ms),
      maxMs: round(t.maxMs),
      totalMs: round(t.totalMs),
    }))
    .sort((a, b) => b.totalMs - a.totalMs)
}

export const ensureMetricsConsoleHook = (repo: Repo): void => {
  if (installed) return
  installed = true

  const api: MetricsConsoleAPI = {
    snapshot: () => repo.metrics(),
    reset: () => repo.resetMetrics(),
    print: () => {
      const snap = repo.metrics()
      console.groupCollapsed(
        '%crepo.metrics() — counters + timings',
        'font-weight:bold',
      )
      console.log('Counters:')
      console.table(counterRows(snap))
      console.log('Per-query resolve timings:')
      const qRows = timingRows(snap.queries, 'query')
      if (qRows.length === 0) {
        console.log('  (no queries dispatched yet)')
      } else {
        console.table(qRows)
      }
      console.log('Per-DB-method timings:')
      console.table(timingRows(snap.db, 'method'))
      console.groupEnd()
    },
    printQueries: () => {
      const rows = timingRows(repo.metrics().queries, 'query')
      if (rows.length === 0) {
        console.log('(no queries dispatched yet)')
        return
      }
      console.table(rows)
    },
    printDb: () => {
      console.table(timingRows(repo.metrics().db, 'method'))
    },
  }

  const ns = (window.__omniliner ?? {}) as Record<string, unknown> & OmnilinerWindowExtension
  ns.metrics = api
  ns.repo = repo
  window.__omniliner = ns as Window['__omniliner']

  // One-shot bootstrap log so the dev sees the API is live without
  // having to inspect the namespace.
  console.log(
    '%c[metrics] devtools console ready',
    'color:#0a8',
    '\n  __omniliner.metrics.print() — counters + per-query + per-DB timings',
    '\n  __omniliner.metrics.reset() — zero everything (mark a baseline)',
    '\n  __omniliner.metrics.snapshot() — raw frozen object',
    '\n  __omniliner.repo — the Repo instance itself',
  )
}
