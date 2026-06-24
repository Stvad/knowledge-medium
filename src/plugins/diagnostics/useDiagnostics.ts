import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import {
  diagnosticsFacet,
  worstSeverity,
  type DiagnosticSeverity,
  type DiagnosticSnapshot,
  type DiagnosticSourceContribution,
} from './facet.js'

export interface DiagnosticItem {
  id: string
  label: string
  snapshot: DiagnosticSnapshot
}

export interface DiagnosticsAggregate {
  /** Worst severity across all reporting sources ('ok' when none report). */
  worst: DiagnosticSeverity
  /** Sources that currently report a snapshot, in facet order. */
  items: DiagnosticItem[]
}

/** Pure aggregation — kept out of the hook so it can be unit-tested. Sources
 *  with a null snapshot (nothing to report) are dropped. */
export const aggregateDiagnostics = (
  sources: readonly DiagnosticSourceContribution[],
  snapshots: readonly (DiagnosticSnapshot | null)[],
): DiagnosticsAggregate => {
  const items: DiagnosticItem[] = []
  sources.forEach((source, i) => {
    const snapshot = snapshots[i]
    if (snapshot) items.push({ id: source.id, label: source.label, snapshot })
  })
  return { worst: worstSeverity(items.map((it) => it.snapshot.severity)), items }
}

/** Subscribe to every contributed diagnostic source and return the aggregate
 *  (worst severity + per-source snapshots). The chip uses this to drive the dot
 *  tone and list sources in its dropdown. */
export const useDiagnostics = (): DiagnosticsAggregate => {
  const runtime = useAppRuntime()
  // Static facet contributions are stable until the runtime rebuilds.
  const sources = useMemo(
    () => [...runtime.read(diagnosticsFacet).values()],
    [runtime],
  )
  // Cache the aggregate in a ref (the sanctioned mutable container) and recompute
  // only when a source's snapshot ref actually changes, so getSnapshot returns a
  // referentially-stable value between changes (required by useSyncExternalStore).
  const cacheRef = useRef<{
    snaps: (DiagnosticSnapshot | null)[]
    aggregate: DiagnosticsAggregate
  } | null>(null)
  const subscribe = useCallback(
    (listener: () => void): (() => void) => {
      const unsubs = sources.map((s) => s.subscribe(listener))
      return () => {
        for (const unsub of unsubs) unsub()
      }
    },
    [sources],
  )
  const getSnapshot = useCallback((): DiagnosticsAggregate => {
    const snaps = sources.map((s) => s.getSnapshot())
    const prev = cacheRef.current
    if (
      prev &&
      snaps.length === prev.snaps.length &&
      snaps.every((s, i) => s === prev.snaps[i])
    ) {
      return prev.aggregate
    }
    const aggregate = aggregateDiagnostics(sources, snaps)
    cacheRef.current = { snaps, aggregate }
    return aggregate
  }, [sources])
  return useSyncExternalStore(subscribe, getSnapshot)
}
