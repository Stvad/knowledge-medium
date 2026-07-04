/**
 * The pure string transform at the heart of scripts/inject-sw-build-id.ts:
 * stamp a built dist/sw.js with its build id + the two precache lists. Split out
 * from the orchestrator (which reads the fs, walks dist/, and exits the process)
 * so the load-bearing, MINIFICATION-SENSITIVE substitution is unit-testable —
 * see stamp-sw-source.test.ts.
 *
 * Robust to minification by construction:
 *   - BUILD_ID is a bare token, replaced wherever it appears regardless of the
 *     quote style wrapping it.
 *   - Each precache list is injected by matching only its placeholder STRING
 *     LITERAL — accepting ', ", or a `…` template, since oxc minification rewrites
 *     quotes to backticks — and swapping the whole literal for a correctly-escaped
 *     JS string literal of the JSON payload, leaving `JSON.parse(…)` (however the
 *     minifier named that identifier) to parse it at runtime. Keying off the
 *     string CONTENTS (which a minifier can't alter) rather than the `JSON.parse`
 *     call is what survives both the quote rewrite and any identifier aliasing.
 *
 * Throws — so the build fails loudly instead of shipping a dead worker — if a
 * placeholder is missing, survives the stamp, or the result won't parse as JS.
 */
const PLACEHOLDERS = ['__BUILD_ID__', '__PRECACHE_ASSETS__', '__PRECACHE_REST_ASSETS__'] as const

export interface SwStampInput {
  /** Per-deploy id (git sha / dev fallback): hex/base36, no quotes/backticks/`${`. */
  buildId: string
  /** First-paint asset URLs (HTML-derived), base-prefixed. */
  firstPaintAssets: string[]
  /** The rest of the emitted graph, base-prefixed. */
  restAssets: string[]
}

export const stampSwSource = (
  source: string,
  {buildId, firstPaintAssets, restAssets}: SwStampInput,
): string => {
  if (!source.includes('__BUILD_ID__')) throw new Error('placeholder __BUILD_ID__ not found in sw.js')
  let out = source.split('__BUILD_ID__').join(buildId)

  const injectList = (placeholder: string, arr: string[]): void => {
    const lit = new RegExp(`(["'\`])${placeholder}\\1`)
    if (!lit.test(out)) throw new Error(`could not find placeholder string "${placeholder}" in sw.js`)
    // JSON.stringify twice: once to the JSON payload, once more to a correctly
    // escaped JS string literal of that payload — so the payload's own double
    // quotes can't nest-break the wrapper. Function replacer keeps a `$` in any
    // URL literal from being read as a replacement pattern.
    const jsStringLiteral = JSON.stringify(JSON.stringify(arr))
    out = out.replace(lit, () => jsStringLiteral)
  }
  injectList('__PRECACHE_ASSETS__', firstPaintAssets)
  injectList('__PRECACHE_REST_ASSETS__', restAssets)

  for (const p of PLACEHOLDERS) {
    if (out.includes(p)) throw new Error(`placeholder ${p} survived injection`)
  }
  // Parse-check the stamped worker (compile without running — free identifiers
  // like `self` are fine) so a syntax error fails the build, not the browser.
  try {
    new Function(out)
  } catch (err) {
    throw new Error(`stamped sw.js is not valid JS: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    })
  }
  return out
}
