import type {KnownAgentCommand} from '@knowledge-medium/agent-cli/protocol'
import {expect} from 'vitest'

export const readCommands = (id: string): KnownAgentCommand[] => [
  {type: 'ping'},
  {type: 'health'},
  {type: 'rematerialize-workspace'},
  {type: 'sql', sql: 'SELECT content FROM blocks WHERE id = ?', params: [id]},
  {type: 'get-block', id},
  {type: 'get-subtree', rootId: id},
  {type: 'view-block', ref: id},
  {type: 'view-outline', ref: id},
  {type: 'view-memory-index', ref: id},
  {type: 'view-backlinks', ref: id},
  {type: 'view-grouped-backlinks', ref: id},
  {type: 'view-search', query: 'fixture'},
  {type: 'backlinks', id, filter: 'effective'},
  {type: 'grouped-backlinks', id, filter: 'stored', grouping: 'user'},
  {type: 'page', name: 'fixture'},
  {type: 'daily-note', date: 'today'},
  {type: 'search', query: 'fixture'},
  {type: 'comments', block: id},
  {type: 'recent-changes'},
  {type: 'block-history', id},
  {type: 'data-model', topic: 'all'},
  {type: 'resolve-block-id', ref: id},
  {type: 'list-contributors'},
  {type: 'describe-runtime', storage: true},
  {type: 'runtime-summary'},
  {type: 'watch-events', consumer: 'test', watchers: [{kind: 'backlinks', name: 'fixture', targetId: id}]},
  {type: 'watch-events', consumer: 'test', watchers: []},
]

export const assertReadSurface = async (
  execute: (command: KnownAgentCommand) => Promise<unknown>,
  id: string,
  secrets: {deviceValue: string; workspaceKey: string},
): Promise<void> => {
  for (const command of readCommands(id)) {
    const result = await execute(command)
    if (command.type === 'get-block') expect(result).toMatchObject({id})
    const wire = JSON.stringify(result)
    expect(wire, command.type).not.toContain(secrets.deviceValue)
    expect(wire, command.type).not.toContain(secrets.workspaceKey)
  }
  await expect(execute({type: 'create-block', parentId: id, content: 'write attempt', contributorId: null}))
    .rejects.toThrow(/tx scope .* is rejected in read-only mode/)
}
