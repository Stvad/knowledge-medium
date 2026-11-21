import {
  isReadOnlyAgentCommand, type KnownAgentCommand, type KnownCommandType,
} from '@knowledge-medium/agent-cli/protocol'
import {executeCommand} from '@/plugins/agent-runtime/commands'
import type {AgentRuntimeContext} from '@/plugins/agent-runtime/protocol'

const extensions = {refuse: 'extension loading requires a browser'}
const media = {refuse: 'media storage requires a browser'}
// `writable`: served once the gate is open and the host may upload. For writes
// that bypass the Repo, so its read-only state cannot refuse them.
const commands: Record<KnownCommandType, 'always' | 'open' | 'writable' | {refuse: string}> = {
  ping: 'always',
  health: 'always',
  'rematerialize-workspace': 'always',
  'rejected-uploads': 'always',
  'retry-rejected-upload': 'writable',
  sql: 'open',
  'get-block': 'open',
  'get-subtree': 'open',
  'view-block': 'open',
  'view-outline': 'open',
  'view-backlinks': 'open',
  'view-grouped-backlinks': 'open',
  'view-search': 'open',
  backlinks: 'open',
  'grouped-backlinks': 'open',
  page: 'open',
  'daily-note': 'open',
  search: 'open',
  comments: 'open',
  'recent-changes': 'open',
  'block-history': 'open',
  'data-model': 'open',
  'resolve-block-id': 'open',
  'list-contributors': 'open',
  'describe-runtime': 'open',
  'runtime-summary': 'open',
  'watch-events': 'open',
  'create-block': 'open',
  'update-block': 'open',
  'edit-block': 'open',
  'move-block': 'open',
  'delete-block': 'open',
  'restore-block': 'open',
  'append-markdown': 'open',
  'reconcile-markdown-subtree': 'open',
  'create-page': 'open',
  'add-comment': 'open',
  'create-contributor': 'open',
  eval: {refuse: 'arbitrary code has access to device credentials'},
  'install-extension': extensions,
  'enable-extension': extensions,
  'disable-extension': extensions,
  'uninstall-extension': extensions,
  'audit-extension': extensions,
  'run-action': {refuse: 'actions require the app runtime'},
  'run-backfill': {refuse: 'workspace backfills require an operator'},
  'audit-properties': {refuse: 'property audits require the operator path'},
  'add-media': media,
  'read-media': media,
}

const classified = (type: string): type is KnownCommandType => Object.hasOwn(commands, type)

// Some SQLite pragmas take effect during prepare, even under EXPLAIN.
const isReadOnlyQuery = (sql: string, mode?: string) => isReadOnlyAgentCommand({
  type: 'sql', mode, sql: sql.trimStart().replace(/^explain\b(?:\s+query\s+plan\b)?/i, ''),
})

export const executeHeadlessCommand = async (
  command: KnownAgentCommand,
  context: AgentRuntimeContext,
  gateReason: () => string | null | Promise<string | null>,
  writeRefusal: () => string | null,
): Promise<unknown> => {
  if (!classified(command.type)) throw new Error(`Unsupported headless command: ${command.type}`)
  const policy = commands[command.type]
  if (typeof policy === 'object') throw new Error(`${command.type}: ${policy.refuse}`)
  if (command.type === 'sql' && !isReadOnlyQuery(command.sql, command.mode)) throw new Error('Headless SQL is read-only')
  if (command.type === 'watch-events' && command.watchers.some(w => w.kind === 'sql' && !isReadOnlyQuery(w.sql))) {
    throw new Error('Headless watcher SQL is read-only')
  }
  if (policy !== 'always') {
    const reason = await gateReason()
    if (reason !== null) throw new Error(`Headless gate closed: ${reason}`)
  }
  // Read after the gate, which refreshes the role a command can arrive ahead of.
  const refusal = policy === 'writable' ? writeRefusal() : null
  if (refusal !== null) throw new Error(`${command.type}: ${refusal}`)
  return executeCommand(command, context)
}
