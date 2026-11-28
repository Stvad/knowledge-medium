import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {expect, it, vi} from 'vitest'
import {BLOCKS_TABLE_COLUMN_NAMES, blockToRowParams} from '@/data/blockSchema'
import {typesProp} from '@/data/properties'
import {createTestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {makeBlockData} from '@/data/test/factories'
import {appEffectsFacet} from '@/extensions/core.js'
import {staticDataExtensions} from '@/extensions/staticDataExtensions'
import {defineFacet, resolveFacetRuntimeSync} from '@/facets/facet'
import {prepareHostExtensions} from './extensions'

const {instantiate} = vi.hoisted(() => ({instantiate: vi.fn()}))
vi.mock('./extensionVm', () => ({instantiateHostExtension: instantiate}))

it('passes only allowlisted contribution provenance and refreshes admission before function exports', async () => {
  const {db, dir, cleanup} = await createTestDb()
  const block = 'fixture-extension'
  const workspaceId = 'fixture'
  const source = 'export default null'
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
  try {
    host!.setWritableAdmission(true, async () => {})
    await vi.waitFor(() => expect(startGranted).toHaveBeenCalledOnce())
    expect(startStatic).not.toHaveBeenCalled()
    expect(startDifferentBlock).not.toHaveBeenCalled()
    expect(host!.health()).toEqual([{block, state: 'running', effectIds: ['granted']}])
    const installed = onRuntime.mock.lastCall![0]
    expect(installed.read(durable)).toEqual(['old'])
    installed.setRuntimeContributions(durable, 'projector', [], {durable: true})
    host!.setWritableAdmission(false, async () => {})
    expect(onRuntime.mock.lastCall![0].read(durable)).toEqual([])

    const exportFunction = vi.fn()
    instantiate.mockResolvedValue({default: exportFunction})
    const refreshAdmission = vi.fn(async () => {
      host!.setWritableAdmission(false, async () => {})
    })
    host!.setWritableAdmission(true, refreshAdmission)
    expect(host!.health()).toEqual([{block, state: 'refused', reason: 'starting', effectIds: []}])
    await vi.waitFor(() => expect(refreshAdmission).toHaveBeenCalledOnce())
    expect(exportFunction).not.toHaveBeenCalled()
  } finally {
    host?.stop()
    await repo.awaitDeferredWork()
    repo.cancelDelayedProcessors()
    await cleanup()
  }
})
