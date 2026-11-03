import {describe, expect, it} from 'vitest'
import {importedSpecifiers} from '@/test/exampleModuleResolver'

describe('importedSpecifiers', () => {
  it('finds every import form a fixture can use', () => {
    const source = [
      `import {a} from '@/static.js'`,
      `export {b} from '@/reexport.js'`,
      `export * from '@/star.js'`,
      `import c = require('@/import-equals.js')`,
      `const d = require('@/require.js')`,
      'const e = import(`@/dynamic-template.js`)',
      `const f = import('@/dynamic.js')`,
      `const g = import(name)`,
    ].join('\n')

    expect(importedSpecifiers(source, 'fixture.ts')).toEqual([
      '@/static.js',
      '@/reexport.js',
      '@/star.js',
      '@/import-equals.js',
      '@/require.js',
      '@/dynamic-template.js',
      '@/dynamic.js',
      '<computed>',
    ])
  })
})
