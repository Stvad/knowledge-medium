import {createRequire} from 'node:module'
import path from 'node:path'
import {describe, expect, it} from 'vitest'
import {pageImports, REPO_ROOT} from '@/test/pageImportMap'

const require = createRequire(import.meta.url)

// Tests run in node, where `react-dom/server` resolves to the Node build; the
// page bundles the browser one.
const pageBuildOf: Record<string, string> = {'react-dom/server': 'react-dom/server.browser'}

const facadeEntries = Object.entries(pageImports).filter(([, target]) => target.startsWith('./src/vendor/'))

const sorted = (names: Iterable<string>): string[] => [...names].sort()

describe('importmap facades over bundled React', () => {
  it('maps the React specifiers the app and its extensions import', () => {
    expect(sorted(facadeEntries.map(([specifier]) => specifier))).toEqual([
      'react', 'react-dom', 'react-dom/client', 'react-dom/server', 'react/compiler-runtime', 'react/jsx-runtime',
    ])
  })

  it.each(facadeEntries)('%s re-exports every export of the module (%s)', async (specifier, target) => {
    const facade = await import(/* @vite-ignore */ path.join(REPO_ROOT, target)) as object
    // The CommonJS exports object, read directly: the facade's list exists
    // because the bundler cannot see these names, so derive them from runtime.
    const real = require(pageBuildOf[specifier] ?? specifier) as object
    expect(sorted(Object.keys(facade)), `update ${target} to match ${specifier}`)
      .toEqual(sorted([...Object.keys(real), 'default']))
  })
})
