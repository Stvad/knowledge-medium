import {describe, expect, it} from 'vitest'
import path from 'node:path'
import {instanceFiles, instanceName} from '../src/instance'

describe('daemon instance', () => {
  it('keeps the original per-machine names when the config names no instance', () => {
    expect(instanceName(undefined)).toBe('agent-dispatch')
    expect(instanceFiles(undefined, '/cfg')).toEqual({
      pidfile: '/cfg/agent-dispatch.pid',
      mcpConfig: '/cfg/agent-dispatch-mcp.json',
      state: '/cfg/agent-dispatch-state.json',
    })
  })

  it('gives every instance files no other instance uses', () => {
    // Names chosen to land on another instance's files if the scheme let them.
    const instances = [undefined, 'host', 'mcp', 'state', 'host-mcp', 'host-state']
    const paths = instances.flatMap(instance => Object.values(instanceFiles(instance, '/cfg')))
    expect(new Set(paths).size).toBe(paths.length)
    const names = instances.map(instanceName)
    expect(new Set(names).size).toBe(names.length)
  })

  it('keeps a named instance\'s files out of the directory its config sits in', () => {
    // A config named after the instance (agent-dispatch-mcp.json for "mcp") is never overwritten.
    for (const instance of ['mcp', 'state', 'host']) {
      for (const file of Object.values(instanceFiles(instance, '/cfg'))) {
        expect(path.dirname(file)).toBe(`/cfg/agent-dispatch-${instance}`)
      }
    }
  })
})
