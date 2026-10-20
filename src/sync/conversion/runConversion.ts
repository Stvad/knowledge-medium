/**
 * The in-app conversion flow on the converting device
 * (docs/workspace-e2ee-conversion.md §3 and §6.3). It reads the server
 * directly — the workspace row for its stage, PostgREST pages for its data —
 * and never this device's PowerSync image, which stops advancing while any
 * write for the workspace is held.
 *
 * Every run reads the stage from the server, so a reload or crash resumes from
 * what the server shows; holds the run lock; re-confirms the single-client
 * contract; and, once the mode is e2ee, opens the server canary with this
 * device's key (or the saved one) before sealing anything.
 */

import type { WorkspaceConversionRead } from '../keys/conversionState.js'
import type { UpgradeWorkspacePinResult } from '../keys/flows/upgradeWorkspacePin.js'
import type { WorkspaceKeyRecord, WorkspaceKeyStore } from '../keys/keyStore.js'
import { obtainFlipKey, requireCanaryKey, type KeyPrompts } from './conversionKey.js'
import type { ConversionServer } from './conversionServer.js'
import { flipToE2ee, type FlipOptions, type FlipWait } from './flip.js'
import type { FlipAttempts } from './flipAttempts.js'
import {
  localBlockers,
  runPreflight,
  type PreflightBlocker,
  type PreflightEnvironment,
  type PreflightReport,
} from './preflight.js'
import { conversionLockName, type ConversionLock } from './runLock.js'
import type { SurveyProgress } from './bundle/attachmentParts.js'
import { runCleaningPass, type CleaningPrompts, type CleaningStatus } from './cleaningStage.js'
import type { CleanerReport } from './attachmentCleaner.js'
import {
  runSealingPass,
  type BundlePrompts,
  type SealingDeps,
  type SealingPass,
  type SealingStatus,
} from './sealingStage.js'
import { laterStage, stageMovedBack, stageOf, type ConversionStage, type StageKind, type StageRead } from './stage.js'

export type ActiveStage = Exclude<ConversionStage, {kind: 'done'}>

/** What the run tells the user while no prompt is waiting. */
export type ConversionStatus =
  | {readonly kind: 'reading-server'}
  /** `progress`: the attachment survey, once it starts. */
  | {readonly kind: 'preflight'; readonly progress: SurveyProgress | null}
  /** `waiting` null: the request is out, and may commit whatever happens to
   *  this run. Otherwise the database refused for now, and a retry is due. */
  | {readonly kind: 'flipping'; readonly waiting: FlipWait | null}
  | {readonly kind: 'checking-key'}
  | SealingStatus
  | {readonly kind: 'upgrading-pin'}
  | CleaningStatus

/** The run's side of the UI. Each prompt settles when the user answers, and
 *  rejects when they cancel, which ends the run. */
export interface ConversionUi extends KeyPrompts, BundlePrompts, CleaningPrompts {
  /** Every other device and tab with this workspace is closed. */
  confirmContract(stage: ActiveStage): Promise<void>
  /** Nothing blocks the conversion, and the user accepts what it leaves behind. */
  confirmPreflight(report: PreflightReport): Promise<void>
  status(status: ConversionStatus): void
}

export interface ConversionFlowDeps
  extends Pick<SealingDeps, 'bundles' | 'attachments' | 'canReadFolder' | 'writeLocalDb' | 'keepAwake' | 'purgeRetry'> {
  readonly userId: string
  readonly workspaceId: string
  readonly server: ConversionServer
  /** The workspace row and its conversion phase, read from the server now. */
  readonly fetchConversionState: () => Promise<WorkspaceConversionRead>
  readonly keyStore: WorkspaceKeyStore
  readonly flipAttempts: FlipAttempts
  readonly lock: ConversionLock
  readonly preflight: PreflightEnvironment
  /** Write this device's `workspaces` row as the server now holds it: e2ee,
   *  with `canary`. The resolver reads the synced row, which would otherwise
   *  say plaintext until a checkpoint delivers the flip, and send this device's
   *  own writes up as plaintext for the server to refuse. */
  readonly markLocalConverted: (canary: string) => Promise<void>
  /** Step 7: this device's one-way pin upgrade, under the stored key, then
   *  the drain. Reopens the workspace here once it succeeds. */
  readonly upgradePin: () => Promise<UpgradeWorkspacePinResult>
  readonly ui: ConversionUi
  readonly signal?: AbortSignal
  readonly generateKeyBytes?: () => Uint8Array<ArrayBuffer>
  readonly flipTiming?: Pick<FlipOptions, 'sleep' | 'random'>
}

export type ConversionRunResult =
  /** Another tab of this browser is running the conversion. */
  | {readonly kind: 'busy'}
  | {readonly kind: 'blocked'; readonly read: Exclude<StageRead, {kind: 'stage'}>}
  | {readonly kind: 'preflight-failed'; readonly blockers: readonly PreflightBlocker[]}
  | {readonly kind: 'flip-refused'; readonly message: string}
  /** The server showed an earlier stage than this run knows it reached. */
  | {readonly kind: 'stage-moved-back'; readonly reached: StageKind; readonly shown: ConversionStage}
  /** The sealing stage ran its passes without the purge going through; the
   *  last pass says why. Nothing is lost: the next run carries on. */
  | {readonly kind: 'sealing-stuck'; readonly pass: Exclude<SealingPass, {kind: 'purged'}>}
  | {readonly kind: 'pin-upgrade-failed'; readonly result: Exclude<UpgradeWorkspacePinResult, {ok: true}>}
  /** The attachment cleaner's proof didn't pass; the report says what holds it back. */
  | {readonly kind: 'cleanup-incomplete'; readonly report: CleanerReport}
  /** The owner's "Clean up attachments" is running in another tab. */
  | {readonly kind: 'cleaner-busy'}
  /** `bundleFolder`: the recovery bundle's folder, when this device recorded one. */
  | {readonly kind: 'done'; readonly bundleFolder: string | null}

/** A stage's steps either end the run, say the server should now show at
 *  least `reached`, or ran a sealing pass that left the stage where it was. */
type StageOutcome =
  | ConversionRunResult
  | {readonly kind: 'advanced'; readonly reached: StageKind}
  | {readonly kind: 'again'; readonly pass: Exclude<SealingPass, {kind: 'purged'}>}

/** Passes of the sealing stage per run before it stops to say why: a purge
 *  refusal that keeps coming back is for investigation, not a retry loop. */
const MAX_SEALING_PASSES = 3

const readStage = async (deps: ConversionFlowDeps): Promise<StageRead> => {
  deps.ui.status({kind: 'reading-server'})
  return stageOf(await deps.fetchConversionState(), deps.userId)
}

const FLIPPED: StageOutcome = {kind: 'advanced', reached: 'sealing'}

/** Whether a flip that may have been sent has landed, or else what the server shows. */
const flipLanded = async (deps: ConversionFlowDeps): Promise<StageRead | 'landed'> => {
  const read = await readStage(deps)
  return read.kind === 'stage' && read.stage.kind !== 'plaintext' ? 'landed' : read
}

const runPlaintextStage = async (deps: ConversionFlowDeps): Promise<StageOutcome> => {
  const {server, workspaceId, ui, signal} = deps
  ui.status({kind: 'preflight', progress: null})
  const release = await deps.keepAwake()
  const preflight = await runPreflight({
    server,
    workspaceId,
    environment: deps.preflight,
    attachments: deps.attachments,
    signal,
    onProgress: progress => ui.status({kind: 'preflight', progress}),
  }).finally(release)
  if (preflight.kind === 'blocked') return {kind: 'preflight-failed', blockers: preflight.blockers}
  await ui.confirmPreflight(preflight.report)

  const key = await obtainFlipKey({...deps, prompts: ui})
  const lastChance = await localBlockers(deps.preflight, deps.attachments, signal)
  if (lastChance.length > 0) return {kind: 'preflight-failed', blockers: lastChance}
  let flip
  try {
    flip = await flipToE2ee({
      server,
      workspaceId,
      canary: key.canary,
      onSend: () => {
        deps.flipAttempts.markSent()
        ui.status({kind: 'flipping', waiting: null})
      },
      onWait: waiting => ui.status({kind: 'flipping', waiting}),
      signal,
      ...deps.flipTiming,
    })
  } catch (error) {
    // Aborted only while waiting to retry, after a refusal that changed nothing.
    if (signal?.aborted) throw error
    // The response may be lost with the flip committed.
    if ((await flipLanded(deps)) === 'landed') return FLIPPED
    throw error
  }
  if (flip.kind === 'refused') {
    // An earlier attempt's flip may have committed after its response was lost.
    const landed = await flipLanded(deps)
    if (landed === 'landed') return FLIPPED
    return landed.kind === 'stage' ? {kind: 'flip-refused', message: flip.message} : {kind: 'blocked', read: landed}
  }
  // The flip succeeded, so the server holds this canary, not a late one's.
  // Between its commit and this mark, an upload already in flight from this
  // device is refused and quarantined, recoverable with Retry: one round trip.
  await deps.markLocalConverted(key.canary)
  return FLIPPED
}

/** What every run past the flip does first. The local row is marked again in
 *  case a crash came between the flip and the first marking, or a checkpoint
 *  from before the flip overwrote it. */
const enterSealedStage = async (deps: ConversionFlowDeps, canary: string): Promise<WorkspaceKeyRecord> => {
  await deps.markLocalConverted(canary)
  deps.ui.status({kind: 'checking-key'})
  return requireCanaryKey({...deps, prompts: deps.ui, canary})
}

const runSealingStage = async (
  deps: ConversionFlowDeps,
  canary: string,
  lastPass: SealingPass | null,
): Promise<StageOutcome> => {
  const key = await enterSealedStage(deps, canary)
  const pass = await runSealingPass(deps, key.wk, {
    retakeReason: lastPass?.kind === 'retake' ? lastPass.reason : null,
    // The last pass re-sealed and verified everything, then dropped only its
    // bundle; the server is as it left it unless the purge found history the
    // bundle lacked.
    resealed: lastPass?.kind === 'retake' && lastPass.reason !== 'stale',
  })
  return pass.kind === 'purged' ? {kind: 'advanced', reached: 'cleaning'} : {kind: 'again', pass}
}

const runCleaningStage = async (deps: ConversionFlowDeps, stage: ActiveStage & {kind: 'cleaning'}): Promise<StageOutcome> => {
  const key = await enterSealedStage(deps, stage.canary)
  deps.ui.status({kind: 'upgrading-pin'})
  const upgraded = await deps.upgradePin()
  if (!upgraded.ok) return {kind: 'pin-upgrade-failed', result: upgraded}
  const pass = await runCleaningPass(deps, key, stage.canary)
  switch (pass.kind) {
    case 'proved':
      return finishConversion(deps)
    case 'not-proved':
      return {kind: 'cleanup-incomplete', report: pass.report}
    case 'busy':
      return {kind: 'cleaner-busy'}
  }
}

/** Step 9. The response may be lost with the phase gone, or a lagging read
 *  have let this run ask twice: the server then refuses, and its stage says. */
const finishConversion = async (deps: ConversionFlowDeps): Promise<StageOutcome> => {
  deps.ui.status({kind: 'finishing'})
  try {
    await deps.server.finishConversion(deps.workspaceId)
  } catch (error) {
    const read = await readStage(deps)
    if (read.kind !== 'stage' || read.stage.kind !== 'done') throw error
  }
  return {kind: 'advanced', reached: 'done'}
}

const runStage = async (
  deps: ConversionFlowDeps,
  stage: ActiveStage,
  lastPass: SealingPass | null,
): Promise<StageOutcome> => {
  switch (stage.kind) {
    case 'plaintext':
      return runPlaintextStage(deps)
    case 'sealing':
      return runSealingStage(deps, stage.canary, lastPass)
    case 'cleaning':
      return runCleaningStage(deps, stage)
  }
}

/** A finished conversion still marks the local row: this device's synced copy
 *  may not have caught up with it yet. The bundle record goes here rather than
 *  after `finish_conversion`, whose response may be lost once it commits. */
const finished = async (deps: ConversionFlowDeps, canary: string): Promise<ConversionRunResult> => {
  await deps.markLocalConverted(canary)
  const record = await deps.bundles.get(deps.userId, deps.workspaceId)
  await deps.bundles.delete(deps.userId, deps.workspaceId)
  return {kind: 'done', bundleFolder: record?.folder.name ?? null}
}

const runLocked = async (deps: ConversionFlowDeps): Promise<ConversionRunResult> => {
  const first = await readStage(deps)
  if (first.kind !== 'stage') return {kind: 'blocked', read: first}
  if (first.stage.kind === 'done') return finished(deps, first.stage.canary)
  await deps.ui.confirmContract(first.stage)

  let reached: StageKind = first.stage.kind
  let lastPass: Exclude<SealingPass, {kind: 'purged'}> | null = null
  let sealingPasses = 0
  for (let stage: ActiveStage = first.stage; ;) {
    deps.signal?.throwIfAborted()
    const outcome = await runStage(deps, stage, lastPass)
    if (outcome.kind === 'advanced') reached = laterStage(reached, outcome.reached)
    else if (outcome.kind !== 'again') return outcome
    lastPass = outcome.kind === 'again' ? outcome.pass : null
    const next = await readStage(deps)
    if (next.kind !== 'stage') return {kind: 'blocked', read: next}
    if (stageMovedBack(reached, next.stage)) return {kind: 'stage-moved-back', reached, shown: next.stage}
    if (next.stage.kind === 'done') return finished(deps, next.stage.canary)
    // Counted only once the server still shows sealing: a pass whose purge
    // landed with its response lost has moved the stage on.
    if (outcome.kind === 'again' && next.stage.kind === 'sealing' && ++sealingPasses >= MAX_SEALING_PASSES) {
      return {kind: 'sealing-stuck', pass: outcome.pass}
    }
    stage = next.stage
  }
}

export const runConversion = async (deps: ConversionFlowDeps): Promise<ConversionRunResult> => {
  const result = await deps.lock(conversionLockName(deps.userId, deps.workspaceId), () => runLocked(deps))
  return result.acquired ? result.value : {kind: 'busy'}
}
