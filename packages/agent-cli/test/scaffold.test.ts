// @vitest-environment node
//
// The scaffold is a teaching artifact: whatever shape it emits is the shape
// authors keep. So it has to stay canonical — which means the extension lint
// must find nothing to say about it, and the naming has to survive the
// awkward inputs people actually type.

import {describe, expect, it} from 'vitest'
import {extensionScaffold, slugify, titleize} from '../src/scaffold'
import {lintExtensionSource} from '@/plugins/agent-runtime/extensionLint'

const scaffold = (name = 'Reading List') => {
  const files = extensionScaffold(name)
  return {
    files,
    byPath: new Map(files.map(file => [file.path, file.contents])),
    /** Every generated TS source, as the lint would see an installed
     *  bundle: one text to scan. */
    source: files
      .filter(file => file.path.endsWith('.ts'))
      .map(file => file.contents)
      .join('\n'),
  }
}

describe('extensionScaffold', () => {
  it('emits an extension the data-model lint has nothing to say about', () => {
    expect(lintExtensionSource(scaffold().source)).toEqual([])
  })

  it('models a pointer as a ref, not an id string', () => {
    const schema = scaffold().byPath.get('src/schema.ts')!
    expect(schema).toMatch(/preset: 'optional-ref'/)
    expect(schema).toMatch(/targetTypes: \[COLLECTION_TYPE\]/)
  })

  it('writes records as blocks and composes the built-in todo', () => {
    const store = scaffold().byPath.get('src/store.ts')!
    expect(store).toMatch(/createTypedChild/)
    expect(store).toMatch(/types: \[ENTRY_TYPE, TODO_TYPE\]/)
    // …rather than declaring a private done flag of its own.
    expect(scaffold().byPath.get('src/schema.ts')!).not.toMatch(/name: '[^']*(done|completed)/i)
  })

  it('namespaces every declared type id and property name with the WHOLE slug', () => {
    // `reading-list` and `reading-notes` must not both claim `reading:rating`
    // — property names are global, and the loser silently gets the other's
    // codec. That's the collision the scaffold's own doctrine warns about.
    const fields = scaffold().byPath.get('src/fields.ts')!
    expect(fields).toMatch(/ENTRY_TYPE = 'reading-list-entry'/)
    expect(fields).toMatch(/rating: 'reading-list:rating'/)
    expect(scaffold('Reading Notes').byPath.get('src/fields.ts')!).toMatch(/rating: 'reading-notes:rating'/)
  })

  it('ships a runnable gate and a test', () => {
    const {byPath} = scaffold()
    expect(JSON.parse(byPath.get('package.json')!).scripts.check)
      .toBe('npm run typecheck && npm run test && npm run build')
    expect(byPath.get('test/read.test.ts')).toMatch(/describe\('buildEntries'/)
  })

  it('stands alone: own dependencies, own `@/` declarations, no repo paths', () => {
    const {byPath, files} = scaffold()
    const pkg = JSON.parse(byPath.get('package.json')!)
    // The published CLI is most authors' only foothold — nothing may resolve
    // through a checkout of the app.
    for (const file of files) {
      expect(file.contents, `${file.path} reaches out of the project`).not.toMatch(/\.\.\/\.\.\/node_modules/)
    }
    expect(pkg.devDependencies).toMatchObject({typescript: expect.any(String), vite: expect.any(String), vitest: expect.any(String)})
    expect(pkg.scripts.types).toMatch(/kmagent types/)
    expect(JSON.parse(byPath.get('tsconfig.json')!).compilerOptions.paths['@/*']).toEqual(['./types/src/*'])
    expect(byPath.get('.gitignore')).toMatch(/^types\/$/m)
  })

  it('tells the author how to install with the CLI, not with repo tooling', () => {
    const readme = scaffold().byPath.get('README.md')!
    expect(readme).toMatch(/kmagent install-extension "dist\/Reading List\.js"/)
    expect(readme).toMatch(/kmagent enable-extension "Reading List"/)
    expect(readme).not.toMatch(/pnpm agent/)
  })

  it('names the bundle after the display name so install/enable use one handle', () => {
    expect(scaffold().byPath.get('vite.config.ts')).toMatch(/fileName: \(\) => 'Reading List\.js'/)
  })
})

describe('naming', () => {
  it('slugifies messy input', () => {
    expect(slugify('Reading List')).toBe('reading-list')
    expect(slugify('  My  Cool_Extension!! ')).toBe('my-cool-extension')
    expect(slugify('already-fine')).toBe('already-fine')
  })

  it('round-trips a slug back to a display name', () => {
    expect(titleize('reading-list')).toBe('Reading List')
  })

  it('refuses a name with nothing to slugify', () => {
    expect(() => extensionScaffold('!!!')).toThrow(/at least one letter or digit/)
  })
})
