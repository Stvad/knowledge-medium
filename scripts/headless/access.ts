import {getWorkspaceKeyStore} from '@/sync/keys/keyStore'
import {getModePin, setModePin} from '@/sync/keys/modePin'
import {unlockWorkspaceWithKey} from '@/sync/keys/flows/unlockWorkspaceWithKey'
import {resolveWorkspaceEntry, type GateWorkspace} from '@/sync/keys/resolveWorkspaceEntry'

/** The configured mode, with the workspace key already read for e2ee. */
export type DeviceAccess =
  | {workspaceId: string, mode: 'plaintext'}
  | {workspaceId: string, mode: 'e2ee', key: string}

export async function openDeviceWorkspace(
  access: DeviceAccess, userId: string, row: GateWorkspace,
): Promise<void> {
  const {workspaceId, mode} = access
  const resolveEntry = () => resolveWorkspaceEntry(userId, workspaceId, async () => row)
  const entry = await resolveEntry()
  const lock = entry.kind === 'locked' ? entry.reason : entry.kind
  const expected = mode === 'plaintext' ? 'none' : 'e2ee'
  if (row.encryptionMode !== expected) throw new Error(`Configured ${mode}, workspace reports ${row.encryptionMode} (${lock})`)
  if (entry.kind === 'locked') {
    if (entry.reason === 'quarantine') {
      setModePin(userId, workspaceId, 'plaintext')
    } else if (access.mode === 'e2ee' && (entry.reason === 'key-required' ||
      (entry.reason === 'server-e2ee' && getModePin(userId, workspaceId) === null))) {
      await unlockWithKey(access, userId, entry.canary)
    } else {
      throw new Error(`Workspace locked: ${entry.reason}`)
    }
  }
  if ((await resolveEntry()).kind !== 'ready' || getModePin(userId, workspaceId) !== mode) {
    throw new Error('Workspace is not ready with the configured mode pin')
  }
}

async function unlockWithKey(
  access: Extract<DeviceAccess, {mode: 'e2ee'}>, userId: string, canary: string | null,
): Promise<void> {
  if (!canary) throw new Error('Encrypted workspace is missing its key canary')
  const result = await unlockWorkspaceWithKey({
    userId, workspaceId: access.workspaceId, canary, pastedKey: access.key, keyStore: getWorkspaceKeyStore(),
  })
  if (!result.ok) throw new Error(`Workspace key refused: ${result.reason}`)
}
