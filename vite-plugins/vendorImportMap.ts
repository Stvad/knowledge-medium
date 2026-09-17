/**
 * Bundled dependencies as importmap entries for dynamic extensions.
 *
 * A block-installed extension resolves imports only through the page
 * importmap, and whatever it imports must be the module instance the running
 * app uses: CodeMirror checks extension values against ITS classes, so a
 * ViewPlugin from a second `@codemirror/state` is "Unrecognized extension
 * value", and a second React has no hooks state. React is on this path like
 * every other dependency.
 *
 * The exposed set is package.json `dependencies` (minus `isExposed`) plus the
 * subpaths the app's own source imports (`react-dom/client`) and the JSX
 * runtime the build injects without any source naming it. Not the module
 * graph — an extension would then depend on a version some intermediate
 * package pins; a transitive package an extension needs is added to
 * `dependencies`. Not each package's `exports` map — across this dependency
 * set that is UMD builds, node variants, CSS and unresolvable `./types`.
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
 * to link. The shim re-exports each name Node sees on the module, evaluated
 * from the SAME file Vite's build resolver picks — Node's own conditions choose
 * a dual package's CommonJS entry, and `react-dom/server`'s node build has
 * names its browser build lacks.
 *
 * Dev: `/vendor/<specifier>.js` is a virtual module Vite's import analysis
 * rewrites onto the same `/node_modules/.vite/deps/…?v=` URL the kernel's
 * imports use. Two instances in dev would fail exactly like production.
 */
import fs from 'node:fs'
import {globSync} from 'node:fs'
import {createRequire} from 'node:module'
import path from 'node:path'
import type {Plugin, ResolvedConfig} from 'vite'
import {rewriteImportMapScript} from './importMapHtml'
import {SRC_ENTRY_EXCLUDE, SRC_ENTRY_GLOB} from './srcEntries'

export const VENDOR_DIR = 'vendor'
const DEV_URL_PATTERN = /^\/vendor\/(.+)\.js$/
const DEV_ID_PREFIX = '\0km-vendor:'
const CJS_INPUT_PREFIX = 'virtual:km-vendor-cjs/'
const CJS_ID_PREFIX = `\0${CJS_INPUT_PREFIX}`

/** The automatic JSX runtime `@vitejs/plugin-react` emits into every
 *  transformed module; no source file names it. Applies when `react` is a
 *  dependency. The dev-only `react/jsx-dev-runtime` is deliberately absent:
 *  the production build ships a stub of it (`jsxDEV: undefined`), and a bundle
 *  built with a development JSX transform is better off failing to resolve
 *  than calling undefined. */
const BUILD_INJECTED_SPECIFIERS = ['react/jsx-runtime', 'react/compiler-runtime']

const vendorFileName = (specifier: string): string => `${VENDOR_DIR}/${specifier}.js`

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
  !pkg.startsWith('@types/') && !versionSpec.startsWith('workspace:')

/** The packages this build exposes, sorted. */
export const exposedVendorPackages = (rootDir: string): string[] =>
  Object.entries(readPackageJson(rootDir)?.dependencies ?? {})
    .filter(([pkg, spec]) => isExposed(pkg, spec))
    .map(([pkg]) => pkg)
    .sort()

const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g
const TYPE_ONLY_IMPORT = /\bimport\s+type\b[^;]*?from\s*['"][^'"]+['"]/g
const SPECIFIER = /\b(?:from|import)\s*\(?\s*['"]([^'"\n]+)['"]/g

const readSourceFiles = (rootDir: string): string[] =>
  globSync(SRC_ENTRY_GLOB, {cwd: rootDir, exclude: SRC_ENTRY_EXCLUDE})
    .map(file => fs.readFileSync(path.join(rootDir, file), 'utf8'))

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

/** Named exports Node sees on a CommonJS file, `default`/`__esModule` aside.
 *  Evaluates under this process's NODE_ENV, which is the build the bundler
 *  picks too. Loud on failure: a shim with no names is the link error this
 *  exists to prevent, one step later. */
const cjsExportNames = (file: string): string[] => {
  let mod: unknown
  try {
    mod = createRequire(file)(file) as unknown
  } catch (err) {
    throw new Error(
      `vendor-import-map: cannot require ${file} to enumerate its CommonJS exports; ` +
        'a browser-only CommonJS dependency needs an ESM entry or an exclusion in isExposed',
      {cause: err},
    )
  }
  if (typeof mod !== 'object' && typeof mod !== 'function') return []
  return Object.keys(mod as object).filter(k => IDENTIFIER.test(k) && k !== 'default' && k !== '__esModule').sort()
}

/** The shim for a CommonJS package: `module.exports` as `default`, each name
 *  destructured off it under a local alias and exported under its own name.
 *  The alias form is what lets a reserved word (`catch`, `enum`) be an export
 *  name, which shorthand destructuring cannot. `m` is the bundler's own module
 *  object in both modes. */
export const cjsShimSource = (specifier: string, names: readonly string[]): string => {
  const from = JSON.stringify(specifier)
  if (names.length === 0) return `import m from ${from};\nexport default m;\n`
  const locals = names.map((_, i) => `_${i}`)
  const destructure = names.map((name, i) => `${name}: ${locals[i]}`).join(', ')
  const exports = names.map((name, i) => `${locals[i]} as ${name}`).join(', ')
  return `import m from ${from};\nexport default m;\nconst {${destructure}} = m;\nexport {${exports}};\n`
}

/** The dev facade for an ESM package. `export *` never forwards `default`;
 *  the namespace read makes it a plain `undefined` for a package without one
 *  instead of a load error. */
export const esmFacadeSource = (specifier: string): string => {
  const from = JSON.stringify(specifier)
  return `import * as m from ${from};\nexport * from ${from};\nexport default m.default;\n`
}

/** Facade source for `specifier` given the file the bundler resolves it to. */
export const facadeSource = (specifier: string, file: string): string =>
  moduleKind(file) === 'cjs' ? cjsShimSource(specifier, cjsExportNames(file)) : esmFacadeSource(specifier)

export const vendorImportMapPlugin = ({rootDir}: {rootDir: string}): Plugin => {
  const exposed = exposedVendorSpecifiers(rootDir)
  let isBuild = false
  let resolveFile: ((specifier: string) => Promise<string>) | undefined
  const files = new Map<string, string>()
  const fileOf = async (specifier: string): Promise<string> => {
    let file = files.get(specifier)
    if (!file) {
      if (!resolveFile) throw new Error('vendor-import-map: resolver used before configResolved')
      file = await resolveFile(specifier)
      files.set(specifier, file)
    }
    return file
  }

  return {
    name: 'vendor-import-map',
    // Before Vite's resolver, which would otherwise try `/vendor/…` as a file.
    enforce: 'pre',
    configResolved(config: ResolvedConfig) {
      isBuild = config.command === 'build'
      // Vite's resolver, not Node's: the browser conditions decide which entry
      // the bundler sees, and the kind and the export names must follow it.
      const resolve = config.createResolver()
      resolveFile = async specifier => {
        const file = await resolve(specifier, undefined, false, false)
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
        const kind = moduleKind(await fileOf(specifier))
        input[`${VENDOR_DIR}/${specifier}`] = kind === 'cjs' ? CJS_INPUT_PREFIX + specifier : specifier
      }
      return {...opts, input}
    },
    // Filtered so the hook never runs for the rest of the graph.
    resolveId: {
      filter: {id: [DEV_URL_PATTERN, new RegExp(`^${CJS_INPUT_PREFIX}`)]},
      handler(source) {
        if (source.startsWith(CJS_INPUT_PREFIX)) return `\0${source}`
        const match = DEV_URL_PATTERN.exec(source)
        return match ? DEV_ID_PREFIX + match[1] : null
      },
    },
    async load(id) {
      if (id.startsWith(CJS_ID_PREFIX)) {
        const specifier = id.slice(CJS_ID_PREFIX.length)
        return cjsShimSource(specifier, cjsExportNames(await fileOf(specifier)))
      }
      if (id.startsWith(DEV_ID_PREFIX)) {
        const specifier = id.slice(DEV_ID_PREFIX.length)
        return facadeSource(specifier, await fileOf(specifier))
      }
      return null
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
