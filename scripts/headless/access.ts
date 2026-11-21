import {open} from 'node:fs/promises'
import {getWorkspaceKeyStore} from '@/sync/keys/keyStore'
import {getModePin, setModePin} from '@/sync/keys/modePin'
import {unlockWorkspaceWithKey} from '@/sync/keys/flows/unlockWorkspaceWithKey'
import {resolveWorkspaceEntry, type GateWorkspace} from '@/sync/keys/resolveWorkspaceEntry'
import type {HeadlessConfig} from './config'

export async function openDeviceWorkspace(
  config: HeadlessConfig, userId: string, row: GateWorkspace,
): Promise<void> {
  const {workspaceId, mode} = config
  const resolveEntry = () => resolveWorkspaceEntry(userId, workspaceId, async () => row)
  const entry = await resolveEntry()
  const lock = entry.kind === 'locked' ? entry.reason : entry.kind
  const expected = mode === 'plaintext' ? 'none' : 'e2ee'
  if (row.encryptionMode !== expected) throw new Error(`Configured ${mode}, workspace reports ${row.encryptionMode} (${lock})`)
  if (entry.kind === 'locked') {
    if (entry.reason === 'quarantine') {
      setModePin(userId, workspaceId, 'plaintext')
    } else if (config.mode === 'e2ee' && (entry.reason === 'key-required' ||
      (entry.reason === 'server-e2ee' && getModePin(userId, workspaceId) === null))) {
      await unlockFromFile(config, userId, entry.canary)
    } else {
      throw new Error(`Workspace locked: ${entry.reason}`)
    }
  }
  if ((await resolveEntry()).kind !== 'ready' || getModePin(userId, workspaceId) !== mode) {
    throw new Error('Workspace is not ready with the configured mode pin')
  }
}

async function unlockFromFile(
  config: Extract<HeadlessConfig, {mode: 'e2ee'}>, userId: string, canary: string | null,
): Promise<void> {
  if (!canary) throw new Error('Encrypted workspace is missing its key canary')
  const handle = await open(config.keyFile, 'r')
  try {
    if (((await handle.stat()).mode & 0o777) !== 0o600) throw new Error('Key file must have mode 0600')
    const result = await unlockWorkspaceWithKey({
      userId, workspaceId: config.workspaceId, canary, pastedKey: (await handle.readFile('utf8')).trim(),
      keyStore: getWorkspaceKeyStore(),
    })
    if (!result.ok) throw new Error(`Workspace key refused: ${result.reason}`)
  } finally {
    await handle.close()
  }
}
