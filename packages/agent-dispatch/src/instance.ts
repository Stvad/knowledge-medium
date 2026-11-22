/**
 * What one daemon keeps per machine — its pidfile, state file, generated
 * MCP config and push registration — named after the config's `instance`,
 * so a second daemon on the machine shares none of them with the first. A
 * config without an instance keeps the original names. A named instance's
 * files live in a directory of their own, so no instance name can make a
 * generated file overwrite a config file kept beside them.
 */
import path from 'node:path'
import { agentRuntimeConfigDir } from '@knowledge-medium/agent-cli/config'

const BASE_NAME = 'agent-dispatch'

/** The instance's watch-events consumer, and its directory's name. */
export const instanceName = (instance: string | undefined): string =>
  instance === undefined ? BASE_NAME : `${BASE_NAME}-${instance}`

export interface InstanceFiles {
  /** Single-instance lock (pidfile.ts). */
  pidfile: string
  /** The generated `--mcp-config` for spawned claude runs. */
  mcpConfig: string
  /** Where the state file goes when the config sets no `statePath`. */
  state: string
}

export const instanceFiles = (instance: string | undefined, dir = agentRuntimeConfigDir()): InstanceFiles => {
  if (instance === undefined) {
    return {
      pidfile: path.join(dir, `${BASE_NAME}.pid`),
      mcpConfig: path.join(dir, `${BASE_NAME}-mcp.json`),
      state: path.join(dir, `${BASE_NAME}-state.json`),
    }
  }
  const own = path.join(dir, instanceName(instance))
  return {
    pidfile: path.join(own, 'daemon.pid'),
    mcpConfig: path.join(own, 'mcp.json'),
    state: path.join(own, 'state.json'),
  }
}
