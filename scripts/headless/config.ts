import {readFile} from 'node:fs/promises'
import {dirname, resolve} from 'node:path'
import {normalizeProfileName} from '@knowledge-medium/agent-cli/config'
import {z} from 'zod'

export const DEVICE_STORAGE_FILENAME = 'device.sqlite'
export const PID_FILENAME = 'headless.pid'

const common = {
  workspaceId: z.string().trim().min(1),
  stateDir: z.string().trim().min(1),
  profile: z.string().trim().min(1).transform(normalizeProfileName),
  writable: z.boolean().default(false),
  /** The `userPageId` of a `PreferencesPage`; unset reads the host account's own. */
  preferencesPage: z.string().trim().min(1).optional(),
}
const configSchema = z.discriminatedUnion('mode', [
  z.strictObject({...common, mode: z.literal('e2ee'), keyFile: z.string().trim().min(1)}),
  z.strictObject({...common, mode: z.literal('plaintext')}),
])
export type HeadlessConfig = z.input<typeof configSchema>

export const readConfig = async (file: string): Promise<HeadlessConfig> => {
  const config = configSchema.parse(JSON.parse(await readFile(file, 'utf8')))
  config.stateDir = resolve(dirname(file), config.stateDir)
  if (config.mode === 'e2ee') config.keyFile = resolve(dirname(file), config.keyFile)
  return config
}
