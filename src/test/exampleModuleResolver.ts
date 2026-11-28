// Shared test helper for evaluating extension EXAMPLE sources.
//
// Example/authoring snippets are ESM module text. To evaluate one, we Babel
// down to CommonJS and run it with a `require` shim. Since the barrel was
// retired, a snippet imports from many real modules (`@/extensions/core.js`,
// `@/data/api/index.js`, …) rather than a single `@/extensions/api.js`. This
// resolver preloads whatever the snippet imports and hands back a synchronous
// `require` over the loaded namespaces.
//
// Preload the CommonJS output's require calls through the same import policy
// as the production loader, including JSX's generated runtime import.

import * as Babel from '@babel/standalone'
import {
  importedSpecifiers, literalModuleSpecifier, moduleReference, visitModuleSyntax,
} from '@knowledge-medium/agent-cli/extensionImportSyntax'
import {extensionApiCatalog} from '@/extensions/apiCatalog'
import {EXTENSION_BABEL_PRESETS} from '@/extensions/compileExtensionModule'
import type {AppExtension} from '@/facets/facet'
import {resolveExtensionImport, runnableSpecifier} from '@/extensions/extensionImportPolicy'

const buildExampleRequire = async (
  compiled: string,
): Promise<(specifier: string) => unknown> => {
  const specifiers = new Set<string>()
  visitModuleSyntax(Babel.packages.parser.parse(compiled), node => {
    const reference = moduleReference(node, true)
    if (reference?.kind !== 'require') return
    const specifier = reference.source && literalModuleSpecifier(reference.source)
    if (specifier === undefined) throw new Error('Example require() needs a literal specifier')
    specifiers.add(specifier)
  })

  const modules = new Map<string, unknown>()
  for (const specifier of specifiers) {
    const resolved = resolveExtensionImport(specifier)
    const path = resolved.kind === 'page'
      ? resolved.target.replace(/^\.\/src\//, '@/')
      : specifier.replace(/\.js$/, '')
    modules.set(specifier, await import(/* @vite-ignore */ path))
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
    presets: EXTENSION_BABEL_PRESETS,
    plugins: ['transform-modules-commonjs'],
  })?.code
  if (!compiled) throw new Error(`${filename}: Babel returned empty output`)

  const module = {exports: {} as {default?: AppExtension}}
  const requireExampleImport = await buildExampleRequire(compiled)
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

export const parseFixture = (source: string, path: string) =>
  Babel.packages.parser.parse(source, {
    sourceType: 'module',
    // Derived from the extension: an angle-bracket type assertion is legal in
    // .ts and a parse error under the jsx plugin, so a blanket
    // ['typescript','jsx'] crashed on source tsc and eslint both accept.
    plugins: path.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'],
  })

// Anchored to a comment opener: these files legitimately DISCUSS suppressions
// in prose ("never reach for @ts-expect-error here"), which a bare substring
// search bans along with the real thing.
/** A comment IS a suppression when a line of it STARTS with the directive.
 *  Anchoring per line keeps prose that merely discusses one ("never reach for
 *  @ts-expect-error here") legal, while catching the `*`-prefixed
 *  continuation inside a block comment and the JSX `{/* … *\/}` form. */
const isSuppressionComment = (text: string): boolean =>
  text.split('\n').some(line =>
    /^\*?\s*(@ts-(nocheck|ignore|expect-error)\b|eslint\b)/.test(line.trim()))

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
    let ast: ReturnType<typeof parseFixture>
    try {
      ast = parseFixture(source, path)
    } catch (error) {
      // A parse failure is a finding about THIS fixture, not a stack into
      // Babel internals with no filename attached.
      badSpecifiers.push(`${path}: parse failed — ${(error as Error).message}`)
      continue
    }
    for (const specifier of importedSpecifiers(ast, true)) {
      if (!specifier || !runnableSpecifier(specifier)) badSpecifiers.push(`${path}: ${specifier ?? '<computed>'}`)
    }
    // Comment TEXT, not the raw source: prose that merely discusses a
    // suppression ("never reach for @ts-expect-error here") lives in a
    // comment too, so the check is that no comment IS one.
    if (ast.comments?.some(comment => isSuppressionComment(comment.value))) badSuppressions.push(path)
  }
  return {badSpecifiers, badSuppressions}
}
