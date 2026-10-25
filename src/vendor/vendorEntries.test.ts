import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import path from 'node:path'
import {describe, expect, it} from 'vitest'
import {pageImports, REPO_ROOT} from '@/test/pageImportMap'

const require = createRequire(import.meta.url)

const REACT_PACKAGES = ['react', 'react-dom']
// A second, profiling renderer: decided against shipping it to every client.
const NOT_MAPPED = new Set(['react-dom/profiling'])

type ExportTarget = string | Record<string, string>

/** Every module subpath a React package exports, with the file a browser
 *  bundler resolves it to (the `browser` condition, else `default`). */
const exportedSubpaths = (pkg: string): Array<{specifier: string; file: string}> => {
  const pkgDir = path.dirname(require.resolve(`${pkg}/package.json`))
  const {exports} = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as {exports: Record<string, ExportTarget>}
  return Object.entries(exports)
    .filter(([subpath]) => subpath !== './package.json')
    .map(([subpath, target]) => ({
      specifier: subpath === '.' ? pkg : `${pkg}/${subpath.slice(2)}`,
      file: path.join(pkgDir, typeof target === 'string' ? target : target.browser ?? target.default),
    }))
}

/** True when the file, or a file it requires, requires a module outside
 *  React's packages — a Node built-in such as `stream`, which no browser has. */
const needsNode = (file: string, seen = new Set<string>()): boolean => {
  if (seen.has(file)) return false
  seen.add(file)
  for (const [, required] of readFileSync(file, 'utf8').matchAll(/require\(["']([^"']+)["']\)/g)) {
    if (required.startsWith('.')) {
      if (needsNode(path.resolve(path.dirname(file), required), seen)) return true
    } else if (![...REACT_PACKAGES, 'scheduler'].includes(required)) {
      return true
    }
  }
  return false
}

const browserSubpaths = REACT_PACKAGES.flatMap(exportedSubpaths)
  .filter(({specifier, file}) => !NOT_MAPPED.has(specifier) && !needsNode(file))
const fileOf = new Map(browserSubpaths.map(({specifier, file}) => [specifier, file]))

const facadeEntries = Object.entries(pageImports).filter(([, target]) => target.startsWith('./src/vendor/'))

const sorted = (names: Iterable<string>): string[] => [...names].sort()

describe('importmap facades over bundled React', () => {
  it('maps every subpath React exports that runs in a browser', () => {
    expect(sorted(facadeEntries.map(([specifier]) => specifier)), 'add or remove index.html importmap entries')
      .toEqual(sorted(fileOf.keys()))
  })

  it.each(facadeEntries)('%s re-exports every export of the module (%s)', async (specifier, target) => {
    const facade = await import(/* @vite-ignore */ path.join(REPO_ROOT, target)) as object
    // The CommonJS exports object, read directly: the facade's list exists
    // because the bundler cannot see these names, so derive them from runtime.
    const real = require(fileOf.get(specifier) ?? specifier) as object
    expect(sorted(Object.keys(facade)), `update ${target} to match ${specifier}`)
      .toEqual(sorted([...Object.keys(real), 'default']))
  })
})
