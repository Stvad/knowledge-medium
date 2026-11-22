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
const e2eeConfig = z.strictObject({
  ...common, mode: z.literal('e2ee'),
  keyFile: z.string().trim().min(1).optional(),
  /** argv, run without a shell; its stdout is the key. */
  keyCommand: z.tuple([z.string().min(1)], z.string()).optional(),
}).refine(config => (config.keyFile === undefined) !== (config.keyCommand === undefined), {
  message: 'Set exactly one of keyFile or keyCommand',
})
const plaintextConfig = z.strictObject({...common, mode: z.literal('plaintext')})
const configSchema = z.discriminatedUnion('mode', [e2eeConfig, plaintextConfig])

export type KeySource =
  | {keyFile: string, keyCommand?: undefined}
  | {keyCommand: readonly [string, ...string[]], keyFile?: undefined}
export type HeadlessConfig =
  | z.input<typeof plaintextConfig>
  | (Omit<z.input<typeof e2eeConfig>, keyof KeySource> & KeySource)

export const readConfig = async (file: string): Promise<HeadlessConfig> => {
  // The refinement makes the parse exactly one KeySource arm.
  const config = configSchema.parse(JSON.parse(await readFile(file, 'utf8'))) as HeadlessConfig
  config.stateDir = resolve(dirname(file), config.stateDir)
  if (config.mode === 'e2ee' && config.keyFile !== undefined) config.keyFile = resolve(dirname(file), config.keyFile)
  return config
}
