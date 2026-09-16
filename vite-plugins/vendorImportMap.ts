/**
 * Bundled dependencies as importmap entries for dynamic extensions.
 *
 * A block-installed extension resolves imports through the page importmap,
 * which maps `@/` and the React family only — so `import {Decoration} from
 * '@codemirror/view'` fails to resolve, and bundling a private copy into the
 * extension fails later: CodeMirror checks extension values against ITS
 * classes, so a ViewPlugin from a second `@codemirror/state` is "Unrecognized
 * extension value". The requirement is identity: the extension must land on
 * the module instance the running app uses.
 *
 * The exposed set is package.json `dependencies` — the root's direct runtime
 * dependencies, minus the rule in `isExposed`. One owner for the list, and it
 * is already reviewed on every change. Deriving it from the module graph
 * instead (every package any bundled package imports) was rejected: an
 * extension would then depend on a version some intermediate package pins,
 * and the surface would shift on a routine dependency bump. A transitive
 * package an extension needs is exposed by adding it to `dependencies`.
 *
 * Build: `vendorInputs` adds each package as a Rollup input at
 * `vendor/<pkg>` — the same shape the `src/**` entries take, so each emits as a
 * thin facade re-exporting from the boot chunk — and the plugin adds
 * `"<pkg>": "./vendor/<pkg>.js"` to the importmap. (Emitting the chunks from a
 * plugin hook instead of declaring them as inputs deadlocks rolldown when done
 * from `resolveId`; inputs are the supported path.)
 *
 * Dev: `/vendor/<pkg>.js` is a virtual `export * from '<pkg>'` module that goes
 * through Vite's own import analysis, so it rewrites to the same
 * `/node_modules/.vite/deps/…?v=` URL the kernel's imports use. Two instances
 * in dev would fail exactly like production, silently.
 *
 * Top-level package names only (`zod`, `@codemirror/view`); subpaths are not
 * mapped. Never exposed: the React family (on esm.sh, external to the bundle),
 * `workspace:` packages (source-aliased), and `@types/*`.
 */
import fs from 'node:fs'
import path from 'node:path'
import type {Plugin} from 'vite'
import {rewriteImportMapScript} from './importMapHtml'

export const VENDOR_DIR = 'vendor'
const VIRTUAL_PREFIX = '\0km-vendor:'
const VIRTUAL_ID_PATTERN = /^\0km-vendor:/
const DEV_URL_PATTERN = /^\/vendor\/(.+)\.js$/

export const vendorFileName = (pkg: string): string => `${VENDOR_DIR}/${pkg}.js`

/** Importmap `imports` for a set of packages, keyed by bare name. Relative to
 *  the document, like the `"@/": "./src/"` entry beside them. */
export const vendorImports = (pkgs: Iterable<string>): Record<string, string> =>
  Object.fromEntries([...pkgs].sort().map(pkg => [pkg, `./${vendorFileName(pkg)}`]))

const isReactFamily = (pkg: string): boolean => pkg === 'react' || pkg === 'react-dom'

type PackageJson = {dependencies?: Record<string, string>}

const readPackageJson = (dir: string): PackageJson | undefined => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as PackageJson
  } catch {
    return undefined
  }
}

const isExposed = (pkg: string, versionSpec: string): boolean =>
  !isReactFamily(pkg) && !pkg.startsWith('@types/') && !versionSpec.startsWith('workspace:')

/** The packages this build exposes, sorted. */
export const exposedVendorPackages = (rootDir: string): string[] =>
  Object.entries(readPackageJson(rootDir)?.dependencies ?? {})
    .filter(([pkg, spec]) => isExposed(pkg, spec))
    .map(([pkg]) => pkg)
    .sort()

/** Rollup inputs for the facades: spread next to the `src/**` entries. The
 *  value is the bare specifier, so rolldown resolves it exactly as the app's
 *  own import of the package does. */
export const vendorInputs = (rootDir: string): Record<string, string> =>
  Object.fromEntries(exposedVendorPackages(rootDir).map(pkg => [`${VENDOR_DIR}/${pkg}`, pkg]))

export const vendorImportMapPlugin = ({rootDir}: {rootDir: string}): Plugin => {
  const exposed = exposedVendorPackages(rootDir)
  return {
    name: 'vendor-import-map',
    // Before Vite's resolver, which would otherwise try `/vendor/…` as a file.
    enforce: 'pre',
    // Filtered so the hooks never run for the rest of the graph; only a
    // `/vendor/…` request (dev) reaches them.
    resolveId: {
      filter: {id: DEV_URL_PATTERN},
      handler(source) {
        const match = DEV_URL_PATTERN.exec(source)
        return match ? VIRTUAL_PREFIX + match[1] : null
      },
    },
    load: {
      filter: {id: VIRTUAL_ID_PATTERN},
      handler(id) {
        const pkg = JSON.stringify(id.slice(VIRTUAL_PREFIX.length))
        // `export *` never forwards `default`; the namespace read makes it a
        // plain `undefined` for a package without one instead of a load error.
        return `import * as m from ${pkg};\nexport * from ${pkg};\nexport default m.default;\n`
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
