// Runtime gate for dev/test-only invariant assertions (L2 of the data-integrity
// defense — docs/data-integrity-defense.html). These verify derived-data
// contracts at the point of derivation (reprojection add-only; the
// references-processor reconcile contract) so a regression fails CI instead of
// silently corrupting data in the wild.
//
// Why a runtime flag instead of a build-time gate (import.meta.env.DEV /
// process.env.NODE_ENV): the modules that assert (repo.ts, referencesProcessor)
// compile and run in THREE contexts with different ambient types/globals — the
// Vite app, the agent-cli kernel (Node, no import.meta), and the kernel-types
// declaration build (neither Node nor Vite ambient types). No single build-time
// env global both type-checks and runs safely in all three. So env detection
// stays in the entrypoints that legitimately have it (the dev app bootstrap,
// gated on import.meta.env.DEV, and the vitest setup) and the kernel just reads
// a boolean. Default OFF ⇒ production pays a single boolean check per derivation,
// never the assertion body.
let enabled = false

/** True when L2 dev/test invariant assertions should run. */
export const devAssertionsEnabled = (): boolean => enabled

/** Enable/disable L2 assertions. Called by the dev app bootstrap (main.tsx,
 *  gated on import.meta.env.DEV) and the vitest setup; off everywhere else. */
export const setDevAssertionsEnabled = (value: boolean): void => {
  enabled = value
}
