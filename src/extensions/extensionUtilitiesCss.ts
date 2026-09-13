import { once } from 'lodash-es'

/**
 * The dynamic-extension Tailwind safelist (`extension-utilities.css`), loaded
 * on demand rather than in the critical stylesheet: extensions are its only
 * consumer and cannot render before the DB opens, so it has no business
 * before first paint. Vite emits a dynamic CSS import as its own stylesheet
 * and injects a `<link>` at call time; `once` makes every later call a no-op.
 */
export const ensureExtensionUtilitiesCss = once((): Promise<unknown> =>
  import('../extension-utilities.css'),
)
