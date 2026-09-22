/**
 * Post-build gate, three contracts: every export the extension API catalog
 * names must survive into the emitted module; the boot graph must have bundled
 * into one chunk; and every vendor facade the importmap names must be a pure
 * re-export over chunks the app ships.
 *
 * The failure is SILENT: every module is a build entry written to its own
 * path whether or not its exports survived, so a dropped export leaves the
 * file — and the extension's `import` — perfectly resolvable, just missing
 * the binding.
 *
 * It has to run against `dist/`. `apiCatalog.test.ts` makes the same assertion
 * under vitest, which resolves source, where no tree-shaking has happened;
 * source-level checks are structurally blind to this class of bug.
 *
 * The catalog is used here as a TRIPWIRE, not as a whitelist: retention is a
 * property of the build config (every internal module is an entry), and this
 * only samples the surface we can name to prove that config still holds.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extensionApiCatalog } from '../src/extensions/apiCatalog'
import { facadeImportTargets, facadeResidue } from '../vite-plugins/facadeShape'
import { readImportMap } from '../vite-plugins/importMapHtml'
import { VENDOR_DIR } from '../vite-plugins/vendorImportMap'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(rootDir, 'dist')

const fail = (message: string): never => {
  console.error(`[check-dist-exports] ${message}`)
  process.exit(1)
}

if (!fs.existsSync(distDir)) fail('no dist/ — run the build first')

/** Public names in a module's `export{…}` clauses.
 *
 *  Scoped to the clause on purpose. Scanning the whole file for the bare name
 *  passes on any other occurrence of it — an object key, an error string, a
 *  module specifier — and measurably did: 10 of the 116 cataloged names
 *  survived deletion of their own export, two modules with their entire
 *  cataloged surface undetectable. Rollup emits `export{local as Public}`
 *  uniformly here; the bare `export{Public}` form is handled for safety.
 *
 *  Known limit: a clause appearing inside a STRING would be counted. No
 *  cataloged module embeds source text (checked: all have exactly one clause),
 *  and the error can only ever add a phantom name — a false pass, never a
 *  false failure. `export * from` is rejected outright below rather than
 *  silently under-reported, since it would hide names this cannot see. */
const emittedExportNames = (text: string): Set<string> => {
  if (/\bexport\s*\*\s*from/.test(text)) {
    throw new Error('star re-export found; this parser cannot see the names it forwards')
  }
  const names = new Set<string>()
  for (const [, clause] of text.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const spec of clause.split(',')) {
      const name = spec.includes(' as ') ? spec.split(' as ').pop() : spec
      const trimmed = name?.trim()
      if (trimmed) names.add(trimmed)
    }
  }
  return names
}

const missing: string[] = []
const unresolved: string[] = []
let checked = 0

for (const group of extensionApiCatalog) {
  const rel = group.importPath.replace(/^@\//, 'src/')
  const file = path.join(distDir, rel)
  if (!fs.existsSync(file)) {
    unresolved.push(rel)
    continue
  }
  const exported = emittedExportNames(fs.readFileSync(file, 'utf8'))
  for (const name of group.exports) {
    checked++
    if (!exported.has(name)) missing.push(`${rel} :: ${name}`)
  }
}

if (unresolved.length) {
  console.error(`[check-dist-exports] ${unresolved.length} cataloged module(s) not emitted:`)
  for (const m of unresolved) console.error(`  ${m}`)
}
if (missing.length) {
  console.error(`[check-dist-exports] ${missing.length} cataloged export(s) missing from dist:`)
  for (const m of missing) console.error(`  ${m}`)
  console.error('\nThese resolve at import time but have no binding — extensions see undefined.')
  console.error('Check that every internal module is still a Rollup input (vite.config.ts).')
}
if (unresolved.length || missing.length) process.exit(1)

console.log(`[check-dist-exports] ${checked} cataloged exports present across ${extensionApiCatalog.length} modules.`)

// Shape gate for the boot-graph chunk (vite.config.ts `codeSplitting`): the app
// entry must be a facade over one `chunks/app-*.js`, and the HTML must load one
// module script. If the chunk group were silently inert (a renamed entry, an
// option rename) the build would still succeed and ship ~1,500 boot files.
for (const rel of ['src/main.js', 'chunks', 'index.html']) {
  if (!fs.existsSync(path.join(distDir, rel))) fail(`dist/${rel} is missing`)
}
const mainFacade = fs.readFileSync(path.join(distDir, 'src/main.js'), 'utf8')
  .replace(/\/\/#\s*sourceMappingURL=.*$/m, '').trim()
if (!/^import\s*["']\.\.\/chunks\/app-[^"']+\.js["'];?$/.test(mainFacade)) {
  fail('src/main.js is not a facade over the app chunk:\n' + mainFacade.slice(0, 300))
}
const appChunks = fs.readdirSync(path.join(distDir, 'chunks')).filter(f => /^app-[^.]+\.js$/.test(f))
if (appChunks.length !== 1) fail(`expected one chunks/app-*.js, found ${appChunks.length}`)
// The group captures the entry's static closure recursively; were that off,
// the chunk would hold main.tsx alone (a few KB) behind the same facade.
const appChunkBytes = fs.statSync(path.join(distDir, 'chunks', appChunks[0])).size
if (appChunkBytes < 1_000_000) fail(`chunks/${appChunks[0]} is ${appChunkBytes} bytes; the boot graph did not bundle into it`)
const moduleScripts = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8').match(/<script[^>]*type="module"[^>]*>/g) ?? []
if (moduleScripts.length !== 1) fail(`expected one <script type="module"> in index.html, found ${moduleScripts.length}`)

console.log(`[check-dist-exports] boot shape: one app chunk, a facade entry, one module script.`)

// Vendor facades (vite-plugins/vendorImportMap.ts): every importmap entry must
// point at an emitted file that only re-exports from chunks the app ships —
// one carrying its own copy of the package is the instanceof failure the plugin
// exists to prevent, and it would still resolve. Three entries are also checked
// for a named export: the editor facet's package, a CommonJS shim, and a subpath.
const importMap = readImportMap(fs.readFileSync(path.join(distDir, 'index.html'), 'utf8'))
  ?? fail('dist/index.html has no parseable importmap')
const vendorEntries = Object.entries(importMap.imports ?? {}).filter(([, target]) => target.startsWith(`./${VENDOR_DIR}/`))
if (vendorEntries.length === 0) fail('index.html importmap has no vendor entries; vendorImportMapPlugin did not run')
if (Object.values(importMap.imports ?? {}).some(target => /^https?:/.test(target))) fail('index.html importmap maps a specifier to a remote URL')
const facadeRel = (target: string): string => target.slice('./'.length)
for (const [specifier, target] of vendorEntries) {
  const rel = facadeRel(target)
  const file = path.join(distDir, rel)
  if (!fs.existsSync(file)) fail(`importmap maps ${specifier} to ${target}, which was not emitted`)
  const text = fs.readFileSync(file, 'utf8')
  for (const from of facadeImportTargets(text)) {
    const resolved = path.resolve(path.dirname(file), from)
    if (!resolved.startsWith(path.join(distDir, 'chunks') + path.sep)) fail(`${rel} imports ${from}, not a chunk`)
    if (!fs.existsSync(resolved)) fail(`${rel} imports ${from}, which was not emitted`)
  }
  const residue = facadeResidue(text)
  if (residue) fail(`${rel} carries code of its own, not just re-exports:\n` + residue.slice(0, 300))
}
const vendorSamples: Array<[specifier: string, exportName: string]> = [
  ['@codemirror/view', 'Decoration'],
  ['react', 'createContext'],
  ['react/jsx-runtime', 'jsx'],
]
for (const [specifier, exportName] of vendorSamples) {
  const target = importMap.imports?.[specifier] ?? fail(`index.html importmap does not map ${specifier}`)
  const text = fs.readFileSync(path.join(distDir, facadeRel(target)), 'utf8')
  if (!emittedExportNames(text).has(exportName)) fail(`${target} lacks the ${exportName} export`)
}

console.log(`[check-dist-exports] vendor facades: ${vendorEntries.length} importmap entries re-export from chunks only; ${vendorSamples.length} named samples present.`)
