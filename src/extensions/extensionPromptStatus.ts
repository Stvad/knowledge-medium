/**
 * Routes "extensions need enabling / have updates" onto the shared
 * diagnostics seam, so the status chip shows an always-there "Review" row in
 * the dropdown whenever prompts are pending. Pairs with the per-extension
 * toasts in `extensionPromptMount.tsx`.
 *
 * Dismiss model (design C): the row lists ALL pending extensions — including
 * ones whose loud toast the user dismissed — so a dismissed prompt stays a
 * discoverable breadcrumb. But the ambient NUDGE dot only lights while at
 * least one prompt is still non-dismissed; dismissing the last one silences
 * the toast AND the dot, leaving just the quiet row. (Contrast the app-build
 * update, which always nudges — an extension prompt is dismissible.)
 *
 * The "Review" action reuses the existing `open_extensions_settings` global
 * action (the chip's dropdown button runs it via `runActionById`), landing
 * the user on the Extensions settings page where each pending extension has
 * its own per-row Enable/Update button.
 *
 * The derived snapshot is memoized (see below) to stay referentially stable
 * (a `useDiagnostics`/`useSyncExternalStore` need).
 */
import {OPEN_EXTENSIONS_SETTINGS_ACTION_ID} from '@/plugins/extensions-settings/actions.js'
import {
  diagnosticsFacet,
  type DiagnosticSnapshot,
  type DiagnosticSourceContribution,
} from '@/plugins/diagnostics/facet.js'
import {
  extensionPromptStore,
  type PendingExtensionPrompt,
} from './extensionPromptStore.js'

const buildSnapshot = (
  prompts: readonly PendingExtensionPrompt[],
): DiagnosticSnapshot | null => {
  if (prompts.length === 0) return null
  const summary =
    prompts.length === 1
      ? 'An extension needs review'
      : `${prompts.length} extensions need review`
  return {
    severity: 'info',
    summary,
    actionId: OPEN_EXTENSIONS_SETTINGS_ACTION_ID,
    actionLabel: 'Review',
    // Nudge (ambient dot) only while something still hasn't been dismissed —
    // a fully-dismissed set stays a quiet dropdown row without the dot.
    nudge: prompts.some((p) => !p.dismissed),
  }
}

// Memoize the derived snapshot so getSnapshot returns a stable ref while the
// pending set is unchanged (the derived DiagnosticSnapshot is a fresh object
// each build). The store already dedupes by content and returns a stable
// array ref while unchanged, so caching against that ref is sufficient — no
// content signature needed.
let cached:
  | {prompts: readonly PendingExtensionPrompt[]; snapshot: DiagnosticSnapshot | null}
  | null = null

export const extensionPromptDiagnosticSource: DiagnosticSourceContribution = {
  id: 'extension-prompts',
  label: 'Extensions',
  subscribe: extensionPromptStore.subscribe,
  getSnapshot: () => {
    const prompts = extensionPromptStore.getSnapshot()
    if (!cached || cached.prompts !== prompts) {
      cached = {prompts, snapshot: buildSnapshot(prompts)}
    }
    return cached.snapshot
  },
}

export const extensionPromptDiagnosticContribution = diagnosticsFacet.of(
  extensionPromptDiagnosticSource,
  {source: 'extension-prompts'},
)
