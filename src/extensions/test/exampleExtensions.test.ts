import { describe, expect, it } from 'vitest'
import * as Babel from '@babel/standalone'
import { exampleExtensions } from '@/extensions/exampleExtensions'

// Catches typos in the templated extension sources. Templated strings
// bypass TypeScript's checker, so without this any malformed JSX or
// import would only surface at workspace seed / command-palette
// invocation time.
describe('exampleExtensions — templated sources', () => {
  for (const {id, source} of exampleExtensions) {
    it(`${id} transpiles via Babel (react + typescript) without error`, () => {
      expect(() =>
        Babel.transform(source, {
          filename: `${id}.tsx`,
          presets: ['react', 'typescript'],
        }),
      ).not.toThrow()
    })
  }
})
