/**
 * Bundled dependencies as importmap entries for dynamic extensions.
 *
 * A block-installed extension resolves imports through the page importmap,
 * which mapped only `@/` (plus React on esm.sh) — so `import {Decoration} from
 * '@codemirror/view'` failed to resolve, and bundling a private copy into the
 * extension fails later: CodeMirror checks extension values against ITS
 * classes, so a ViewPlugin from a second `@codemirror/state` is "Unrecognized
 * extension value". The requirement is identity: the extension must land on
 * the module instance the running app uses. React is on the same path — the
 * esm.sh externals it used to have existed only to give extensions one React
 * instance, which this does for every dependency.
 *
 * The exposed set is package.json `dependencies` — the root's direct runtime
 * dependencies, minus `isExposed` — plus the subpaths the app's own code
 * imports (`react-dom/client`) and the runtimes the build injects without any
 * source naming them. One owner for the list, and it is already reviewed on
 * every change. Two rejected ways of deriving it: from the module graph (an
 * extension would depend on a version some intermediate package pins, and the
 * surface would shift on a routine dependency bump — a transitive package an
 * extension needs is exposed by adding it to `dependencies`), and from each
 * package's `exports` map (across this dependency set that is UMD builds, node
 * variants, CSS and unresolvable `./types` entries; an extension can import
 * what the app imports).
 *
 * Build: the `options` hook adds each specifier as a Rollup input at
 * `vendor/<specifier>` — the same shape the `src/**` entries take, so each
 * emits as a thin facade re-exporting from the boot chunk — and
 * `transformIndexHtml` adds `"<specifier>": "./vendor/<specifier>.js"` to the
 * importmap. Emitting the chunks from a plugin hook instead deadlocks rolldown
 * when done from `resolveId`; inputs are the supported path.
 *
 * A CommonJS package (React) gets a generated shim as its input instead of the
 * bare specifier: rolldown cannot read CommonJS export names statically, so
 * its facade would carry `default` alone and `import {useState} from 'react'`
 * would fail to link. The shim re-exports each name Node sees on the module
 * (`createRequire`), off the same `module.exports` object the app chunk uses.
 * Which kind a package is follows Vite's OWN build resolver, not Node's: a dual
 * package resolves to its CommonJS entry under Node's conditions and to its
 * ESM entry under the browser's, and only the latter is what rolldown bundles.
 *
 * Dev: `/vendor/<specifier>.js` is a virtual `export * from '<specifier>'`
 * module that goes through Vite's own import analysis, so it rewrites to the
 * same `/node_modules/.vite/deps/…?v=` URL the kernel's imports use. Two
 * instances in dev would fail exactly like production, silently.
 *
 * Never exposed: `workspace:` packages (source-aliased) and `@types/*`.
 */
import fs from 'node:fs'
import {globSync} from 'node:fs'
import {createRequire} from 'node:module'
import path from 'node:path'
import type {Plugin, ResolvedConfig} from 'vite'
import {rewriteImportMapScript} from './importMapHtml'

export const VENDOR_DIR = 'vendor'
const VIRTUAL_PREFIX = '\0km-vendor:'
const DEV_URL_PATTERN = /^\/vendor\/(.+)\.js$/
const CJS_SHIM_PREFIX = 'virtual:km-vendor-cjs/'
const CJS_SHIM_ID_PREFIX = `\0${CJS_SHIM_PREFIX}`
const RESOLVE_PATTERN = /^\/vendor\/|^virtual:km-vendor-cjs\//
const LOAD_PATTERN = /^\0km-vendor:|^\0virtual:km-vendor-cjs\//

/** Specifiers the build emits that no source file names: the automatic JSX
 *  runtime (`@vitejs/plugin-react`) and the React Compiler runtime. Only apply
 *  when `react` is a dependency. */
const BUILD_INJECTED_SPECIFIERS = ['react/jsx-runtime', 'react/jsx-dev-runtime', 'react/compiler-runtime']

export const vendorFileName = (specifier: string): string => `${VENDOR_DIR}/${specifier}.js`

/** Importmap `imports` for a set of specifiers, keyed by bare name. Relative
 *  to the document, like the `"@/": "./src/"` entry beside them. */
export const vendorImports = (specifiers: Iterable<string>): Record<string, string> =>
  Object.fromEntries([...specifiers].sort().map(s => [s, `./${vendorFileName(s)}`]))

/** Top-level package name of a bare specifier — `zod/v4` → `zod`,
 *  `@codemirror/view/x` → `@codemirror/view`. `undefined` for relative,
 *  absolute, virtual (`\0…`), protocol (`node:`, `virtual:`) and `@/` alias
 *  specifiers, which are not packages. */
export const packageNameOf = (specifier: string): string | undefined => {
  if (!specifier || /^[./\\\0]/.test(specifier) || specifier.startsWith('@/') || /^[a-z][a-z0-9+.-]*:/i.test(specifier)) {
    return undefined
  }
  const [head, second] = specifier.split('/')
  if (head.startsWith('@')) return second ? `${head}/${second}` : undefined
  return head
}

type PackageJson = {dependencies?: Record<string, string>}

const readPackageJson = (dir: string): PackageJson | undefined => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as PackageJson
  } catch {
    return undefined
  }
}

const isExposed = (pkg: string, versionSpec: string): boolean =>
  !pkg.startsWith('@types/') && !versionSpec.startsWith('workspace:')

/** The packages this build exposes, sorted. */
export const exposedVendorPackages = (rootDir: string): string[] =>
  Object.entries(readPackageJson(rootDir)?.dependencies ?? {})
    .filter(([pkg, spec]) => isExposed(pkg, spec))
    .map(([pkg]) => pkg)
    .sort()

// Same exclusions as the build's entry glob (vite.config.ts allSrcEntries):
// a specifier only a test imports is not something the app ships.
const SOURCE_GLOB = 'src/**/*.{ts,tsx,js,jsx}'
const SOURCE_EXCLUDE = ['**/test/**', '**/*.test.*', '**/*.d.ts']
const SPECIFIER_PATTERN = /\b(?:from|import)\s*\(?\s*['"]([^'"\n]+)['"]/g

const readSourceFiles = (rootDir: string): string[] =>
  globSync(SOURCE_GLOB, {cwd: rootDir, exclude: SOURCE_EXCLUDE})
    .map(file => fs.readFileSync(path.join(rootDir, file), 'utf8'))

/** Subpaths of `packages` that the app's own source imports (`react-dom/client`),
 *  sorted and unique. A `?query` suffix is not part of the specifier. */
export const appImportedSubpaths = (
  sources: Iterable<string>,
  packages: ReadonlySet<string>,
): string[] => {
  const found = new Set<string>()
  for (const source of sources) {
    for (const [, raw] of source.matchAll(SPECIFIER_PATTERN)) {
      const specifier = raw.split('?')[0]
      const pkg = packageNameOf(specifier)
      if (pkg && specifier !== pkg && packages.has(pkg)) found.add(specifier)
    }
  }
  return [...found].sort()
}

/** Every specifier this build exposes — packages, the subpaths the app
 *  imports, and the build-injected runtimes — sorted. */
export const exposedVendorSpecifiers = (
  rootDir: string,
  sources: Iterable<string> = readSourceFiles(rootDir),
): string[] => {
  const packages = exposedVendorPackages(rootDir)
  const set = new Set(packages)
  const injected = set.has('react') ? BUILD_INJECTED_SPECIFIERS : []
  return [...new Set([...packages, ...appImportedSubpaths(sources, set), ...injected])].sort()
}

export type ModuleKind = 'esm' | 'cjs'

const ESM_SYNTAX = /^\s*(?:export\b|import\s*[{*'"a-zA-Z_$])/m

const nearestPackageType = (file: string): string | undefined => {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'package.json')
    if (fs.existsSync(candidate)) return (readPackageJson(dir) as {type?: string} | undefined)?.type
    if (path.dirname(dir) === dir) return undefined
  }
}

/** What rolldown will see in a resolved entry file: by extension, then the
 *  nearest package.json `type`, then a syntax sniff for a type-less `.js`. */
export const moduleKind = (
  file: string,
  read: (file: string) => string = f => fs.readFileSync(f, 'utf8'),
  packageType: (file: string) => string | undefined = nearestPackageType,
): ModuleKind => {
  if (file.endsWith('.mjs')) return 'esm'
  if (file.endsWith('.cjs')) return 'cjs'
  if (packageType(file) === 'module') return 'esm'
  return ESM_SYNTAX.test(read(file).slice(0, 65_536)) ? 'esm' : 'cjs'
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/** Named exports Node sees on a CommonJS module, `default`/`__esModule` aside.
 *  Loud on failure: a shim with no names is the link error this exists to
 *  prevent, one step later. */
export const cjsExportNames = (rootDir: string, specifier: string): string[] => {
  let mod: unknown
  try {
    mod = createRequire(path.join(rootDir, 'package.json'))(specifier) as unknown
  } catch (err) {
    throw new Error(`vendor-import-map: cannot require ${specifier} to enumerate its CommonJS exports`, {cause: err})
  }
  if (typeof mod !== 'object' && typeof mod !== 'function') return []
  return Object.keys(mod as object).filter(k => IDENTIFIER.test(k) && k !== 'default' && k !== '__esModule').sort()
}

/** The shim module for a CommonJS package: the module.exports object as
 *  `default`, and each name destructured off it as a named export. */
export const cjsShimSource = (specifier: string, names: readonly string[]): string => {
  const from = JSON.stringify(specifier)
  const named = names.length ? `export const {${names.join(', ')}} = m;\n` : ''
  return `import m from ${from};\nexport default m;\n${named}`
}

export const vendorImportMapPlugin = ({rootDir}: {rootDir: string}): Plugin => {
  const exposed = exposedVendorSpecifiers(rootDir)
  let resolveForBuild: ((specifier: string) => Promise<string | undefined>) | undefined
  return {
    name: 'vendor-import-map',
    // Before Vite's resolver, which would otherwise try `/vendor/…` as a file.
    enforce: 'pre',
    configResolved(config: ResolvedConfig) {
      if (config.command !== 'build') return
      const resolve = config.createResolver()
      resolveForBuild = specifier => resolve(specifier, undefined, false, false)
    },
    async options(opts) {
      if (!resolveForBuild) return null
      if (!opts.input || typeof opts.input !== 'object' || Array.isArray(opts.input)) {
        throw new Error('vendor-import-map: expects the build input to be a name → id record')
      }
      const input: Record<string, string> = {...(opts.input as Record<string, string>)}
      for (const specifier of exposed) {
        const file = await resolveForBuild(specifier)
        if (!file) throw new Error(`vendor-import-map: cannot resolve ${specifier}`)
        input[`${VENDOR_DIR}/${specifier}`] = moduleKind(file) === 'cjs' ? CJS_SHIM_PREFIX + specifier : specifier
      }
      return {...opts, input}
    },
    // Filtered so the hooks never run for the rest of the graph.
    resolveId: {
      filter: {id: RESOLVE_PATTERN},
      handler(source) {
        if (source.startsWith(CJS_SHIM_PREFIX)) return `\0${source}`
        const match = DEV_URL_PATTERN.exec(source)
        return match ? VIRTUAL_PREFIX + match[1] : null
      },
    },
    load: {
      filter: {id: LOAD_PATTERN},
      handler(id) {
        if (id.startsWith(CJS_SHIM_ID_PREFIX)) {
          const specifier = id.slice(CJS_SHIM_ID_PREFIX.length)
          return cjsShimSource(specifier, cjsExportNames(rootDir, specifier))
        }
        const specifier = JSON.stringify(id.slice(VIRTUAL_PREFIX.length))
        // `export *` never forwards `default`; the namespace read makes it a
        // plain `undefined` for a package without one instead of a load error.
        return `import * as m from ${specifier};\nexport * from ${specifier};\nexport default m.default;\n`
      },
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return rewriteImportMapScript(html, importMap => ({
          ...importMap,
          imports: {...importMap.imports, ...vendorImports(exposed)},
        }))
      },
    },
  }
}
