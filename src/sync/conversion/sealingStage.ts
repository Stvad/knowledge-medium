/**
 * The `sealing` stage (docs/workspace-e2ee-conversion.md §6.3 steps 3–6):
 * recovery bundle (unless this device holds a verified one) → re-seal →
 * verify → re-check the bundle → purge. Every step is safe to run again, and
 * nothing here keeps state the server or the bundle record doesn't, so a
 * resume just runs the stage again.
 */

import type { BundleFolder } from './bundle/bundleParts.js'
import { bundleRecordOf, type BundleRecord, type BundleRecordStore } from './bundle/bundleRecord.js'
import { takeBundle, type BundleProgress } from './bundle/takeBundle.js'
import { BundleInvalid, verifyBundle } from './bundle/verifyBundle.js'
import { ConversionErrorCode, errorCodeOf, type ConversionServer } from './conversionServer.js'
import { abortableSleep } from '@/utils/abortableSleep.js'
import { resealWorkspace, type ResealProgress } from './reseal.js'
import { verifyReseal, type VerifyProgress } from './verifyReseal.js'

/** Why a new bundle is needed although this run had one. */
export type BundleRetakeReason =
  /** The purge found history the bundle doesn't hold (`KMC02`). */
  | 'stale'
  /** The recorded folder can't be read, or no longer matches its record. */
  | 'changed'

export interface BundlePrompts {
  /** Resolve with a folder, picked by the user, to write a new bundle into. */
  chooseBundleFolder(prompt: {readonly reason: BundleRetakeReason | null}): Promise<BundleFolder>
  /** Resolve with the bundle's folder readable again: the recorded one once the
   *  user grants access, or the one they pick; null to take a new bundle. */
  reopenBundleFolder(prompt: {readonly recorded: BundleFolder}): Promise<BundleFolder | null>
}

export type SealingStatus =
  | {readonly kind: 'taking-bundle'; readonly progress: BundleProgress | null}
  | {readonly kind: 'resealing'; readonly progress: ResealProgress | null}
  | {readonly kind: 'verifying'; readonly progress: VerifyProgress | null}
  | {readonly kind: 'checking-bundle'}
  | {readonly kind: 'purging'}

export interface SealingDeps {
  readonly userId: string
  readonly workspaceId: string
  readonly server: ConversionServer
  readonly bundles: BundleRecordStore
  /** Whether the folder can be read now, without asking the user. */
  readonly canReadFolder: (folder: BundleFolder) => Promise<boolean>
  /** Write this device's database, copied under its lock, into the folder. */
  readonly writeLocalDb: (folder: BundleFolder) => Promise<void>
  /** Keep the screen awake for a long pass; resolves to the release. */
  readonly keepAwake: () => Promise<() => void>
  readonly ui: BundlePrompts & {status(status: SealingStatus): void}
  readonly signal?: AbortSignal
  readonly now?: () => Date
  readonly purgeRetry?: {readonly attempts: number; readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>}
}

/** How one pass of the stage ended. Each but `purged` leaves the stage at
 *  `sealing` for another pass to carry on from. */
export type SealingPass =
  | {readonly kind: 'purged'}
  /** `KMC01`: a row isn't sealed (or the purge already ran). The bundle record
   *  stays; the next pass re-seals what's left. */
  | {readonly kind: 'purge-refused'; readonly message: string}
  /** The bundle record was cleared; the next pass takes a new bundle. */
  | {readonly kind: 'retake'; readonly reason: BundleRetakeReason}

/** A fresh folder for one bundle, inside the one the user picked. */
const bundleFolderName = (workspaceId: string, at: Date): string =>
  `km-recovery-${workspaceId.slice(0, 8)}-${at.toISOString().replace(/[:.]/g, '-')}`

const createBundleFolder = async (parent: BundleFolder, workspaceId: string, at: Date): Promise<BundleFolder> => {
  const base = bundleFolderName(workspaceId, at)
  for (let suffix = 0; ; suffix++) {
    const name = suffix === 0 ? base : `${base}-${suffix}`
    try {
      await parent.getDirectoryHandle(name)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return parent.getDirectoryHandle(name, {create: true})
      throw error
    }
  }
}

const takeVerifiedBundle = async (deps: SealingDeps, reason: BundleRetakeReason | null): Promise<BundleRecord> => {
  const {userId, workspaceId, server, ui, signal} = deps
  const parent = await ui.chooseBundleFolder({reason})
  const folder = await createBundleFolder(parent, workspaceId, deps.now?.() ?? new Date())
  ui.status({kind: 'taking-bundle', progress: null})
  await takeBundle({
    server,
    workspaceId,
    folder,
    writeLocalDb: deps.writeLocalDb,
    now: deps.now,
    onProgress: progress => ui.status({kind: 'taking-bundle', progress}),
    signal,
  })
  // Read back from the folder, not from what was written: this is what the
  // record vouches for.
  const record = bundleRecordOf(await verifyBundle({folder, workspaceId, signal}), folder)
  await deps.bundles.put(userId, workspaceId, record)
  return record
}

/** Step 6.1. The re-seal can take hours, and the folder may have been moved
 *  or changed meanwhile. */
const bundleStillMatches = async (deps: SealingDeps, record: BundleRecord): Promise<boolean> => {
  const {userId, workspaceId, ui, signal} = deps
  ui.status({kind: 'checking-bundle'})
  const folder = (await deps.canReadFolder(record.folder)) ? record.folder : await ui.reopenBundleFolder({recorded: record.folder})
  if (!folder) return false
  try {
    await verifyBundle({folder, workspaceId, manifestSha256: record.manifestSha256, signal})
  } catch (error) {
    if (error instanceof BundleInvalid) return false
    throw error
  }
  if (folder !== record.folder) await deps.bundles.put(userId, workspaceId, {...record, folder})
  return true
}

const isServerAnswer = (error: unknown): boolean => {
  const code = errorCodeOf(error)
  return code === ConversionErrorCode.refused || code === ConversionErrorCode.staleBundle
}

/** A transport failure is retried in place: re-running the stage would repeat
 *  the whole verify pass first. A purge whose response was lost shows up on the
 *  retry as a `KMC01` over the phase, which the stage read then resolves. */
const purge = async (deps: SealingDeps, record: BundleRecord): Promise<void> => {
  const {attempts, sleep} = deps.purgeRetry ?? {attempts: 4, sleep: abortableSleep}
  for (let attempt = 1; ; attempt++) {
    try {
      return await deps.server.purgeWorkspaceHistory(deps.workspaceId, record.through, record.historyRows)
    } catch (error) {
      if (isServerAnswer(error) || attempt >= attempts) throw error
      await sleep(1000 * 2 ** attempt, deps.signal)
    }
  }
}

const withScreenAwake = async <T>(deps: SealingDeps, run: () => Promise<T>): Promise<T> => {
  const release = await deps.keepAwake()
  try {
    return await run()
  } finally {
    release()
  }
}

export const runSealingPass = async (
  deps: SealingDeps,
  wk: CryptoKey,
  retakeReason: BundleRetakeReason | null,
): Promise<SealingPass> => {
  const {userId, workspaceId, server, ui, signal} = deps
  const record = (await deps.bundles.get(userId, workspaceId)) ?? (await takeVerifiedBundle(deps, retakeReason))

  await withScreenAwake(deps, async () => {
    ui.status({kind: 'resealing', progress: null})
    await resealWorkspace({server, workspaceId, wk, signal, onProgress: progress => ui.status({kind: 'resealing', progress})})
    ui.status({kind: 'verifying', progress: null})
    await verifyReseal({server, workspaceId, wk, signal, onProgress: progress => ui.status({kind: 'verifying', progress})})
  })

  if (!(await bundleStillMatches(deps, record))) {
    await deps.bundles.delete(userId, workspaceId)
    return {kind: 'retake', reason: 'changed'}
  }

  ui.status({kind: 'purging'})
  try {
    await purge(deps, record)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (errorCodeOf(error) === ConversionErrorCode.refused) return {kind: 'purge-refused', message}
    if (errorCodeOf(error) === ConversionErrorCode.staleBundle) {
      await deps.bundles.delete(userId, workspaceId)
      return {kind: 'retake', reason: 'stale'}
    }
    throw error
  }
  return {kind: 'purged'}
}
