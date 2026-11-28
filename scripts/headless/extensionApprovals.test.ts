import {mkdtemp, readdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {afterAll, beforeAll, expect, it, vi} from 'vitest'
import {approveExtension} from '@/extensions/compileExtensionModule'
import {InMemoryCompiledModuleCache} from '@/extensions/compiledModuleCache'
import {readExtensionImportManifest} from '../../vite-plugins/extensionImportManifest'
import {approvalRefusal, buildHostApproval} from './extensionApprovals'
import {fixtureIntegrity, fixtureModule, fixtureSource, fixtureUrl} from './test/extensionFixture'

const block = 'fixture-reviewed'
const manifest = readExtensionImportManifest(resolve(import.meta.dirname, '../..'))
let scratch: string
beforeAll(async () => { scratch = await mkdtemp(join(tmpdir(), 'headless-extension-approvals-')) })
afterAll(async () => { await rm(scratch, {recursive: true, force: true}) })

it('builds the same tab and host records and verifies pinned bytes again on a cache hit', async () => {
  const cache = join(scratch, 'pinned')
  const fetch = vi.fn(async () => new Response(fixtureModule))
  vi.stubGlobal('fetch', fetch)
  try {
    const tab = new InMemoryCompiledModuleCache()
    await approveExtension(block, fixtureSource, tab)
    const host = await buildHostApproval(block, fixtureSource + '\n  ', cache, manifest)
    expect(host).toEqual({...await tab.read(block), approvedAt: host.approvedAt})
    expect(host.vendored).toEqual({
      [fixtureIntegrity]: new TextEncoder().encode(fixtureModule),
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    fetch.mockClear()
    expect(await buildHostApproval(block, fixtureSource, cache, manifest)).toEqual({
      ...host, approvedAt: expect.any(Number),
    })
    expect(fetch).not.toHaveBeenCalled()
    const [file] = await readdir(cache)
    expect(file).toMatch(/^[a-f0-9]{64}$/)
    await writeFile(join(cache, file), 'export default "changed";')
    await expect(buildHostApproval(block, fixtureSource, cache, manifest)).rejects.toThrow('integrity mismatch')
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllGlobals()
  }
})

it.each([
  ['exact bare key', `import {useState} from 'react'; export default useState`, true, true],
  ['page facade variant', `export * from 'react-dom/server.edge'`, true, true],
  ['application source', `export * from '@/extensions/core.js'`, true, true],
  ['literal dynamic', `export default () => import('@/extensions/core.js')`, true, true],
  ['type-only', `import type {NoModule} from 'anything'; export type T = NoModule; export default null`, true, true],
  ['import.meta.url', `export default import.meta.url`, true, true],
  ['computed dynamic', `const p = 'react'; export default import(p)`, false, false],
  ['node builtin', `import 'node:fs'; export default null`, false, false],
  ['bare prefix', `import 'react/unknown'; export default null`, false, false],
  ['relative path', `import './a.js'; export default null`, false, false],
  ['test source', `import '@/extensions/test/dynamicExtensions.test.js'; export default null`, false, false],
  ['service worker', `import '@/sw/sw.js'; export default null`, false, false],
  ['forged placeholder', `import 'km-vendored:forged'; export default null`, false, false],
  ['other import.meta property', `export default import.meta.resolve`, false, false],
  ['generated HTTPS JSX import', `/** @jsxImportSource https://cdn.invalid */\nexport default <b />`, false, false],
  ['unpinned static HTTPS', `import '${fixtureUrl}'; export default null`, true, false],
  ['unpinned dynamic HTTPS', `export default () => import('${fixtureUrl}')`, true, false],
] as const)('shares the import-rule verdict for %s, with the tab-only D3 transition', async (_, source, tabAllows, hostAllows) => {
  const tab = new InMemoryCompiledModuleCache()
  const tabResult = approveExtension(block, source, tab)
  const hostResult = buildHostApproval(block, source, scratch, manifest)
  const verdicts = await Promise.allSettled([tabResult, hostResult])
  expect(verdicts.map(verdict => verdict.status === 'fulfilled')).toEqual([tabAllows, hostAllows])
  if (!hostAllows && verdicts[1].status === 'rejected') {
    expect(approvalRefusal(verdicts[1].reason)).toBe(tabAllows ? 'unpinned-import' : 'forbidden-import')
  }
})
