import {describe, expect, it} from 'vitest'
import {importedSpecifiers} from '@knowledge-medium/agent-cli/extensionImportSyntax'
import {evaluateExampleModule, fixtureHygieneProblems, parseFixture} from '@/test/exampleModuleResolver'

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

    expect(importedSpecifiers(parseFixture(source, 'fixture.ts'), true)).toEqual([
      '@/static.js',
      '@/reexport.js',
      '@/star.js',
      '@/import-equals.js',
      '@/require.js',
      '@/dynamic-template.js',
      '@/dynamic.js',
      undefined,
    ])
  })
})

describe('evaluateExampleModule', () => {
  it('preloads side-effect imports and skips source text that only quotes an import', async () => {
    const fixture = await evaluateExampleModule(`
      import '@/extensions/core.js'
      // import {anything} from 'made-up-package'
      export default { extensions: [] }
    `, 'fixture.tsx')
    expect(fixture).toEqual({extensions: []})
  })
})

describe('fixtureHygieneProblems', () => {
  it('uses the production entry set for CommonJS references', () => {
    expect(fixtureHygieneProblems({
      'fixture.ts': `
        const allowed = require('@/extensions/core.js')
        import missing = require('@/test/setup.js')
        const computed = require(name)
      `,
    }).badSpecifiers).toEqual(['fixture.ts: @/test/setup.js', 'fixture.ts: <computed>'])
  })
})
