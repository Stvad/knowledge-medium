// @vitest-environment node
import {afterAll, beforeAll, beforeEach, expect, it, vi} from 'vitest'
import type {KnownAgentCommand} from '@knowledge-medium/agent-cli/protocol'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {staticDataExtensions} from '@/extensions/staticDataExtensions'
import {createTestAgentContext} from '@/plugins/agent-runtime/test/createTestAgentContext'
import {executeHeadlessCommand} from './commands'
import {readCommands} from './test/readSurface'

let shared: TestDb
const workspaceId = 'workspace'
const user = {id: 'host'}
beforeAll(async () => { shared = await createTestDb() })
beforeEach(async () => { await resetTestDb(shared.db) })
afterAll(async () => { await shared.cleanup() })

const viewer = 'the member role viewer cannot write'
const gate = (reason: string | null, refusal: string | null = viewer) =>
  () => ({readReason: () => reason, writeRefusal: () => refusal})
const open = gate(null)
const closed = gate('membership missing', null)
const context = () => createTestAgentContext(
  createTestRepo({db: shared.db, user, isReadOnly: true, startSyncObserver: true}).repo,
  workspaceId,
  staticDataExtensions,
)

const refusals: KnownAgentCommand[] = [
  {type: 'eval', code: 'return 1'},
  {type: 'run-action', id: 'test'},
  {type: 'action', id: 'test'},
  {type: 'install-extension', source: ''},
  {type: 'enable-extension'},
  {type: 'disable-extension'},
  {type: 'set-extension-enabled', enabled: true},
  {type: 'uninstall-extension'},
  {type: 'audit-extension'},
  {type: 'run-backfill', backfillId: 'test'},
  {type: 'audit-properties'},
]

it.each(refusals)('refuses $type even with an open gate', async command => {
  const error = command.type === 'action' || command.type === 'set-extension-enabled'
    ? `Unsupported headless command: ${command.type}`
    : new RegExp(`^${command.type}: (?:arbitrary code|actions are unavailable|extension grants|workspace backfills|property audits)`)
  await expect(executeHeadlessCommand(command, context(), open)).rejects.toThrow(error)
})

it.each(['ping', 'health', 'rematerialize-workspace', 'rejected-uploads'] as const)('serves %s while closed', async type => {
  const evaluatingGate = vi.fn(closed)
  await expect(executeHeadlessCommand({type}, context(), evaluatingGate)).resolves.toBeDefined()
  expect(evaluatingGate).not.toHaveBeenCalled()
})

it('refuses reads and document writes while closed with the gate condition', async () => {
  const always = new Set(['ping', 'health', 'rematerialize-workspace', 'rejected-uploads'])
  const commands: KnownAgentCommand[] = [
    ...readCommands('test').filter(command => !always.has(command.type)),
    {type: 'create-block'},
    {type: 'create-page', name: 'test'},
    {type: 'create-contributor', name: 'test'},
    {type: 'edit-block', id: 'test', old: 'a', new: 'b'},
    {type: 'update-block', id: 'test'},
    {type: 'move-block', id: 'test', parentId: null, position: {kind: 'last'}},
    {type: 'delete-block', id: 'test'},
    {type: 'restore-block', id: 'test'},
    {type: 'append-markdown', target: 'test', markdown: 'test'},
    {type: 'reconcile-markdown-subtree', parentId: 'test', markdown: 'test', key: 'test'},
    {type: 'add-comment', target: 'test'},
    {type: 'retry-rejected-upload', txId: 1},
    {type: 'read-media', ref: 'test'},
    {type: 'add-media', base64: ''},
  ]
  const runtime = context()
  for (const command of commands) {
    await expect(executeHeadlessCommand(command, runtime, closed), command.type)
      .rejects.toThrow('Headless gate closed: membership missing')
  }
})

it.each([null, 'membership missing'])('refuses SQL execute when the gate reason is %s', async reason => {
  await expect(executeHeadlessCommand({type: 'sql', mode: 'execute', sql: 'SELECT 1'}, context(), gate(reason, null)))
    .rejects.toThrow('Headless SQL is read-only')
})

it('refuses a mutating SQL statement even in a read mode', async () => {
  await expect(executeHeadlessCommand({type: 'sql', mode: 'all', sql: 'CREATE TABLE test (n INT)'}, context(), open))
    .rejects.toThrow('Headless SQL is read-only')
})

it('accepts query plans for reads and refuses to prepare a non-read PRAGMA under EXPLAIN', async () => {
  const runtime = context()
  await expect(executeHeadlessCommand({type: 'sql', sql: 'EXPLAIN QUERY PLAN SELECT 1'}, runtime, open))
    .resolves.toEqual(expect.arrayContaining([expect.objectContaining({detail: expect.any(String)})]))
  await expect(executeHeadlessCommand({type: 'sql', sql: 'EXPLAIN PRAGMA cache_size = 32'}, runtime, open))
    .rejects.toThrow('Headless SQL is read-only')
})

it('applies the same SQL restriction before registering a watcher', async () => {
  await expect(executeHeadlessCommand({
    type: 'watch-events', consumer: 'test',
    watchers: [{kind: 'sql', name: 'test', sql: 'EXPLAIN PRAGMA cache_size = 32'}],
  }, context(), open)).rejects.toThrow('Headless watcher SQL is read-only')
})

it('refuses before the gate has started', async () => {
  await expect(executeHeadlessCommand({type: 'get-block', id: 'test'}, context(), () => undefined))
    .rejects.toThrow('Headless gate closed: Starting gate')
})

it('refuses an upload retry with the reason the host cannot upload, after the gate refreshes', async () => {
  const order: string[] = []
  const command = {type: 'retry-rejected-upload', txId: 1} as const
  await expect(executeHeadlessCommand(command, context(), () => ({
    readReason: () => { order.push('gate'); return null },
    writeRefusal: () => { order.push('write'); return viewer },
  })))
    .rejects.toThrow('retry-rejected-upload: the member role viewer cannot write')
  expect(order).toEqual(['gate', 'write'])
  await expect(executeHeadlessCommand(command, context(), gate(null, null))).rejects.toThrow('No rejected transaction 1')
})

it('refuses add-media on a host that cannot write, before capturing anything', async () => {
  const runtime = context()
  const capture = vi.spyOn(runtime.media, 'capture')
  await expect(executeHeadlessCommand({type: 'add-media', base64: 'AQID'}, runtime, open))
    .rejects.toThrow(`add-media: ${viewer}`)
  expect(capture).not.toHaveBeenCalled()
})
