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
import type { WorkspaceKeyStore } from '../keys/keyStore.js'
import { obtainFlipKey, requireCanaryKey, type KeyPrompts } from './conversionKey.js'
import type { ConversionServer } from './conversionServer.js'
import { flipToE2ee, type FlipOptions, type FlipWait } from './flip.js'
import type { FlipAttempts } from './flipAttempts.js'
import { runPreflight, type PreflightEnvironment, type PreflightReport } from './preflight.js'
import { conversionLockName, type ConversionLock } from './runLock.js'
import { laterStage, stageMovedBack, stageOf, type ConversionStage, type StageKind, type StageRead } from './stage.js'

export type ActiveStage = Exclude<ConversionStage, {kind: 'done'}>

/** What the run tells the user while no prompt is waiting. */
export type ConversionStatus =
  | {readonly kind: 'reading-server'}
  | {readonly kind: 'preflight'}
  /** `waiting` null: the request is out, and may commit whatever happens to
   *  this run. Otherwise the database refused for now, and a retry is due. */
  | {readonly kind: 'flipping'; readonly waiting: FlipWait | null}
  | {readonly kind: 'checking-key'}

/** The run's side of the UI. Each prompt settles when the user answers, and
 *  rejects when they cancel, which ends the run. */
export interface ConversionUi extends KeyPrompts {
  /** Every other device and tab with this workspace is closed. */
  confirmContract(stage: ActiveStage): Promise<void>
  /** Nothing blocks the conversion, and the user accepts what it leaves behind. */
  confirmPreflight(report: PreflightReport): Promise<void>
  status(status: ConversionStatus): void
}

export interface ConversionFlowDeps {
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
  readonly ui: ConversionUi
  readonly signal?: AbortSignal
  readonly generateKeyBytes?: () => Uint8Array<ArrayBuffer>
  readonly flipTiming?: Pick<FlipOptions, 'sleep' | 'random'>
}

export type ConversionRunResult =
  /** Another tab of this browser is running the conversion. */
  | {readonly kind: 'busy'}
  | {readonly kind: 'blocked'; readonly read: Exclude<StageRead, {kind: 'stage'}>}
  | {readonly kind: 'preflight-failed'; readonly report: PreflightReport}
  | {readonly kind: 'flip-refused'; readonly message: string}
  /** The server showed an earlier stage than this run knows it reached. */
  | {readonly kind: 'stage-moved-back'; readonly reached: StageKind; readonly shown: ConversionStage}
  /** The run reached a stage this build has no steps for yet. */
  | {readonly kind: 'stopped'; readonly stage: ActiveStage}
  | {readonly kind: 'done'}

/** A stage's steps either end the run, or say the server should now show at
 *  least `reached`. */
type StageOutcome = ConversionRunResult | {readonly kind: 'advanced'; readonly reached: StageKind}

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
  ui.status({kind: 'preflight'})
  const report = await runPreflight({server, workspaceId, environment: deps.preflight, signal})
  if (report.blockers.length > 0) return {kind: 'preflight-failed', report}
  await ui.confirmPreflight(report)

  const key = await obtainFlipKey({...deps, prompts: ui})
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
const enterSealedStage = async (deps: ConversionFlowDeps, canary: string): Promise<void> => {
  await deps.markLocalConverted(canary)
  deps.ui.status({kind: 'checking-key'})
  await requireCanaryKey({...deps, prompts: deps.ui, canary})
}

const runStage = async (deps: ConversionFlowDeps, stage: ActiveStage): Promise<StageOutcome> => {
  switch (stage.kind) {
    case 'plaintext':
      return runPlaintextStage(deps)
    case 'sealing':
    case 'cleaning':
      await enterSealedStage(deps, stage.canary)
      return {kind: 'stopped', stage}
  }
}

const runLocked = async (deps: ConversionFlowDeps): Promise<ConversionRunResult> => {
  const first = await readStage(deps)
  if (first.kind !== 'stage') return {kind: 'blocked', read: first}
  if (first.stage.kind === 'done') return {kind: 'done'}
  await deps.ui.confirmContract(first.stage)

  let reached: StageKind = first.stage.kind
  for (let stage: ActiveStage = first.stage; ;) {
    deps.signal?.throwIfAborted()
    const outcome = await runStage(deps, stage)
    if (outcome.kind !== 'advanced') return outcome
    reached = laterStage(reached, outcome.reached)
    const next = await readStage(deps)
    if (next.kind !== 'stage') return {kind: 'blocked', read: next}
    if (stageMovedBack(reached, next.stage)) return {kind: 'stage-moved-back', reached, shown: next.stage}
    if (next.stage.kind === 'done') return {kind: 'done'}
    stage = next.stage
  }
}

export const runConversion = async (deps: ConversionFlowDeps): Promise<ConversionRunResult> => {
  const result = await deps.lock(conversionLockName(deps.userId, deps.workspaceId), () => runLocked(deps))
  return result.acquired ? result.value : {kind: 'busy'}
}
