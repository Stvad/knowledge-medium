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

import * as Babel from '@babel/standalone'
import {extensionApiCatalog} from '@/extensions/apiCatalog'
import type {AppExtension} from '@/facets/facet'

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

/**
 * Babel-transpile an example source to CommonJS and evaluate it against the
 * real app modules it imports, returning its default-exported AppExtension.
 * Shared by the authoring-catalog and example-extension eval tests.
 */
export const evaluateExampleModule = async (
  source: string,
  filename: string,
): Promise<AppExtension> => {
  const compiled = Babel.transform(source, {
    filename,
    presets: ['react', 'typescript'],
    plugins: ['transform-modules-commonjs'],
  }).code
  if (!compiled) throw new Error(`${filename}: Babel returned empty output`)

  const module = {exports: {} as {default?: AppExtension}}
  const requireExampleImport = await buildExampleRequire(source)
  const evaluate = new Function('require', 'module', 'exports', compiled)
  evaluate(requireExampleImport, module, module.exports)
  if (!module.exports.default) throw new Error(`${filename}: no default export`)
  return module.exports.default
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

/** Every module specifier a source imports, across ALL import forms: the
 *  `from '…'` clause, a bare side-effect `import '…'`, and dynamic
 *  `import('…')`. Scoped to import STATEMENTS — a `\bfrom` scan over the whole
 *  file also matches English prose, and these fixtures are teaching material
 *  full of comments. */
export const importedSpecifiers = (source: string): string[] => {
  const pattern
    = /(?:^|\n)\s*(?:import|export)\b[^;\n]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]/g
  return [...source.matchAll(pattern)]
    .map(match => match[1] ?? match[2] ?? match[3])
    .filter((specifier): specifier is string => Boolean(specifier))
}

/** The ONE form the extension runtime accepts. `@/` is an importmap prefix
 *  mapping to ./src/, and the loader instantiates from a `blob:` URL — so a
 *  relative or extensionless specifier cannot resolve there, however happily
 *  tsconfig's bundler resolution accepts it. `react` / `react-dom` are
 *  importmap entries in their own right, including their subpath prefixes
 *  (`react/jsx-runtime`, `react-dom/client`). Backtracking above the `@/`
 *  prefix is rejected by the import-maps spec even though it typechecks. */
const runnableSpecifier = (specifier: string): boolean => {
  if (specifier === 'react' || specifier === 'react-dom') return true
  if (specifier.startsWith('react/') || specifier.startsWith('react-dom/')) return true
  return /^@\/[\w./-]+\.js$/.test(specifier) && !specifier.includes('../')
}

// Anchored to a comment opener: these files legitimately DISCUSS suppressions
// in prose ("never reach for @ts-expect-error here"), which a bare substring
// search bans along with the real thing.
const SUPPRESSION = /(^|\s)(\/\/|\/\*)\s*(@ts-(nocheck|ignore|expect-error)|eslint-disable)/m

/**
 * Shared hygiene checks for compiled example fixtures. Both example families
 * need identical rules, and a rule fixed in one place must not have to be
 * fixed twice.
 *
 * Returns problems rather than asserting, so the caller supplies the message.
 */
export const fixtureHygieneProblems = (
  fixtureSources: Record<string, string>,
): {badSpecifiers: string[], badSuppressions: string[]} => {
  const badSpecifiers: string[] = []
  const badSuppressions: string[] = []
  for (const [path, source] of Object.entries(fixtureSources)) {
    for (const specifier of importedSpecifiers(source)) {
      if (!runnableSpecifier(specifier)) badSpecifiers.push(`${path}: ${specifier}`)
    }
    if (SUPPRESSION.test(source)) badSuppressions.push(path)
  }
  return {badSpecifiers, badSuppressions}
}

/** Identifiers written as a call in backticked PROSE — `seedType({…})`,
 *  `getPluginPrefsBlock(repo, …)`. The catalog's guide text is full of these
 *  and nothing compiles it, which is the same hole the worked examples used
 *  to have: a rename leaves the prose describing an API that is gone. (It
 *  already happened — the prose advertised a `set` prop on
 *  PropertyEditorProps long after the real one was `onChange`.)
 *
 *  Member calls (`repo.tx(`, `block.set(`) are skipped: they are methods, not
 *  module exports, and the catalog does not claim to list them. */
export const proseCallIdentifiers = (text: string): string[] => {
  const calls = [...text.matchAll(/`([^`]*)`/g)]
    .flatMap(match => [...match[1].matchAll(/(^|[^.\w])([A-Za-z_$][\w$]*)\s*\(/g)])
    .map(match => match[2])
  return [...new Set(calls)]
}
