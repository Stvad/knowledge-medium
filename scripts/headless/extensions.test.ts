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
import {resolveFacetRuntimeSync} from '@/facets/facet'
import {prepareHostExtensions} from './extensions'

const {instantiate} = vi.hoisted(() => ({instantiate: vi.fn()}))
vi.mock('./extensionVm', () => ({instantiateHostExtension: instantiate}))

it('passes only allowlisted contribution provenance to the headless effect reconciler', async () => {
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
  const host = await prepareHostExtensions(
    {stateDir: dir, profile: 'test', mode: 'plaintext', workspaceId, writable: true, extensions: [{block, file}]},
    context, base, runtime, () => {}, new AbortController().signal,
  )
  try {
    host!.setWritableAdmission(true, async () => {})
    await vi.waitFor(() => expect(startGranted).toHaveBeenCalledOnce())
    expect(startStatic).not.toHaveBeenCalled()
    expect(startDifferentBlock).not.toHaveBeenCalled()
    expect(host!.health()).toEqual([{block, state: 'running', effectIds: ['granted']}])
  } finally {
    host?.stop()
    await repo.awaitDeferredWork()
    repo.cancelDelayedProcessors()
    await cleanup()
  }
})
