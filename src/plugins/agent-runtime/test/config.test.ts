import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const configModuleUrl = pathToFileURL(
  path.join(process.cwd(), 'scripts/agent-runtime-config.mjs'),
).href

interface ConfigModule {
  bridgeSecret: () => Promise<string>
  bridgeUrl: () => string
  loadOrCreateBridgeConfig: () => Promise<{bridgeSecret: string}>
}

const originalEnv = {
  AGENT_RUNTIME_BRIDGE_SECRET: process.env.AGENT_RUNTIME_BRIDGE_SECRET,
  AGENT_RUNTIME_CONFIG_FILE: process.env.AGENT_RUNTIME_CONFIG_FILE,
  AGENT_RUNTIME_HOST: process.env.AGENT_RUNTIME_HOST,
  AGENT_RUNTIME_PORT: process.env.AGENT_RUNTIME_PORT,
  AGENT_RUNTIME_URL: process.env.AGENT_RUNTIME_URL,
}

const restoreEnv = () => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

const loadConfigModule = async () =>
  await import(/* @vite-ignore */ configModuleUrl) as ConfigModule

describe('agent runtime config', () => {
  afterEach(() => {
    restoreEnv()
  })

  it('persists generated bridge secrets', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-runtime-config-'))
    const configFile = path.join(dir, 'agent-bridge.json')
    process.env.AGENT_RUNTIME_CONFIG_FILE = configFile
    delete process.env.AGENT_RUNTIME_BRIDGE_SECRET

    const {loadOrCreateBridgeConfig} = await loadConfigModule()
    const first = await loadOrCreateBridgeConfig()
    const second = await loadOrCreateBridgeConfig()
    const stat = await fs.stat(configFile)

    expect(first.bridgeSecret).toMatch(/^[0-9a-f]{64}$/)
    expect(second.bridgeSecret).toBe(first.bridgeSecret)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('keeps env bridge secrets as an override', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-runtime-config-'))
    const configFile = path.join(dir, 'agent-bridge.json')
    process.env.AGENT_RUNTIME_CONFIG_FILE = configFile
    process.env.AGENT_RUNTIME_BRIDGE_SECRET = 'from-env'

    const {bridgeSecret} = await loadConfigModule()

    expect(await bridgeSecret()).toBe('from-env')
    await expect(fs.stat(configFile)).rejects.toMatchObject({code: 'ENOENT'})
  })

  it('derives the default bridge URL from host and port env vars', async () => {
    delete process.env.AGENT_RUNTIME_URL
    process.env.AGENT_RUNTIME_HOST = '127.0.0.1'
    process.env.AGENT_RUNTIME_PORT = '9876'

    const {bridgeUrl} = await loadConfigModule()

    expect(bridgeUrl()).toBe('http://127.0.0.1:9876')
  })
})
