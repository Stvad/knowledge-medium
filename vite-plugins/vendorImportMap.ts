/**
 * Bundled dependencies as importmap entries for dynamic extensions.
 *
 * A block-installed extension resolves imports only through the page
 * importmap, and whatever it imports must be the module instance the running
 * app uses: CodeMirror checks extension values against ITS classes, so a
 * ViewPlugin from a second `@codemirror/state` is "Unrecognized extension
 * value", and a second React has no hooks state.
 *
 * The exposed set is package.json `dependencies` (minus `isExposed`) plus the
 * subpaths the app's own source imports (`react-dom/client`) and the JSX
 * runtime the build injects without any source naming it. Not the module
 * graph — an extension would then depend on a version some intermediate
 * package pins; a transitive package an extension needs is added to
 * `dependencies`. Not each package's `exports` map — across this dependency
 * set that is UMD builds, node variants, CSS and unresolvable `./types`.
 *
 * Exposing a package pins its WHOLE export surface into the boot chunk: the
 * facade entry demands every name under `preserveEntrySignatures: 'strict'`,
 * and the package already sits in the `app` group. That is the trade for one
 * shared instance, and it is why `HEAVY_SURFACE` exists.
 *
 * Build: the `options` hook adds each specifier as a Rollup input at
 * `vendor/<specifier>` — the shape the `src/**` entries take, so each emits as
 * a thin facade over the boot chunk — and `transformIndexHtml` maps it. Do not
 * emit these from a plugin hook: `emitFile` from `resolveId` deadlocks
 * rolldown.
 *
 * A CommonJS package gets a generated shim as its input, in dev and build
 * alike: rolldown's facade for a CommonJS entry (and Vite's optimized dep in
 * dev) carries `default` alone, so `import {useState} from 'react'` would fail
 * to link. The shim re-exports each name Node sees on the resolved file.
 *
 * Dev: `/vendor/<specifier>.js` is a virtual module Vite's import analysis
 * rewrites onto the same `/node_modules/.vite/deps/…?v=` URL the kernel's
 * imports use.
 */
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type {Plugin, ResolvedConfig, UserConfig} from 'vite'
import {rewriteImportMapScript} from './importMapHtml'
import {srcEntryFiles} from './srcEntries'

export const VENDOR_DIR = 'vendor'
const DEV_URL_PATTERN = new RegExp(`^/${VENDOR_DIR}/(.+)\\.js$`)
const CJS_INPUT_PREFIX = 'virtual:km-vendor-cjs/'
/** The virtual facade id. In dev it carries a `.cjs` suffix so Vite treats the
 *  facade as a CommonJS-side importer (`isFilePathESM` false) and its
 *  default-import interop matches rolldown's: `default` is `module.exports`
 *  only when the module is not flagged `__esModule`. Under the repo's
 *  `"type": "module"` the id would otherwise be in node mode, and dev would
 *  hand `import Babel from '@babel/standalone'` the exports object that the
 *  production facade leaves undefined. The build id has no suffix: rolldown
 *  would parse a `.cjs` id as CommonJS and reject the facade's `import`. */
const FACADE_ID_PREFIX = '\0km-vendor:'
const DEV_FACADE_ID_SUFFIX = '.cjs'

/** The automatic JSX runtime `@vitejs/plugin-react` emits into every
 *  transformed module; no source file names it. Applies when `react` is a
 *  dependency. The dev-only `react/jsx-dev-runtime` is deliberately absent:
 *  the production build ships a stub of it (`jsxDEV: undefined`), and a bundle
 *  built with a development JSX transform is better off failing to resolve
 *  than calling undefined. */
const BUILD_INJECTED_SPECIFIERS = ['react/jsx-runtime', 'react/compiler-runtime']

/** Packages whose full export surface costs more boot bytes than sharing them
 *  is worth: lucide-react's icons (~180 KB of path data the app tree-shakes)
 *  and all of lodash-es. Extensions that need them bundle their own copy —
 *  neither carries identity-sensitive state. */
const HEAVY_SURFACE = new Set(['lucide-react', 'lodash-es'])

const vendorInputName = (specifier: string): string => `${VENDOR_DIR}/${specifier}`
const vendorFileName = (specifier: string): string => `${vendorInputName(specifier)}.js`

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

type PackageJson = {dependencies?: Record<string, string>; type?: string}

const readPackageJson = (dir: string): PackageJson | undefined => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as PackageJson
  } catch {
    return undefined
  }
}

const isExposed = (pkg: string, versionSpec: string): boolean =>
  !pkg.startsWith('@types/') && !versionSpec.startsWith('workspace:') && !HEAVY_SURFACE.has(pkg)

const exposedVendorPackages = (rootDir: string): string[] =>
  Object.entries(readPackageJson(rootDir)?.dependencies ?? {})
    .filter(([pkg, spec]) => isExposed(pkg, spec))
    .map(([pkg]) => pkg)

const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g
const TYPE_ONLY_IMPORT = /\bimport\s+type\b[^;]*?from\s*['"][^'"]+['"]/g
const SPECIFIER = /\b(?:from|import)\s*\(?\s*['"]([^'"\n]+)['"]/g

/** Subpaths of `packages` that the app's own source imports at runtime
 *  (`react-dom/client`), sorted and unique. Comments and type-only imports
 *  are not imports; a `?query` suffix is not part of the specifier. */
export const appImportedSubpaths = (
  sources: Iterable<string>,
  packages: ReadonlySet<string>,
): string[] => {
  const found = new Set<string>()
  for (const source of sources) {
    const code = source.replace(COMMENTS, '').replace(TYPE_ONLY_IMPORT, '')
    for (const [, raw] of code.matchAll(SPECIFIER)) {
      const specifier = raw.split('?')[0]
      const pkg = packageNameOf(specifier)
      if (pkg && specifier !== pkg && packages.has(pkg)) found.add(specifier)
    }
  }
  return [...found].sort()
}

/** Every specifier this build exposes, sorted. */
const exposedVendorSpecifiers = (rootDir: string): string[] => {
  const packages = exposedVendorPackages(rootDir)
  const set = new Set(packages)
  const injected = set.has('react') ? BUILD_INJECTED_SPECIFIERS : []
  const sources = srcEntryFiles(rootDir).map(file => fs.readFileSync(path.join(rootDir, file), 'utf8'))
  return [...new Set([...packages, ...appImportedSubpaths(sources, set), ...injected])].sort()
}

type ModuleKind = 'esm' | 'cjs'

// `import` followed by whitespace-then-identifier, or directly by a brace,
// star or quote. Bare `import\s*[a-z]` would also match `import_x = 1`.
const ESM_SYNTAX = /^\s*(?:export\b|import\s*[{*'"]|import\s+[A-Za-z_$])/m

const nearestPackageType = (file: string): string | undefined => {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return readPackageJson(dir)?.type
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

// Runs in the child: print the module's own keys and exit. `process.argv[1]`
// is the file under `node -e`.
const ENUMERATE_EXPORTS =
  'const m = require(process.argv[1]);' +
  'process.stdout.write(JSON.stringify(m && (typeof m === "object" || typeof m === "function") ? Object.keys(m) : []));' +
  'process.exit(0)'

/** Named exports Node sees on a CommonJS file, `default`/`__esModule` aside.
 *  Evaluated in a CHILD process that exits explicitly: a package's
 *  module-level side effects must not share the build's event loop —
 *  react-dom's browser server build opens a MessageChannel that would keep
 *  `vite build` alive after it finishes. The child inherits NODE_ENV, so the
 *  names match the build the bundler picks. Memoized per file for the life of
 *  the process: a dependency changed under a running dev server needs a
 *  restart. Loud on failure: a shim with no names is the link error this
 *  exists to prevent, one step later. */
const cjsExportNamesByFile = new Map<string, string[]>()
const cjsExportNames = (file: string): string[] => {
  const memo = cjsExportNamesByFile.get(file)
  if (memo) return memo
  let names: string[]
  try {
    const out = execFileSync(process.execPath, ['-e', ENUMERATE_EXPORTS, file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    })
    names = JSON.parse(out) as string[]
  } catch (err) {
    throw new Error(
      `vendor-import-map: cannot require ${file} to enumerate its CommonJS exports; ` +
        'a browser-only CommonJS dependency needs an ESM entry or an exclusion in isExposed',
      {cause: err},
    )
  }
  const filtered = names.filter(k => IDENTIFIER.test(k) && k !== 'default' && k !== '__esModule').sort()
  cjsExportNamesByFile.set(file, filtered)
  return filtered
}

/** The shim for a CommonJS package. Names are read off the NAMESPACE, not off
 *  `default`: for a module flagged `__esModule` both bundlers' interop leaves
 *  `default` undefined (`@babel/standalone`), while the namespace carries every
 *  own key in either case and `default` is `module.exports` where that applies.
 *  Names are destructured under aliases so a reserved word (`catch`, `enum`)
 *  can still be an export name. */
export const cjsShimSource = (specifier: string, names: readonly string[]): string => {
  const from = JSON.stringify(specifier)
  const head = `import * as m from ${from};\nexport default m.default;\n`
  if (names.length === 0) return head
  const destructure = names.map((name, i) => `${name}: _${i}`).join(', ')
  const exports = names.map((name, i) => `_${i} as ${name}`).join(', ')
  return `${head}const {${destructure}} = m;\nexport {${exports}};\n`
}

/** The dev facade for an ESM package. `export *` never forwards `default`,
 *  hence the namespace read. Accepted divergences, the build being the
 *  contract: a package with no default export links `default` as undefined
 *  here, where the production facade has no such binding and importing it is
 *  a link error; and a package whose ESM entry only wraps CommonJS would get
 *  `export *` here while Vite's optimizer flattens it to a default — none in
 *  the dependency set today. */
const esmFacadeSource = (specifier: string): string => {
  const from = JSON.stringify(specifier)
  return `import * as m from ${from};\nexport * from ${from};\nexport default m.default;\n`
}

/** Facade source for `specifier` given the file the bundler resolves it to
 *  and what it sees in it. */
export const facadeSource = (specifier: string, file: string, kind: ModuleKind): string =>
  kind === 'cjs' ? cjsShimSource(specifier, cjsExportNames(file)) : esmFacadeSource(specifier)

export const vendorImportMapPlugin = ({rootDir}: {rootDir: string}): Plugin => {
  const exposed = exposedVendorSpecifiers(rootDir)
  const exposedSet = new Set(exposed)
  let isBuild = false
  const facadeIdSuffix = (): string => (isBuild ? '' : DEV_FACADE_ID_SUFFIX)
  const facadeId = (specifier: string): string => `${FACADE_ID_PREFIX}${specifier}${facadeIdSuffix()}`
  const facadeSpecifier = (id: string): string | undefined => {
    const suffix = facadeIdSuffix()
    if (!id.startsWith(FACADE_ID_PREFIX) || !id.endsWith(suffix)) return undefined
    return id.slice(FACADE_ID_PREFIX.length, id.length - suffix.length)
  }
  let resolveFile: ((specifier: string) => Promise<string>) | undefined
  type Resolved = {file: string; kind: ModuleKind}
  const resolved = new Map<string, Resolved>()
  /** What the bundler sees for `specifier`: decided once, used by the input
   *  choice and the facade source alike. */
  const resolve = async (specifier: string): Promise<Resolved> => {
    let entry = resolved.get(specifier)
    if (!entry) {
      if (!resolveFile) throw new Error('vendor-import-map: resolver used before configResolved')
      const file = await resolveFile(specifier)
      entry = {file, kind: moduleKind(file)}
      resolved.set(specifier, entry)
    }
    return entry
  }

  return {
    name: 'vendor-import-map',
    // Before Vite's resolver, which would otherwise try `/vendor/…` as a file.
    enforce: 'pre',
    config(userConfig: UserConfig, env) {
      if (env.command !== 'serve') return null
      // Pre-bundle every exposed specifier up front: one the kernel's own graph
      // never imports would otherwise be discovered on an extension's first
      // request, re-optimized, and reload the page mid-load. Exposed and
      // pre-bundled are different sets: a package the config excludes from the
      // optimizer (the PowerSync family) is still a facade, served from source.
      const excluded = new Set(userConfig.optimizeDeps?.exclude ?? [])
      return {optimizeDeps: {include: exposed.filter(s => !excluded.has(packageNameOf(s) ?? ''))}}
    },
    configResolved(config: ResolvedConfig) {
      isBuild = config.command === 'build'
      // Vite's resolver, not Node's: the browser conditions decide which entry
      // the bundler sees, and the kind and the export names must follow it.
      const viteResolve = config.createResolver()
      resolveFile = async specifier => {
        const file = await viteResolve(specifier, undefined, false, false)
        if (!file) throw new Error(`vendor-import-map: cannot resolve ${specifier}`)
        return file.split('?')[0]
      }
    },
    async options(opts) {
      if (!isBuild) return null
      if (!opts.input || typeof opts.input !== 'object' || Array.isArray(opts.input)) {
        throw new Error('vendor-import-map: expects the build input to be a name → id record')
      }
      const input: Record<string, string> = {...(opts.input as Record<string, string>)}
      for (const specifier of exposed) {
        const {kind} = await resolve(specifier)
        input[vendorInputName(specifier)] = kind === 'cjs' ? CJS_INPUT_PREFIX + specifier : specifier
      }
      return {...opts, input}
    },
    // Only an EXPOSED specifier becomes a facade id: the dev URL is attacker
    // shaped (`/vendor//abs/path.js` would otherwise resolve, and a CommonJS
    // verdict would `require` that file). Filtered so the hook never runs for
    // the rest of the graph.
    resolveId: {
      filter: {id: [DEV_URL_PATTERN, new RegExp(`^${CJS_INPUT_PREFIX}`)]},
      handler(source) {
        const specifier = source.startsWith(CJS_INPUT_PREFIX)
          ? source.slice(CJS_INPUT_PREFIX.length)
          : DEV_URL_PATTERN.exec(source)?.[1]
        return specifier && exposedSet.has(specifier) ? facadeId(specifier) : null
      },
    },
    async load(id) {
      const specifier = facadeSpecifier(id)
      if (!specifier) return null
      const {file, kind} = await resolve(specifier)
      return facadeSource(specifier, file, kind)
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
