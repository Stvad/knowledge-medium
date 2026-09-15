import { once } from 'lodash-es'

/**
 * The dynamic-extension Tailwind safelist (`extension-utilities.css`), loaded
 * on demand rather than in the critical stylesheet: extensions are its only
 * consumer and cannot render before the DB opens. Vite emits a dynamic CSS
 * import as its own stylesheet and injects a `<link>` at call time. Resolves
 * once the load has settled either way: a retry could not help (Vite's
 * preload helper never re-inserts a link it has seen), and callers only wait
 * for readiness, so a failed load must not reject the runtime apply.
 */
export const ensureExtensionUtilitiesCss = once((): Promise<void> =>
  import('../extension-utilities.css').then(() => undefined, () => undefined),
)
