// @vitest-environment happy-dom
import {afterEach, expect, it, vi} from 'vitest'

const writes = vi.hoisted(() => ({
  dailyNote: vi.fn(),
  schemas: vi.fn(async () => []),
  tag: vi.fn(async () => ({id: 'tag'})),
}))
vi.mock('https://esm.sh/matrix-js-sdk@38.0.0?bundle', () => ({createClient: vi.fn()}))
vi.mock('@/plugins/daily-notes/dailyNotes.js', async importOriginal => ({
  ...await importOriginal<typeof import('@/plugins/daily-notes/dailyNotes.js')>(),
  getOrCreateDailyNoteInTx: writes.dailyNote,
}))
vi.mock('@/plugins/roam-import/plan.js', async importOriginal => ({
  ...await importOriginal<typeof import('@/plugins/roam-import/plan.js')>(),
  ensurePromotedPropertySchemas: writes.schemas,
}))
vi.mock('@/data/targets.js', async importOriginal => ({
  ...await importOriginal<typeof import('@/data/targets.js')>(),
  createOrRestoreTargetBlock: writes.tag,
}))

import {checkpointId, pollLoop} from './matrix-chat-client.tsx'

const config = {
  workspaceId: 'first', baseUrl: 'https://matrix.test', roomId: '!room:matrix.test',
  accessToken: 'fixture', autoStart: true,
}

function fixture(body = 'example') {
  const tx = {
    childrenOf: vi.fn<() => Promise<Array<{id: string, content: string}>>>().mockResolvedValue([]),
    readDb: {getOptional: vi.fn(async () => null)},
    create: vi.fn(async () => 'message'),
  }
  const repo = {
    activeWorkspaceId: config.workspaceId,
    load: async (id: string) => id === checkpointId(config) ? {
      workspaceId: config.workspaceId, deleted: false, properties: {types: ['matrix-checkpoint'], 'matrix-checkpoint:nextBatch': 'before'},
    } : null,
    db: {getOptional: vi.fn(async () => null)},
    snapshotTypeRegistries: () => ({}),
    tx: (run: (writer: typeof tx) => Promise<void>) => run(tx),
    propertySchemas: new Map(),
  }
  const event = {type: 'm.room.message', event_id: '$example', content: {msgtype: 'm.text', body}}
  const batch = {next_batch: 'after', rooms: {join: {[config.roomId]: {timeline: {events: [event]}}}}}
  const client = {http: {authedRequest: vi.fn().mockResolvedValueOnce(batch)}}
  const switchWorkspace = () => { repo.activeWorkspaceId = 'second' }
  const run = () => pollLoop(repo, config, new AbortController().signal, client)
  return {tx, repo, switchWorkspace, run}
}

afterEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

it('skips schema registration when the workspace changes during the initial identity read', async () => {
  const {repo, switchWorkspace, run} = fixture()
  repo.db.getOptional.mockImplementationOnce(async () => { switchWorkspace(); return null })
  await run()
  expect(repo.db.getOptional).toHaveBeenCalledOnce()
  expect(writes.schemas).not.toHaveBeenCalled()
})

it('skips the daily note when the workspace changes during the transactional identity read', async () => {
  const {tx, switchWorkspace, run} = fixture()
  tx.readDb.getOptional.mockImplementationOnce(async () => { switchWorkspace(); return null })
  await run()
  expect(tx.readDb.getOptional).toHaveBeenCalledOnce()
  expect(writes.dailyNote).not.toHaveBeenCalled()
})

it('skips tag creation when the workspace changes during the tag lookup', async () => {
  const {tx, switchWorkspace, run} = fixture()
  tx.childrenOf.mockImplementationOnce(async () => { switchWorkspace(); return [] })
  await run()
  expect(tx.childrenOf).toHaveBeenCalledOnce()
  expect(writes.tag).not.toHaveBeenCalled()
})

it('skips message creation when the workspace changes during the last message order-key lookup', async () => {
  const {tx, switchWorkspace, run} = fixture()
  tx.childrenOf.mockResolvedValueOnce([{id: 'tag', content: '[[matrix-messages]]'}])
  tx.readDb.getOptional.mockResolvedValueOnce(null).mockImplementationOnce(async () => { switchWorkspace(); return null })
  await run()
  expect(tx.readDb.getOptional).toHaveBeenNthCalledWith(2, expect.any(String), ['tag'])
  expect(tx.create).not.toHaveBeenCalled()
})

it('checks the workspace again before creating a nested message row', async () => {
  const {tx, switchWorkspace, run} = fixture('- root\n  - child')
  tx.childrenOf.mockResolvedValueOnce([{id: 'tag', content: '[[matrix-messages]]'}])
  tx.create.mockImplementationOnce(async () => {
    switchWorkspace()
    return 'message'
  })
  await run()
  expect(tx.create.mock.calls).toEqual([[expect.objectContaining({content: 'root'})]])
})
