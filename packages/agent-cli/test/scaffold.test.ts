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

  it('namespaces every declared type id and property name', () => {
    const fields = scaffold().byPath.get('src/fields.ts')!
    expect(fields).toMatch(/ENTRY_TYPE = 'reading-list-entry'/)
    expect(fields).toMatch(/rating: 'reading:rating'/)
  })

  it('ships a runnable gate and a test', () => {
    const {byPath} = scaffold()
    expect(JSON.parse(byPath.get('package.json')!).scripts.check)
      .toBe('pnpm run typecheck && pnpm run test && pnpm run build')
    expect(byPath.get('test/read.test.ts')).toMatch(/describe\('buildEntries'/)
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
