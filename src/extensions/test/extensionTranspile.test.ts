import {describe, expect, it} from 'vitest'
import {InMemoryCompiledModuleCache} from '@/extensions/compiledModuleCache'
import {approveExtension} from '@/extensions/compileExtensionModule'

// Runs the REAL transpile (no `__setTranspileImplForTest`): the contract under
// test is what the loader's Babel step emits for JSX, because that output is
// what the page import map resolves. `approveExtension` pins the transpiled
// string, so reading the pinned row is the public way to see it.
const transpile = async (source: string): Promise<string> => {
  const persistent = new InMemoryCompiledModuleCache()
  await approveExtension('block-1', source, persistent)
  return (await persistent.read('block-1'))!.compiled
}

// Babel's first load plus a transform is well over the 5s default under the
// gate's parallel load; the sibling authoring-catalog sweep budgets 20s for the
// same work.
describe('extension JSX transpile — host React identity', () => {
  it('imports the jsx factory from react/jsx-runtime instead of reading a React global', async () => {
    const compiled = await transpile(
      `import {useState} from 'react'\n` +
      `export const C = () => { const [n] = useState(1); return <div>{n}</div> }\n`,
    )

    expect(compiled).toMatch(/from\s*["']react\/jsx-runtime["']/)
    expect(compiled).not.toMatch(/\bReact\.createElement\b/)
  }, 20_000)

  it('compiles a fragment without a React global too', async () => {
    const compiled = await transpile(`export const C = () => <><b>x</b></>\n`)

    expect(compiled).toMatch(/from\s*["']react\/jsx-runtime["']/)
    expect(compiled).not.toMatch(/\bReact\.Fragment\b/)
  }, 20_000)

  it('still compiles a source that imports React itself', async () => {
    const compiled = await transpile(
      `import React from 'react'\nexport const C = () => <i>{React.version}</i>\n`,
    )

    expect(compiled).toMatch(/from\s*["']react\/jsx-runtime["']/)
    expect(compiled).toMatch(/import React from ["']react["']/)
  }, 20_000)
})
