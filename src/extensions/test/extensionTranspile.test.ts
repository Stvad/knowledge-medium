import {describe, expect, it, vi} from 'vitest'
import * as Babel from '@babel/standalone'
import {InMemoryCompiledModuleCache} from '@/extensions/compiledModuleCache'
import {
  setExtensionCompilePlatform,
  approveExtension,
  COMPILER_VERSION,
  createCompileCache,
  hashExtensionSource,
  loadApprovedExtension,
} from '@/extensions/compileExtensionModule'

// Output cached under a COMPILER_VERSION was produced by this Babel major.
// Persisted output is keyed by COMPILER_VERSION, not by Babel's version.
const COMPILER_VERSION_SET_UNDER = {compilerVersion: '5', babelMajor: '8'}

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
      `import {value} from '@/extensions/core.js'\n` +
      `export const read = (shape: Shape): unknown => [shape, value]\n`,
      persistent,
    )

    const {compiled} = (await persistent.read('block-1'))!
    expect(compiled).toMatch(/from\s*["']@\/extensions\/core\.js["']/)
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
    const restore = setExtensionCompilePlatform({allowUnpinnedLive: true, instantiate: async ({compiled}) => {
      instantiated = compiled
      return {}
    }})

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

describe('pinned import approvals', () => {
  const body = 'export default 1'
  const url = 'https://cdn.example/module.mjs'
  const pin = async () => 'sha256-' + Buffer.from(await hashExtensionSource(body), 'hex').toString('base64')

  it('repairs an otherwise-current approval missing one of its source pins', async () => {
    const integrity = await pin()
    const source = `import value from '${url}' with {integrity: '${integrity}'}; export default value`
    const store = new InMemoryCompiledModuleCache()
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(body))
    try {
      await approveExtension('extension', source, store)
      const complete = (await store.read('extension'))!
      expect(complete.compiled).toContain('km-vendored:' + integrity)
      expect(new TextDecoder().decode(complete.vendored?.[integrity])).toBe(body)
      await approveExtension('extension', source, store)
      expect(fetch).toHaveBeenCalledTimes(1)
      await store.write('extension', {...complete, vendored: {}})
      await approveExtension('extension', source, store)
      expect(fetch).toHaveBeenCalledTimes(2)
      expect((await store.read('extension'))?.vendored).toEqual(complete.vendored)
    } finally {
      fetch.mockRestore()
    }
  })

  it('links repeated static references to one blob and refuses a missing vendored module', async () => {
    const integrity = await pin()
    const placeholder = 'km-vendored:' + integrity
    const source = `import '${placeholder}'; export * from '${placeholder}';`
    const approval = {
      compilerVersion: COMPILER_VERSION, approvedSource: '', compiled: source, approvedAt: 1, sourceHash: 'fixture',
    }
    const store = new InMemoryCompiledModuleCache()
    const load = (vendored?: Record<string, Uint8Array<ArrayBuffer>>) =>
      loadApprovedExtension('fixture', {...approval, vendored}, createCompileCache(), store)
    const create = vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:fixture')
      .mockReturnValueOnce('data:text/javascript,export default 1')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    try {
      await expect(load()).rejects.toThrow('Missing approved import')
      expect(create).not.toHaveBeenCalled()
      await load({[integrity]: new TextEncoder().encode(body)})
      expect(create).toHaveBeenCalledTimes(2)
      const [dependency, entry] = create.mock.calls
      if (!(dependency[0] instanceof Blob && entry[0] instanceof Blob)) throw new Error('Expected module blobs')
      expect(await dependency[0].text()).toBe(body)
      expect(await entry[0].text()).toBe('import "blob:fixture"; export * from "blob:fixture";')
      expect(revoke.mock.calls.flat()).toEqual(['data:text/javascript,export default 1', 'blob:fixture'])
    } finally {
      create.mockRestore()
      revoke.mockRestore()
    }
  })

  it('rechecks same-source approval when its compiler version is stale', async () => {
    const store = new InMemoryCompiledModuleCache()
    const source = 'export default import.meta.env'
    await store.write('old', {
      compilerVersion: '4', approvedSource: source, sourceHash: await hashExtensionSource(source),
      compiled: 'export default 1', approvedAt: 1,
    })
    await expect(approveExtension('old', source, store)).rejects.toThrow(/import.meta.url/)
    expect((await store.read('old'))?.compilerVersion).toBe('4')
  })

  it('rechecks version 4 approved source before instantiating old compiled output', async () => {
    const instantiate = vi.fn()
    const restore = setExtensionCompilePlatform({instantiate, allowUnpinnedLive: true})
    try {
      await expect(loadApprovedExtension('old', {
        compilerVersion: '4', approvedSource: 'export default import.meta.env',
        approvedAt: 1, sourceHash: 'old', compiled: 'export default 1',
      }, createCompileCache(), new InMemoryCompiledModuleCache())).rejects.toThrow(/import.meta.url/)
      expect(instantiate).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('refuses a warm tab approval containing a live URL on a pinned-only platform', async () => {
    const store = new InMemoryCompiledModuleCache()
    await approveExtension('ext', `import '${url}'`, store)
    const instantiate = vi.fn()
    const restore = setExtensionCompilePlatform({instantiate, allowUnpinnedLive: false})
    try {
      await expect(loadApprovedExtension('ext', (await store.read('ext'))!, createCompileCache(), store))
        .rejects.toThrow(/unpinned/i)
      expect(instantiate).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })
})
