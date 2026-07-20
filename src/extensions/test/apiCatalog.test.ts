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
// aren't checked here (erased at runtime) — `yarn run check`'s tsc covers the
// modules, and `kmagent types` is the authoritative type surface.

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
