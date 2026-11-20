import {createRequire} from 'node:module'
import {describe, expect, it} from 'vitest'

// The React Compiler build step (`babel(...)` in vite.config.ts) runs on
// whichever @babel/core satisfies @rolldown/plugin-babel's `^7.29 || ^8` peer.
// babel-plugin-react-compiler supports only Babel 7, and @babel/standalone 8
// brings @babel/core 8 into the graph, so package.json pins @babel/core ^7.
describe('React Compiler build', () => {
  it('runs on Babel 7', () => {
    const pluginEntry = createRequire(import.meta.url).resolve('@rolldown/plugin-babel')
    const {version} = createRequire(pluginEntry)('@babel/core/package.json') as {version: string}
    expect(
      version.split('.')[0],
      'Keep the root @babel/core devDependency on ^7 until babel-plugin-react-compiler ' +
      'supports Babel 8 (#1441), then delete this test.',
    ).toBe('7')
  })
})
