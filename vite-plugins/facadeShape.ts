/** What an emitted vendor facade (`dist/vendor/<specifier>.js`) may contain.
 *  A facade that carries anything else holds the package's own code — a second
 *  copy of a module the app chunk already has, which is the instanceof failure
 *  the vendor importmap exists to prevent, and it would still resolve. The
 *  post-build gate (scripts/check-dist-exports.ts) applies these to every
 *  importmap entry. */
const FACADE_NOISE = new RegExp(
  [
    /import\s*\{[^}]*\}\s*from\s*["'][^"']+["'];?/, // the re-export imports
    /export\s*\{[^}]*\};?/, // the export clause (default included, as `x as default`)
    /["']use client["'];?/, // a directive some packages carry
    // The CommonJS shim's one statement: the interop call, optionally the
    // `default` read, and the names destructured off the namespace.
    /var\s+\w+\s*=\s*\w+\(\w+\(\)\)(?:\s*,\s*\w+\s*=\s*\w+\.default)?(?:\s*,\s*\{[^}]*\}\s*=\s*\w+)?;/,
    /\/\/#\s*sourceMappingURL=.*$/,
  ].map(re => re.source).join('|'),
  'gm',
)

/** Every module the facade imports — `from "…"` re-exports and bare
 *  `import "…"` side-effect imports alike. Each must be a chunk. */
export const facadeImportTargets = (text: string): string[] =>
  [...text.matchAll(/\b(?:from|import)\s*["']([^"']+)["']/g)].map(([, target]) => target)

/** What remains once the permitted statements are stripped: empty for a
 *  facade, the package's own code otherwise. */
export const facadeResidue = (text: string): string => text.replace(FACADE_NOISE, '').trim()
