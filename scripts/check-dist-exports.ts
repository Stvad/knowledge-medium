/**
 * Post-build gate: every export the extension API catalog names must survive
 * into the emitted module.
 *
 * This exists because the failure it catches is SILENT. `preserveModules`
 * writes each module to its own path whether or not its exports survived, so a
 * tree-shaken export leaves the file — and therefore the extension's `import`
 * — perfectly resolvable, just missing the binding. An extension that
 * feature-detects (`'X' in mod`) reads that as "seam absent" and does nothing;
 * one that imports directly gets `undefined`, usually surfacing much later as
 * `undefined is not a component`.
 *
 * It has to run against `dist/`. `apiCatalog.test.ts` makes the same assertion
 * under vitest and passed through the whole incident, because vitest resolves
 * source, where no tree-shaking has happened. Source-level checks are
 * structurally blind to this class of bug.
 *
 * The catalog is used here as a TRIPWIRE, not as a whitelist: retention is a
 * property of the build config (every internal module is an entry), and this
 * only samples the surface we can name to prove that config still holds.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extensionApiCatalog } from '../src/extensions/apiCatalog'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(rootDir, 'dist')

if (!fs.existsSync(distDir)) {
  console.error('[check-dist-exports] no dist/ — run the build first')
  process.exit(1)
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
  const emitted = fs.readFileSync(file, 'utf8')
  for (const name of group.exports) {
    checked++
    // Minified output renames locals and re-exports as `export{a as Name}`, so
    // the public name is still present verbatim; a dropped export is simply gone.
    if (!new RegExp(`\\b${name}\\b`).test(emitted)) missing.push(`${rel} :: ${name}`)
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
