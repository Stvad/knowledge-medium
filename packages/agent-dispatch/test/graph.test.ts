// @vitest-environment node
import {describe, expect, it, vi} from 'vitest'
import type {BridgeClient} from '@knowledge-medium/agent-cli/client'
import {createGraph} from '../src/graph'

const setup = () => {
  const runCommand = vi.fn(async () => ({}))
  const graph = createGraph({bridgeUrl: 'http://localhost', runCommand} as unknown as BridgeClient)
  return {graph, runCommand}
}

describe('dispatch activity writes', () => {
  it('sends the step start and label in one non-undoable write and refreshes repeated labels', async () => {
    const {graph, runCommand} = setup()
    await graph.setActivity('source', 'km: comments', 1_000)
    await graph.setActivity('source', 'km: comments', 31_000)
    expect(runCommand.mock.calls).toEqual([
      [{type: 'update-block', id: 'source', contributorId: null, undoable: false,
        properties: {'agent:activity': 'km: comments', 'agent:activity-at': 1_000}}, undefined],
      [{type: 'update-block', id: 'source', contributorId: null, undoable: false,
        properties: {'agent:activity': 'km: comments', 'agent:activity-at': 31_000}}, undefined],
    ])
  })

  it('clears the timestamp whenever lifecycle writes clear activity, and timestamps queued labels', async () => {
    const {graph, runCommand} = setup()
    for (const status of ['running', 'done', 'error'] as const) {
      await graph.setTaskProps('source', {status, activity: null, nowMs: 2_000})
      expect(runCommand).toHaveBeenLastCalledWith(expect.objectContaining({
        properties: {'agent:status': status, 'agent:updated-at': 2_000, 'agent:activity': '', 'agent:activity-at': 0},
      }), undefined)
    }
    await graph.setTaskProps('source', {status: 'queued', activity: 'waiting', nowMs: 3_000})
    expect(runCommand).toHaveBeenLastCalledWith(expect.objectContaining({
      properties: {'agent:status': 'queued', 'agent:updated-at': 3_000, 'agent:activity': 'waiting', 'agent:activity-at': 3_000},
    }), undefined)
    await graph.setTaskProps('source', {status: 'done', nowMs: 4_000})
    expect(runCommand).toHaveBeenLastCalledWith(expect.objectContaining({
      properties: {'agent:status': 'done', 'agent:updated-at': 4_000},
    }), undefined)
  })
})

describe('memory outline', () => {
  it('reads the prompt\'s outline and its shared notes from one view\'s bounds, embeds expanded', async () => {
    const {graph, runCommand} = setup()
    runCommand.mockImplementation(async (command: {format?: string}) => (command.format === 'json'
      ? {rows: [{id: 'own'}, {id: 'shared', embedded: {parentId: 'elsewhere', breadcrumb: []}}]}
      : 'Memory  ^mem') as never)

    expect(await graph.memoryOutline('mem')).toEqual({text: 'Memory  ^mem', sharedRoots: ['shared']})
    const views = runCommand.mock.calls.map(([command]) => command as Record<string, unknown>)
    expect(views).toHaveLength(2)
    expect(views[1]).toEqual({...views[0], format: 'json'})
    expect(views[0]).not.toHaveProperty('expandRefs')
  })
})
