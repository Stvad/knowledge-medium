import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extensionApiCatalog } from '@/extensions/apiCatalog'

// Drift guard for the curated extension-API catalog (`apiCatalog.ts`), which
// replaced the `@/extensions/api.js` re-export barrel. The catalog names, per
// real module, the runtime symbols extensions are blessed to import. If one is
// renamed / moved / deleted, an extension (or a catalog example) that imports
// it breaks at LOAD time — in the user's browser, not in CI. This test loads
// each module and asserts every listed runtime export still exists on it.
//
// It does NOT assert the reverse: a module may export more than the catalog
// lists. The catalog is a curated subset, not a mirror. Type-only exports
// aren't checked HERE (erased at runtime); they're drift-guarded separately by
// `apiCatalogTypeParity.ts` (a tsc-checked re-export fixture) plus the coverage
// test below. `kmagent types` remains the authoritative type surface.

// Blob extensions write `@/dir/name.js`; vitest resolves the extensionless
// `@/dir/name` form. Strip the trailing `.js` so both single-file and
// directory-index (`@/data/api/index.js`) specifiers resolve to their source.
const runtimeSpecifier = (importPath: string): string =>
  importPath.replace(/\.js$/, '')

describe('extensionApiCatalog — runtime export drift guard', () => {
  it('has unique importPaths', () => {
    const paths = extensionApiCatalog.map(group => group.importPath)
    expect(new Set(paths).size, 'duplicate importPath in catalog').toBe(paths.length)
  })

  for (const group of extensionApiCatalog) {
    it(`${group.importPath} exports every listed runtime symbol`, async () => {
      const module = await import(/* @vite-ignore */ runtimeSpecifier(group.importPath)) as Record<string, unknown>
      const missing = group.exports.filter(name => !(name in module))
      expect(missing, `${group.importPath} is missing runtime export(s): ${missing.join(', ')}`).toEqual([])
      for (const name of group.exports) {
        expect(module[name], `${group.importPath}#${name} re-exports as undefined`).toBeDefined()
      }
    })
  }
})

// The runtime drift guard above resolves through vitest/Vite, which is
// extension-lenient (it'll happily resolve `@/data/api` to the directory
// index). Production is NOT: blob extensions resolve `@/x` through the
// importmap + service worker, which serves the EXACT emitted filename
// (`preserveModules` emits `<name>.js` from `<name>.ts`). So a catalog
// importPath must map back to a real single source file:
//   `@/dir/name.js`        → src/dir/name.ts(x)
//   `@/dir/name/index.js`  → src/dir/name/index.ts(x)   (directory module)
// A directory written without `/index.js` (or a file written WITH it) passes
// Vite and tsc yet 404s in the browser. This guards the form independently.
describe('extensionApiCatalog — importPath maps to an exact emitted file', () => {
  for (const group of extensionApiCatalog) {
    it(`${group.importPath} resolves to a real source file`, () => {
      const base = group.importPath.replace(/^@\//, 'src/').replace(/\.js$/, '')
      const exists =
        existsSync(resolve(process.cwd(), `${base}.ts`)) ||
        existsSync(resolve(process.cwd(), `${base}.tsx`))
      expect(exists, `${group.importPath} does not map to an emitted source file (${base}.ts[x]); wrong single-file vs directory-index form?`).toBe(true)
    })
  }
})

// `apiCatalogTypeParity.ts` re-exports every catalog type from its module, so
// `tsc -b` (in `yarn run check`) fails if a listed type is renamed/removed —
// restoring the guarantee the barrel's `export type { … }` gave. This asserts
// the complementary direction: every `types[]` name in the catalog is actually
// covered there, under the matching module, so the tsc guard can't miss one.
describe('extensionApiCatalog — type surface is drift-guarded', () => {
  const parityByPath = new Map<string, Set<string>>()
  const EXPORT_TYPE_RE = /export\s+type\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g
  const paritySource = readFileSync(
    resolve(process.cwd(), 'src/extensions/test/apiCatalogTypeParity.ts'),
    'utf8',
  )
  for (const match of paritySource.matchAll(EXPORT_TYPE_RE)) {
    const names = new Set((match[1] ?? '').split(',').map(name => name.trim()).filter(Boolean))
    parityByPath.set(match[2] ?? '', names)
  }

  for (const group of extensionApiCatalog) {
    if (group.types.length === 0) continue
    it(`${group.importPath} type exports are all re-exported by apiCatalogTypeParity.ts`, () => {
      const covered = parityByPath.get(group.importPath) ?? new Set<string>()
      const missing = group.types.filter(name => !covered.has(name))
      expect(missing, `add to apiCatalogTypeParity.ts under ${group.importPath}: ${missing.join(', ')}`).toEqual([])
    })
  }
})
