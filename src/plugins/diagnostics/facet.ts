/**
 * The diagnostics seam — a generic way for plugins to surface a health signal
 * into a shared indicator (today the status chip), instead of each one
 * wiring a bespoke store + chip coupling (the pre-seam shape the consistency
 * audit had).
 *
 * Deliberately NOT in core: the only thing core truly owns is the indicator
 * surface itself; the diagnostics concept lives in the plugin layer, so the
 * facet is defined here and plugins contribute to it (and read it) by importing
 * this module. A contribution is a small live store — `{subscribe, getSnapshot}`
 * — because health is a changing signal; the aggregating chip does one
 * `useSyncExternalStore` per source via `useDiagnostics`.
 */
import { keyedMapFacet } from '@/facets/facet.js'

export type DiagnosticSeverity = 'ok' | 'info' | 'warning' | 'error'

/** Order used to pick the worst severity across all contributed sources. */
export const SEVERITY_RANK: Record<DiagnosticSeverity, number> = {
  ok: 0,
  info: 1,
  warning: 2,
  error: 3,
}

export const worstSeverity = (
  severities: readonly DiagnosticSeverity[],
): DiagnosticSeverity =>
  severities.reduce<DiagnosticSeverity>(
    (worst, s) => (SEVERITY_RANK[s] > SEVERITY_RANK[worst] ? s : worst),
    'ok',
  )

/** The current health of one diagnostic source. */
export interface DiagnosticSnapshot {
  severity: DiagnosticSeverity
  /** One-line status, e.g. "2 issues found" / "All checks passed". */
  summary: string
  /** Optional richer line for the indicator dropdown. */
  detail?: string
  /** Optional global action id to run/inspect this diagnostic (e.g. open its
   *  dialog). The indicator renders a button that `runActionById`s it. */
  actionId?: string
  /** Label for that button. Defaults to "Inspect"; a source whose action is a
   *  fix rather than an inspection overrides it (e.g. "Reload", "Enable"). */
  actionLabel?: string
  /** Opt in to an ambient dot on the shared indicator (a quiet "look here"
   *  cue, like the app-update badge). Use for an actionable nudge the user
   *  should notice; leave off for a benign baseline that should stay in the
   *  dropdown only (e.g. a sub-threshold finding). An `error` severity reddens
   *  the whole chip regardless, so it doesn't need this. */
  nudge?: boolean
}

/** A plugin's contribution to the diagnostics seam — a live store of its health.
 *  The contribution object is stable; its snapshot changes over time. */
export interface DiagnosticSourceContribution {
  /** Stable id (also the facet map key). */
  id: string
  /** Human label shown in the indicator, e.g. "Data integrity". */
  label: string
  subscribe: (listener: () => void) => () => void
  /** Current snapshot, or null when this source has nothing to report yet.
   *  MUST return a referentially-stable value while unchanged (it feeds
   *  `useSyncExternalStore`). */
  getSnapshot: () => DiagnosticSnapshot | null
}

export const diagnosticsFacet = keyedMapFacet<DiagnosticSourceContribution>(
  'diagnostics.sources',
  (c) => c.id,
)
