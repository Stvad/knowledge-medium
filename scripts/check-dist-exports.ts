/**
 * Post-build gate: every export the extension API catalog names must survive
 * into the emitted module.
 *
 * The failure is SILENT: `preserveModules` writes each module to its own path
 * whether or not its exports survived, so a dropped export leaves the file —
 * and the extension's `import` — perfectly resolvable, just missing the
 * binding.
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

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(rootDir, 'dist')

if (!fs.existsSync(distDir)) {
  console.error('[check-dist-exports] no dist/ — run the build first')
  process.exit(1)
}

/** Public names in a module's `export{…}` clauses.
 *
 *  Scoped to the clause on purpose. Scanning the whole file for the bare name
 *  passes on any other occurrence of it — an object key, an error string, a
 *  module specifier — and measurably did: 10 of the 116 cataloged names
 *  survived deletion of their own export, two modules with their entire
 *  cataloged surface undetectable. Rollup emits `export{local as Public}`
 *  uniformly here; the bare `export{Public}` form is handled for safety. */
const emittedExportNames = (text: string): Set<string> => {
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
