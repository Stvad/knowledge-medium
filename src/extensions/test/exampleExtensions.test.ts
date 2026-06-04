import { describe, expect, it } from 'vitest'
import * as Babel from '@babel/standalone'
import { exampleExtensions } from '@/extensions/exampleExtensions'

// Catches typos in the templated extension sources. Templated strings
// bypass TypeScript's checker, so without this any malformed JSX or
// import would only surface at workspace seed / command-palette
// invocation time.
describe('exampleExtensions — templated sources', () => {
  it('all templated sources transpile via Babel (react + typescript) without error', () => {
    for (const {id, source} of exampleExtensions) {
      expect(() =>
        Babel.transform(source, {
          filename: `${id}.tsx`,
          presets: ['react', 'typescript'],
        }),
        `${id} should transpile`,
      ).not.toThrow()
    }
  })
})
