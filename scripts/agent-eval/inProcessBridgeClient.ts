/**
 * A BridgeClient that hands each wire command to the runtime's own
 * `executeCommand` and returns what the bridge loop would, so the real CLI,
 * MCP server and dispatch daemon code can drive a node repo. Free of fixture
 * imports: the km MCP server they reach fails to load under happy-dom.
 */
import { knownAgentCommandSchema } from '@knowledge-medium/agent-cli/protocol'
import type { BridgeClient } from '../../packages/agent-cli/src/client'
import { commandResult } from '@/plugins/agent-runtime/bridgeLoop'
import { executeCommand } from '@/plugins/agent-runtime/commands'
import type { AgentRuntimeContext } from '@/plugins/agent-runtime/protocol'

export const createInProcessBridgeClient = (
  context: AgentRuntimeContext,
  overrides: Partial<BridgeClient> = {},
): BridgeClient => ({
  bridgeUrl: 'in-process://test',
  runCommand: async command => {
    const result = await commandResult(() => executeCommand(knownAgentCommandSchema.parse({contributorId: null, ...command}), context))
    if (!result.ok) throw new Error(result.error.message)
    return JSON.parse(JSON.stringify(result.value)) as unknown
  },
  nextEvents: async () => ({events: [], nextSeq: 0}),
  whoami: async () => {
    throw new Error('whoami is not served in process')
  },
  health: async () => {},
  resolveToken: async () => 'in-process',
  ...overrides,
})
