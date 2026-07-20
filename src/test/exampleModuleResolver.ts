// Shared test helper for evaluating extension EXAMPLE sources.
//
// Example/authoring snippets are ESM module text. To evaluate one, we Babel
// down to CommonJS and run it with a `require` shim. Since the barrel was
// retired, a snippet imports from many real modules (`@/extensions/core.js`,
// `@/data/api/index.js`, …) rather than a single `@/extensions/api.js`. This
// resolver preloads whatever the snippet imports and hands back a synchronous
// `require` over the loaded namespaces.
//
// Blob extensions write `@/dir/name.js`; vitest resolves the extensionless
// `@/dir/name` form (including the directory-index `@/data/api/index`). The
// transpiled CommonJS calls `require(<original specifier>)`, so the map is
// keyed on the specifier exactly as written in the source, its value the
// module loaded from the `.js`-stripped form.

import {extensionApiCatalog} from '@/extensions/apiCatalog'

const IMPORT_SPECIFIER_RE = /\bfrom\s*['"]([^'"]+)['"]/g

const resolvableSpecifier = (specifier: string): string =>
  specifier.replace(/\.js$/, '')

/**
 * Preload every module a snippet imports and return a synchronous `require`
 * suitable for a Babel `transform-modules-commonjs` output. Throws on a
 * specifier the snippet didn't declare (defensive — should never happen).
 */
export const buildExampleRequire = async (
  source: string,
): Promise<(specifier: string) => unknown> => {
  const specifiers = new Set<string>()
  for (const match of source.matchAll(IMPORT_SPECIFIER_RE)) {
    specifiers.add(match[1])
  }

  const modules = new Map<string, unknown>()
  for (const specifier of specifiers) {
    modules.set(specifier, await import(/* @vite-ignore */ resolvableSpecifier(specifier)))
  }

  return (specifier: string): unknown => {
    if (!modules.has(specifier)) {
      throw new Error(`unexpected example import ${specifier}`)
    }
    return modules.get(specifier)
  }
}

const catalogByPath = new Map(
  extensionApiCatalog.map(group => [
    group.importPath,
    new Set([...group.exports, ...group.types]),
  ]),
)

// Every named import statement `import [type] { a, b as c, type D } from 'path'`.
// Group 1: the brace contents. Group 2: the module specifier.
const NAMED_IMPORT_RE = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g

/**
 * Named imports as `{specifier, name}` pairs, where `name` is the ORIGINAL
 * exported symbol (the `as` alias and any `type` marker stripped). Both runtime
 * and type-only names are returned; the catalog lists both.
 */
export const parseNamedImports = (source: string): Array<{specifier: string, name: string}> => {
  const out: Array<{specifier: string, name: string}> = []
  for (const match of source.matchAll(NAMED_IMPORT_RE)) {
    const inside = match[1] ?? ''
    const specifier = match[2] ?? ''
    for (const raw of inside.split(',')) {
      const name = raw
        .trim()
        .replace(/^type\s+/, '')      // inline `type Foo`
        .replace(/\s+as\s+.+$/, '')   // `Foo as Bar` — the export is `Foo`
        .trim()
      if (name) out.push({specifier, name})
    }
  }
  return out
}

/**
 * Named imports that reference a curated-API module (`apiCatalog.ts`) but a
 * symbol the catalog does not list — i.e. drift. Imports from modules the
 * catalog doesn't curate (`@/components/ui/*`, `@/hooks/*`, `react`) are
 * ignored: they have no centralized export list to check against.
 */
export const unknownCatalogImports = (source: string): Array<{specifier: string, name: string}> =>
  parseNamedImports(source).filter(({specifier, name}) => {
    const known = catalogByPath.get(specifier)
    return known ? !known.has(name) : false
  })
