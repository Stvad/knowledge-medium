import {describe, expect, it} from 'vitest'
import {stampSwSource} from './stamp-sw-source'

// Build a worker-shaped source expression whose three placeholders are wrapped in
// `quote` — ', ", or ` (backtick) — so a stamp can be exercised against each
// delimiter a minifier might emit. Returns an expression we can eval back to read
// what the runtime JSON.parse produced.
const swExpr = (quote: string): string =>
  `({` +
  `buildId:${quote}__BUILD_ID__${quote},` +
  `first:JSON.parse(${quote}__PRECACHE_ASSETS__${quote}),` +
  `rest:JSON.parse(${quote}__PRECACHE_REST_ASSETS__${quote})` +
  `})`

// Eval the stamped first-party expression to read back its decoded runtime
// values (what the worker's own JSON.parse would produce). Test-only, trusted input.
const evalExpr = (src: string) => new Function(`return ${src}`)() as {buildId: string; first: string[]; rest: string[]}

describe('stampSwSource', () => {
  const buildId = 'abc123def456'
  const firstPaintAssets = ['/knowledge-medium/src/main.js', '/knowledge-medium/assets/index.css']
  const restAssets = ['/knowledge-medium/src/extensions/api.js', '/knowledge-medium/assets/x.woff2']

  // The load-bearing property: the stamp survives whatever quote style the
  // minifier chose. oxc rewrites string literals to backticks, so the backtick
  // case is the one that a JSON.parse("…")/'…'-only matcher would silently miss.
  it.each([
    ['single quotes', "'"],
    ['double quotes', '"'],
    ['backticks (minified form)', '`'],
  ])('stamps build id + precache lists wrapped in %s', (_label, quote) => {
    const stamped = stampSwSource(swExpr(quote), {buildId, firstPaintAssets, restAssets})
    for (const p of ['__BUILD_ID__', '__PRECACHE_ASSETS__', '__PRECACHE_REST_ASSETS__']) {
      expect(stamped).not.toContain(p)
    }
    const decoded = evalExpr(stamped)
    expect(decoded.buildId).toBe(buildId)
    expect(decoded.first).toEqual(firstPaintAssets)
    expect(decoded.rest).toEqual(restAssets)
  })

  // The escaping trap: a payload carrying the JS-string metacharacters ($, ", \)
  // must round-trip exactly. This is why the injector double-JSON.stringifies and
  // uses a function replacer rather than pasting the raw JSON.
  it('round-trips URLs containing $, quotes, and backslashes', () => {
    const nasty = ['/a$b/c"d', "/e'f", '/g\\h', '/i$&j']
    const stamped = stampSwSource(swExpr('`'), {buildId, firstPaintAssets: nasty, restAssets})
    expect(evalExpr(stamped).first).toEqual(nasty)
  })

  it('throws when the build-id placeholder is absent', () => {
    expect(() =>
      stampSwSource('JSON.parse(`__PRECACHE_ASSETS__`);JSON.parse(`__PRECACHE_REST_ASSETS__`)', {
        buildId,
        firstPaintAssets,
        restAssets,
      }),
    ).toThrow(/__BUILD_ID__ not found/)
  })

  it('throws when a precache placeholder is absent', () => {
    expect(() =>
      stampSwSource('`__BUILD_ID__`;JSON.parse(`__PRECACHE_ASSETS__`)', {
        buildId,
        firstPaintAssets,
        restAssets,
      }),
    ).toThrow(/__PRECACHE_REST_ASSETS__/)
  })

  it('throws when the stamped result would not parse as JS', () => {
    // A dangling `(` after the placeholders makes the post-stamp body unparseable,
    // so the guard must reject it rather than let a broken worker ship.
    expect(() =>
      stampSwSource('`__BUILD_ID__`;JSON.parse(`__PRECACHE_ASSETS__`);JSON.parse(`__PRECACHE_REST_ASSETS__`);(', {
        buildId,
        firstPaintAssets,
        restAssets,
      }),
    ).toThrow(/not valid JS/)
  })
})
