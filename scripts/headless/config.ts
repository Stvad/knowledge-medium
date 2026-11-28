import {dirname, resolve} from 'node:path'
import {normalizeProfileName} from '@knowledge-medium/agent-cli/config'
import {z} from 'zod'
import {readOperatorFile} from './operatorFile.ts'

export const DEVICE_STORAGE_FILENAME = 'device.sqlite'
export const PID_FILENAME = 'headless.pid'

const extensions = z.array(z.strictObject({
  block: z.string().trim().min(1),
  file: z.string().trim().min(1),
})).refine(entries => new Set(entries.map(({block}) => block)).size === entries.length, {
  message: 'Each extension block must be listed only once',
})

const common = {
  workspaceId: z.string().trim().min(1),
  stateDir: z.string().trim().min(1),
  profile: z.string().trim().min(1).transform(normalizeProfileName),
  writable: z.boolean().default(false),
  extensions: extensions.optional(),
  /** The `userPageId` of a `PreferencesPage`; unset reads the host account's own. */
  preferencesPage: z.string().trim().min(1).optional(),
}
const e2eeConfig = z.strictObject({
  ...common, mode: z.literal('e2ee'),
  keyFile: z.string().trim().min(1).optional(),
  /** argv, run without a shell; its stdout is the key. */
  keyCommand: z.tuple([z.string().trim().min(1)], z.string()).optional(),
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
  const config = configSchema.parse(JSON.parse(await readOperatorFile(file, 'config'))) as HeadlessConfig
  config.stateDir = resolve(dirname(file), config.stateDir)
  for (const entry of config.extensions ?? []) entry.file = resolve(dirname(file), entry.file)
  if (config.mode === 'e2ee' && config.keyFile !== undefined) config.keyFile = resolve(dirname(file), config.keyFile)
  // A program path, like keyFile, is relative to the config; a bare name still searches PATH.
  if (config.mode === 'e2ee' && config.keyCommand?.[0].includes('/')) {
    const [program, ...args] = config.keyCommand
    config.keyCommand = [resolve(dirname(file), program), ...args]
  }
  return config
}
