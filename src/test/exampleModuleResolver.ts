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

/** Every module specifier a source imports, from the PARSED module — static
 *  imports, `export … from`, dynamic `import()` and `require()`.
 *
 *  This was a regex over the source text and it silently missed the most
 *  common shape in these files: a multiline `import {\n  a,\n} from '…'`,
 *  because the pattern could not span a newline. Five real imports in the
 *  fixtures went unchecked. Parsing removes that whole class — and the
 *  prose false positives with it, since a comment is not an import node. */
export const importedSpecifiers = (source: string): string[] => {
  const ast = Babel.packages.parser.parse(source, {
    sourceType: 'module',
    plugins: ['typescript', 'jsx'],
  })
  const found: string[] = []
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const candidate = node as {type?: string, source?: {value?: unknown}, callee?: {type?: string, name?: string}, arguments?: unknown[]}
    if (
      (candidate.type === 'ImportDeclaration'
        || candidate.type === 'ExportNamedDeclaration'
        || candidate.type === 'ExportAllDeclaration')
      && typeof candidate.source?.value === 'string'
    ) {
      found.push(candidate.source.value)
    }
    if (candidate.type === 'CallExpression') {
      const isDynamic = candidate.callee?.type === 'Import'
      const isRequire = candidate.callee?.type === 'Identifier' && candidate.callee.name === 'require'
      const first = candidate.arguments?.[0] as {type?: string, value?: unknown} | undefined
      if ((isDynamic || isRequire) && first?.type === 'StringLiteral' && typeof first.value === 'string') {
        found.push(first.value)
      }
    }
    for (const value of Object.values(node as Record<string, unknown>)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(ast.program)
  return found
}

/** Comments the parser found, so a suppression is detected wherever it is
 *  written — including `{/* @ts-expect-error *\/}` in JSX children and a
 *  `*`-prefixed continuation line inside a block comment, both of which a
 *  line-anchored regex missed. */
const commentTexts = (source: string): string[] => {
  const ast = Babel.packages.parser.parse(source, {
    sourceType: 'module',
    plugins: ['typescript', 'jsx'],
  })
  return (ast.comments ?? []).map(comment => comment.value)
}

/** The ONE form the extension runtime accepts. `@/` is an importmap prefix
 *  mapping to ./src/, and the loader instantiates from a `blob:` URL — so a
 *  relative or extensionless specifier cannot resolve there, however happily
 *  tsconfig's bundler resolution accepts it. `react` / `react-dom` are
 *  importmap entries in their own right, including their subpath prefixes
 *  (`react/jsx-runtime`, `react-dom/client`). Backtracking above the `@/`
 *  prefix is rejected by the import-maps spec even though it typechecks. */
const runnableSpecifier = (specifier: string): boolean => {
  // Backtracking is rejected on EVERY branch: `react/../../evil.js` used to
  // pass because the react check returned before the `../` test was reached.
  if (specifier.includes('../')) return false
  if (specifier === 'react' || specifier === 'react-dom') return true
  if (specifier.startsWith('react/') || specifier.startsWith('react-dom/')) return true
  return /^@\/[\w./-]+\.js$/.test(specifier)
}

// Anchored to a comment opener: these files legitimately DISCUSS suppressions
// in prose ("never reach for @ts-expect-error here"), which a bare substring
// search bans along with the real thing.
/** A comment IS a suppression when a line of it STARTS with the directive.
 *  Anchoring per line keeps prose that merely discusses one ("never reach for
 *  @ts-expect-error here") legal, while catching the `*`-prefixed
 *  continuation inside a block comment and the JSX `{/* … *\/}` form. */
const isSuppressionComment = (text: string): boolean =>
  text.split('\n').some(line =>
    /^\*?\s*(@ts-(nocheck|ignore|expect-error)\b|eslint-disable)/.test(line.trim()))

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
    // Comment TEXT, not the raw source: prose that merely discusses a
    // suppression ("never reach for @ts-expect-error here") lives in a
    // comment too, so the check is that no comment IS one.
    if (commentTexts(source).some(isSuppressionComment)) badSuppressions.push(path)
  }
  return {badSpecifiers, badSuppressions}
}
