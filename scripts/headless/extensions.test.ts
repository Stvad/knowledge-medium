import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest'
import {BLOCKS_TABLE_COLUMN_NAMES, blockToRowParams} from '@/data/blockSchema'
import {typesProp} from '@/data/properties'
import {createTestDb, resetTestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {makeBlockData} from '@/data/test/factories'
import {approveExtension, createCompileCache, loadApprovedExtension} from '@/extensions/compileExtensionModule'
import {InMemoryCompiledModuleCache} from '@/extensions/compiledModuleCache'
import {AppRuntimeController} from '@/extensions/appRuntimeController'
import {appEffectsFacet} from '@/extensions/core.js'
import {staticDataExtensions} from '@/extensions/staticDataExtensions'
import {defineFacet, resolveFacetRuntimeSync} from '@/facets/facet'
import {prepareHostExtensions} from './extensions'

const {instantiate} = vi.hoisted(() => ({instantiate: vi.fn()}))
vi.mock('./extensionVm', () => ({instantiateHostExtension: instantiate}))

let fixture: Awaited<ReturnType<typeof createTestDb>>
const block = 'fixture-extension'
const workspaceId = 'fixture'
const source = 'export default null'
let cleanupHost: (() => Promise<void>) | undefined
beforeAll(async () => { fixture = await createTestDb() })
beforeEach(async () => { await resetTestDb(fixture.db); instantiate.mockReset() })
afterEach(async () => {
  try { await cleanupHost?.() } finally { cleanupHost = undefined; vi.restoreAllMocks() }
})
afterAll(async () => { await fixture.cleanup() })

async function prepareFixture() {
  const {db, dir} = fixture
  const file = join(dir, 'extension.tsx')
  await writeFile(file, source)
  const {repo} = createTestRepo({db, user: {id: 'member'}})
  await db.execute(
    `INSERT INTO blocks (${BLOCKS_TABLE_COLUMN_NAMES.join(', ')}) VALUES (${BLOCKS_TABLE_COLUMN_NAMES.map(() => '?').join(', ')})`,
    blockToRowParams(makeBlockData({id: block, workspaceId, content: source, properties: {[typesProp.name]: ['extension']}})),
  )
  const startGranted = vi.fn()
  const startStatic = vi.fn()
  const startDifferentBlock = vi.fn()
  instantiate.mockResolvedValue({default: appEffectsFacet.of({id: 'granted', start: startGranted}, {source: 'nested'})})
  const base = [...staticDataExtensions,
    appEffectsFacet.of({id: 'static', start: startStatic}, {source: 'static'}),
    appEffectsFacet.of({id: 'other', start: startDifferentBlock}, {source: `block:${block}-other`}),
  ]
  const context = {repo, workspaceId, safeMode: false}
  const runtime = resolveFacetRuntimeSync(base, context)
  repo.setFacetRuntime(runtime)
  const durable = defineFacet<string>({id: 'fixture.durable'})
  runtime.setRuntimeContributions(durable, 'projector', ['old'], {durable: true})
  const onRuntime = vi.fn<typeof repo.setFacetRuntime>()
  const host = await prepareHostExtensions(
    {stateDir: dir, profile: 'test', mode: 'plaintext', workspaceId, writable: true, extensions: [{block, file}]},
    context, base, onRuntime, new AbortController().signal,
  )
  cleanupHost = async () => {
    host?.stop()
    await repo.awaitDeferredWork()
    repo.cancelDelayedProcessors()
  }
  return {host: host!, repo, onRuntime, durable, startGranted, startStatic, startDifferentBlock}
}

it('passes only allowlisted contribution provenance and refreshes admission before function exports', async () => {
  const {host, repo, onRuntime, durable, startGranted, startStatic, startDifferentBlock} = await prepareFixture()
  host.setWritableAdmission(true, async () => {})
  await vi.waitFor(() => expect(startGranted).toHaveBeenCalledOnce())
  expect(startStatic).not.toHaveBeenCalled()
  expect(startDifferentBlock).not.toHaveBeenCalled()
  expect(host.health()).toEqual([{block, state: 'running', effectIds: ['granted']}])
  const installed = onRuntime.mock.lastCall![0]
  expect(installed.read(durable)).toEqual(['old'])
  expect(repo.facetRuntime?.read(appEffectsFacet).map(effect => effect.id)).toContain('granted')
  installed.setRuntimeContributions(durable, 'projector', [], {durable: true})
  host.setWritableAdmission(false, async () => {})
  expect(onRuntime.mock.lastCall![0].read(durable)).toEqual([])
  expect(repo.facetRuntime).toBe(onRuntime.mock.lastCall![0])
  expect(repo.facetRuntime?.read(appEffectsFacet).map(effect => effect.id)).not.toContain('granted')

  const exportFunction = vi.fn()
  instantiate.mockResolvedValue({default: exportFunction})
  const refreshAdmission = vi.fn(async () => {
    host.setWritableAdmission(false, async () => {})
  })
  host.setWritableAdmission(true, refreshAdmission)
  expect(host.health()).toEqual([{block, state: 'refused', reason: 'starting', effectIds: []}])
  await vi.waitFor(() => expect(refreshAdmission).toHaveBeenCalledOnce())
  expect(exportFunction.mock.calls).toHaveLength(0)
})

it('refuses records from another approval store, even with an active admission callback', async () => {
  const {host, startGranted} = await prepareFixture()
  host.setWritableAdmission(true, async () => {})
  await vi.waitFor(() => expect(startGranted).toHaveBeenCalledOnce())
  const other = new InMemoryCompiledModuleCache()
  const activeAdmission = instantiate.mock.lastCall![4]
  await approveExtension(block, 'export default 99', other)
  await approveExtension('unlisted', source, other)
  await expect(loadApprovedExtension(block, (await other.read(block))!, createCompileCache(), other, undefined, activeAdmission))
    .rejects.toThrow('Extension record does not match the host grant')
  await expect(loadApprovedExtension('unlisted', (await other.read('unlisted'))!, createCompileCache(), other, undefined, activeAdmission))
    .rejects.toThrow('Extension record does not match the host grant')
  expect(instantiate).toHaveBeenCalledTimes(1)
  await approveExtension(block, source, other)
  const matching = (await other.read(block))!
  await loadApprovedExtension(block, {...matching, compiled: 'export default 99'}, createCompileCache(), other)
  expect(instantiate.mock.lastCall![1]).toMatchObject({compiled: matching.compiled})
})

it('refuses a matching record outside its writable admission', async () => {
  const {host, startGranted} = await prepareFixture()
  const other = new InMemoryCompiledModuleCache()
  await approveExtension(block, source, other)
  instantiate.mockImplementation(async (_block, _record, _manifest, _import, check) => {
    await check()
    return {default: appEffectsFacet.of({id: 'granted', start: startGranted})}
  })
  const refresh = vi.fn(async () => {})
  host.setWritableAdmission(true, refresh)
  await vi.waitFor(() => expect(startGranted).toHaveBeenCalledOnce())
  const formerAdmission = instantiate.mock.lastCall![4]
  host.setWritableAdmission(false, async () => {})
  refresh.mockClear()
  await expect(formerAdmission()).rejects.toMatchObject({name: 'AbortError'})
  expect(refresh).not.toHaveBeenCalled()
  const openedAgain = vi.fn()
  instantiate.mockImplementation(async (_block, _record, _manifest, _import, check) => {
    await check()
    return {default: appEffectsFacet.of({id: 'granted', start: openedAgain})}
  })
  const closed = await loadApprovedExtension(block, (await other.read(block))!, createCompileCache(), other)
    .catch((error: unknown) => error)
  expect(instantiate).toHaveBeenCalledTimes(1)
  expect(closed).toMatchObject({message: 'Extension evaluation requires writable admission'})
  host.setWritableAdmission(true, async () => {})
  await vi.waitFor(() => expect(openedAgain).toHaveBeenCalledOnce())
  await expect(loadApprovedExtension(block, (await other.read(block))!, createCompileCache(), other, undefined, formerAdmission))
    .rejects.toThrow('Extension evaluation requires writable admission')
})

it('reports runtime resolution failures and restores the base runtime after a failed mount', async () => {
  const {host, repo, startGranted, onRuntime} = await prepareFixture()
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
  // The candidate was published to the host runtime listener before Repo installation failed.
  vi.spyOn(repo, 'setFacetRuntime').mockImplementationOnce(() => { throw new Error('private resolution detail') })
  host.setWritableAdmission(true, async () => {})
  await vi.waitFor(() => expect(host.health()).toEqual([{block, state: 'refused', reason: 'load-error', effectIds: []}]))
  expect(onRuntime).toHaveBeenCalledTimes(2)
  expect(repo.facetRuntime).toBe(onRuntime.mock.lastCall![0])
  expect(repo.facetRuntime?.read(appEffectsFacet).map(effect => effect.id)).not.toContain('granted')
  expect(startGranted).not.toHaveBeenCalled()
  expect(log.mock.calls).toEqual([['Headless extension runtime load-error']])
  expect(errorLog).not.toHaveBeenCalled()
})

it('does not report a failed resolution once its writable admission has ended', async () => {
  const {host} = await prepareFixture()
  const resolve = vi.spyOn(AppRuntimeController.prototype, 'resolve')
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
  let rejectRefresh!: (reason: Error) => void
  const pending = new Promise<void>((_resolve, reject) => { rejectRefresh = reject })
  const refresh = vi.fn(() => pending)
  host.setWritableAdmission(true, refresh)
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())
  host.setWritableAdmission(false, async () => {})
  rejectRefresh(new Error('late admission failure'))
  await resolve.mock.results[0]?.value
  expect(host.health()).toEqual([{block, state: 'refused', reason: 'not-writable', effectIds: []}])
  expect(log).not.toHaveBeenCalled()
})
