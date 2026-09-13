import { once } from 'lodash-es'

/**
 * The dynamic-extension Tailwind safelist (`extension-utilities.css`), loaded
 * on demand rather than in the critical stylesheet: extensions are its only
 * consumer and cannot render before the DB opens. Vite emits a dynamic CSS
 * import as its own stylesheet and injects a `<link>` at call time. `once`
 * so a failed load is not retried per call: the promise stays rejected and
 * the runtime apply's bounded wait moves on without it.
 */
export const ensureExtensionUtilitiesCss = once((): Promise<unknown> =>
  import('../extension-utilities.css'),
)
