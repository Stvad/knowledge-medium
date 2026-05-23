import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomBytes } from 'node:crypto'

export const defaultBridgeHost = '127.0.0.1'
export const defaultBridgePort = 8787
export const defaultAppUrl = 'https://stvad.github.io/knowledge-medium/'

export const agentRuntimeConfigDir = () =>
  process.env.AGENT_RUNTIME_CONFIG_DIR
  ?? path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
    'knowledge-medium',
  )

export const bridgeConfigPath = () =>
  process.env.AGENT_RUNTIME_CONFIG_FILE
  ?? path.join(agentRuntimeConfigDir(), 'agent-bridge.json')

export const tokenStorePath = () =>
  process.env.AGENT_RUNTIME_TOKEN_FILE
  ?? path.join(agentRuntimeConfigDir(), 'agent-token.json')

export const bridgeLogPath = () =>
  process.env.AGENT_RUNTIME_LOG_FILE
  ?? path.join(agentRuntimeConfigDir(), 'agent-bridge.log')

interface BridgeConfig {
  bridgeSecret?: string
  createdAt?: number
}

interface ResolvedBridgeConfig {
  bridgeSecret: string
  createdAt: number
}

const isErrnoException = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string'

const normalizeBridgeConfig = (value: unknown): BridgeConfig => {
  if (!value || typeof value !== 'object') return {}
  const candidate = value as {bridgeSecret?: unknown, createdAt?: unknown}

  return {
    bridgeSecret: typeof candidate.bridgeSecret === 'string'
      ? candidate.bridgeSecret.trim()
      : '',
    createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : undefined,
  }
}

export const loadBridgeConfig = async (): Promise<BridgeConfig> => {
  try {
    const raw = await fs.readFile(bridgeConfigPath(), 'utf8')
    return normalizeBridgeConfig(JSON.parse(raw))
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return {}
    throw error
  }
}

export const loadOrCreateBridgeConfig = async (): Promise<ResolvedBridgeConfig> => {
  const existing = await loadBridgeConfig()
  if (existing.bridgeSecret) {
    return {bridgeSecret: existing.bridgeSecret, createdAt: existing.createdAt ?? Date.now()}
  }

  const next: ResolvedBridgeConfig = {
    bridgeSecret: randomBytes(32).toString('hex'),
    createdAt: existing.createdAt ?? Date.now(),
  }

  const file = bridgeConfigPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  await fs.chmod(file, 0o600)
  return next
}

export const bridgeHost = () =>
  process.env.AGENT_RUNTIME_HOST?.trim() || defaultBridgeHost

export const bridgePort = () => {
  const port = Number(process.env.AGENT_RUNTIME_PORT ?? defaultBridgePort)
  return Number.isFinite(port) && port > 0 ? port : defaultBridgePort
}

const bridgeUrlHost = () => {
  const host = bridgeHost()
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

export const bridgeServerUrl = () =>
  `http://${bridgeUrlHost()}:${bridgePort()}`.replace(/\/+$/, '')

export const bridgeUrl = () =>
  (
    process.env.AGENT_RUNTIME_URL?.trim()
    || bridgeServerUrl()
  ).replace(/\/+$/, '')

export const bridgeSecret = async (): Promise<string> =>
  process.env.AGENT_RUNTIME_BRIDGE_SECRET?.trim()
  || (await loadOrCreateBridgeConfig()).bridgeSecret

export const appUrl = () =>
  process.env.AGENT_RUNTIME_APP_URL?.trim() || defaultAppUrl

export const pairingUrl = async (
  runtimeBridgeUrl = bridgeUrl(),
  options: {openTokensDialog?: boolean} = {},
) => {
  const url = new URL(appUrl())
  const rawHash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash
  const separator = rawHash
    ? rawHash.includes('?') ? '&' : '?'
    : '?'
  url.hash = `${rawHash}${separator}`
    + `agent-runtime-url=${encodeURIComponent(runtimeBridgeUrl)}`
    + `&agent-runtime-secret=${encodeURIComponent(await bridgeSecret())}`
    + (options.openTokensDialog ? '&agent-runtime-open-tokens=1' : '')
  return url.toString()
}

export const isLocalBridgeUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1' || url.hostname === '[::1]')
    )
  } catch {
    return false
  }
}
