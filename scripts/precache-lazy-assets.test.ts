import {describe, expect, it} from 'vitest'
// @ts-expect-error - .mjs build helper without types
import {transitiveClosure} from './precache-lazy-assets.mjs'

/** Build an injected fs from a `{ relPath: source }` map. */
const fakeFs = (files: Record<string, string>) => ({
  exists: (rel: string) => Object.prototype.hasOwnProperty.call(files, rel),
  readFile: (rel: string) => files[rel] ?? '',
})

describe('transitiveClosure', () => {
  it('follows static relative imports transitively (Babel → shared runtime)', () => {
    const fs = fakeFs({
      'node_modules/@babel/standalone/babel.js':
        'import { __commonJSMin } from "../../../_virtual/_rolldown/runtime.js";\nconsole.log(1)',
      '_virtual/_rolldown/runtime.js': 'export const __commonJSMin = () => {}',
    })
    expect(transitiveClosure(['node_modules/@babel/standalone/babel.js'], fs)).toEqual([
      '_virtual/_rolldown/runtime.js',
      'node_modules/@babel/standalone/babel.js',
    ])
  })

  it('ignores bare/external specifiers and only walks relative chunk edges', () => {
    const fs = fakeFs({
      'a.js': 'import "react"\nimport x from "@babel/core"\nimport y from "./b.js"',
      'b.js': '',
    })
    expect(transitiveClosure(['a.js'], fs)).toEqual(['a.js', 'b.js'])
  })

  it('skips a relative spec that resolves to no emitted file (body false-positive, not an edge)', () => {
    // A `from "./x"` inside a string/template must not fail the build or be
    // precached when no such chunk exists.
    const fs = fakeFs({
      'a.js': 'const code = `\\nimport z from "./does-not-exist.js"\\n`\nimport y from "./b.js"',
      'b.js': '',
    })
    expect(transitiveClosure(['a.js'], fs)).toEqual(['a.js', 'b.js'])
  })

  it('dedupes diamond dependencies', () => {
    const fs = fakeFs({
      'a.js': 'import b from "./b.js"\nimport c from "./c.js"',
      'b.js': 'import d from "./d.js"',
      'c.js': 'import d from "./d.js"',
      'd.js': '',
    })
    expect(transitiveClosure(['a.js'], fs)).toEqual(['a.js', 'b.js', 'c.js', 'd.js'])
  })

  it('throws when an entrypoint is missing (chunk layout drift)', () => {
    expect(() => transitiveClosure(['gone.js'], fakeFs({}))).toThrow(/missing/)
  })
})
