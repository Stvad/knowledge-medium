import { InMemoryWorkspaceKeyStore } from '../../keys/keyStore.js'
import { InMemoryFlipAttempts } from '../flipAttempts.js'
import type { PreflightEnvironment } from '../preflight.js'
import type { ConversionLock } from '../runLock.js'
import type { ConversionFlowDeps, ConversionUi } from '../runConversion.js'
import { WS } from './conversionFixtures.js'
import type { FakeConversionServer } from './fakeConversionServer.js'

export const USER = 'user-1'

/** A lock nobody else holds. */
export const freeLock: ConversionLock = async (_name, run) => ({acquired: true, value: await run()})

export const passingEnvironment = (overrides: Partial<PreflightEnvironment> = {}): PreflightEnvironment => ({
  canPersistPins: () => true,
  keyStoreIsDurable: true,
  supportsDirectoryPicker: true,
  uploadQueue: async () => ({pending: 0, rejected: 0}),
  ...overrides,
})

/** A run of the conversion of {@link WS} by {@link USER}, against the fake server. */
export const flowDeps = (
  server: FakeConversionServer,
  ui: ConversionUi,
  overrides: Partial<ConversionFlowDeps> = {},
): ConversionFlowDeps => ({
  userId: USER,
  workspaceId: WS,
  server,
  fetchConversionState: () => server.conversionState(WS),
  keyStore: new InMemoryWorkspaceKeyStore(),
  flipAttempts: new InMemoryFlipAttempts(),
  lock: freeLock,
  preflight: passingEnvironment(),
  markLocalConverted: async () => {},
  ui,
  flipTiming: {sleep: async () => {}, random: () => 0.5},
  ...overrides,
})
