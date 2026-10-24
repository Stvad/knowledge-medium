import {describe, expect, it} from 'vitest'
import * as Babel from '@babel/standalone'
import {InMemoryCompiledModuleCache} from '@/extensions/compiledModuleCache'
import {
  __setInstantiateImplForTest,
  approveExtension,
  COMPILER_VERSION,
  createCompileCache,
  loadApprovedExtension,
} from '@/extensions/compileExtensionModule'

// Output cached under a COMPILER_VERSION was produced by this Babel major.
// Persisted output is keyed by COMPILER_VERSION, not by Babel's version.
const COMPILER_VERSION_SET_UNDER = {compilerVersion: '4', babelMajor: '8'}

describe('COMPILER_VERSION', () => {
  it('was set under the installed Babel major', () => {
    expect(
      {compilerVersion: COMPILER_VERSION, babelMajor: Babel.version.split('.')[0]},
      'If @babel/standalone changed major, bump COMPILER_VERSION, or every device keeps ' +
      'serving output cached under the old major; transpile real extension sources with both ' +
      'versions and compare outputs and errors. Then record the new pair here.',
    ).toEqual(COMPILER_VERSION_SET_UNDER)
  })
})

// These tests run the REAL transpile (no `__setTranspileImplForTest`): the
// contract under test is what the loader's Babel step emits, because that
// output is what the page import map resolves.
describe('extension transpile — real Babel output', () => {
  it('compiles JSX to react/jsx-runtime, never a React global', async () => {
    const persistent = new InMemoryCompiledModuleCache()
    await approveExtension(
      'block-1',
      `import {useState} from 'react'\n` +
      `export const C = () => { const [n] = useState(1); return <div>{n}<><b>x</b></></div> }\n`,
      persistent,
    )

    const {compiled} = (await persistent.read('block-1'))!
    expect(compiled).toMatch(/from\s*["']react\/jsx-runtime["']/)
    expect(compiled).not.toMatch(/\bReact\.createElement\b/)
    expect(compiled).not.toMatch(/\bReact\.Fragment\b/)
  })

  it('erases an import whose bindings are only used as types', async () => {
    // Pins `onlyRemoveTypeImports: false`; see EXTENSION_BABEL_PRESETS.
    const persistent = new InMemoryCompiledModuleCache()
    await approveExtension(
      'block-1',
      `import {Shape} from '@/types-only.js'\n` +
      `import {value} from '@/runtime.js'\n` +
      `export const read = (shape: Shape): unknown => [shape, value]\n`,
      persistent,
    )

    const {compiled} = (await persistent.read('block-1'))!
    expect(compiled).toMatch(/from\s*["']@\/runtime\.js["']/)
    expect(compiled).not.toMatch(/@\/types-only\.js/)
  })

  it('recompiles an approval pinned by a classic-runtime compiler instead of running it as stored', async () => {
    const persistent = new InMemoryCompiledModuleCache()
    // '2' is the last COMPILER_VERSION that emitted `React.createElement`; a
    // stored string like this one only runs where a React global exists.
    const approval = {
      sourceHash: 'hash-1',
      approvedSource: `export default () => <b>x</b>\n`,
      compiled: `export default () => React.createElement("b", null, "x")`,
      compilerVersion: '2',
      approvedAt: 1,
    }
    await persistent.write('block-1', approval)
    let instantiated = ''
    const restore = __setInstantiateImplForTest(async compiled => {
      instantiated = compiled
      return {}
    })

    try {
      await loadApprovedExtension('block-1', approval, createCompileCache(), persistent)
    } finally {
      restore()
    }

    expect(instantiated).toMatch(/from\s*["']react\/jsx-runtime["']/)
    expect(instantiated).not.toMatch(/\bReact\.createElement\b/)
    expect(await persistent.read('block-1')).toMatchObject({
      sourceHash: 'hash-1',
      compilerVersion: COMPILER_VERSION,
    })
  })
})
