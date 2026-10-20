import { InMemoryWorkspaceKeyStore } from '../../keys/keyStore.js'
import { sha256Hex, writeBytesPart, type BundleFolder, type PartDigest } from '../bundle/bundleParts.js'
import type { BundleRecord } from '../bundle/bundleRecord.js'
import { InMemoryBundleRecordStore } from '../bundle/bundleRecord.js'
import { BUNDLE_PARTS } from '../bundle/manifest.js'
import { InMemoryFlipAttempts } from '../flipAttempts.js'
import { resealWorkspace } from '../reseal.js'
import type { PreflightEnvironment } from '../preflight.js'
import type { ConversionLock } from '../runLock.js'
import type { ConversionFlowDeps, ConversionUi } from '../runConversion.js'
import { WS } from './conversionFixtures.js'
import { MemoryBundleFolder } from './memoryBundleFolder.js'
import { createFakeAttachmentStorage } from './fakeAttachmentStorage.js'
import type { FakeConversionServer } from './fakeConversionServer.js'

export const USER = 'user-1'

/** A lock nobody else holds. */
export const freeLock: ConversionLock = async (_name, run) => ({acquired: true, value: await run()})

export const passingEnvironment = (overrides: Partial<PreflightEnvironment> = {}): PreflightEnvironment => ({
  canPersistPins: () => true,
  keyStoreIsDurable: true,
  supportsDirectoryPicker: true,
  uploadQueue: async () => ({pending: 0, rejected: 0}),
  localDbBytes: async () => FAKE_LOCAL_DB.length,
  freeLocalBytes: async () => null,
  ...overrides,
})

/** Stands in for this device's database. */
export const FAKE_LOCAL_DB = new TextEncoder().encode('SQLite format 3\0')

/** Stands in for the SQLite export, writing {@link FAKE_LOCAL_DB} as `local.db`. */
export const writeFakeLocalDb = (folder: BundleFolder): Promise<PartDigest> =>
  writeBytesPart(folder, BUNDLE_PARTS.localDb, FAKE_LOCAL_DB.slice())

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
  bundles: new InMemoryBundleRecordStore(),
  attachments: createFakeAttachmentStorage().io,
  canReadFolder: async () => true,
  writeLocalDb: writeFakeLocalDb,
  keepAwake: async () => () => {},
  upgradePin: async () => ({ok: true}),
  ui,
  flipTiming: {sleep: async () => {}, random: () => 0.5},
  purgeRetry: {attempts: 2, sleep: async () => {}},
  ...overrides,
})

/** A bundle record with nothing archived, over a folder whose manifest is the
 *  one it records: a workspace with no attachments, past the purge. */
export const emptyBundleRecord = (): BundleRecord => {
  const folder = new MemoryBundleFolder('bundle')
  folder.setText(BUNDLE_PARTS.manifest, '{}\n')
  return {
    workspaceId: WS,
    folder,
    manifestSha256: sha256Hex(folder.files.get(BUNDLE_PARTS.manifest)!),
    through: 0,
    blockRows: 0,
    historyRows: 0,
    exportedAt: '2026-10-19T00:00:00.000Z',
    noVerifiedSource: [],
    otherObjectPaths: [],
  }
}

/** The server as the sealing stage leaves it: flipped, every row sealed, and
 *  the history purged into the cleaning phase. */
export const pastThePurge = async (server: FakeConversionServer, wk: CryptoKey, canary: string): Promise<void> => {
  server.flip(WS, canary)
  await resealWorkspace({server, workspaceId: WS, wk})
  server.setPhase(WS, 'cleaning')
}
