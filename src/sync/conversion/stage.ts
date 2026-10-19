/**
 * Where a workspace's conversion stands, read from the server on every run
 * (docs/workspace-e2ee-conversion.md §6.3), and so what the run does next.
 * The server's phase only moves forward, so a resume never falls back.
 */

import type { WorkspaceConversionRead } from '../keys/conversionState.js'

export type ConversionStage =
  /** Mode `none`: preflight → key → flip. */
  | {readonly kind: 'plaintext'}
  /** Phase `sealing`: recovery bundle → re-seal → verify → purge. */
  | {readonly kind: 'sealing'; readonly canary: string}
  /** Phase `cleaning`: pin upgrade → attachments → `finish_conversion`. */
  | {readonly kind: 'cleaning'; readonly canary: string}
  /** Mode `e2ee` with no conversion row: nothing is left to do. */
  | {readonly kind: 'done'}

export type StageRead =
  | {readonly kind: 'stage'; readonly stage: ConversionStage}
  /** Offline, a PostgREST error or a timeout. */
  | {readonly kind: 'unavailable'}
  /** Signed out, or not a member. */
  | {readonly kind: 'not-visible'}
  /** Only the owner may convert a workspace, and every conversion RPC checks it. */
  | {readonly kind: 'not-owner'}
  /** A state the flip never writes, such as e2ee without a canary, or a mode
   *  this build doesn't know. */
  | {readonly kind: 'unexpected'; readonly detail: string}

export const stageOf = (read: WorkspaceConversionRead, userId: string): StageRead => {
  if (read.kind !== 'read') return {kind: read.kind}
  const {encryptionMode, conversionPhase, wkCanary, ownerUserId} = read.state
  if (ownerUserId !== userId) return {kind: 'not-owner'}
  if (encryptionMode === 'none' && conversionPhase === null) return {kind: 'stage', stage: {kind: 'plaintext'}}
  if (encryptionMode !== 'e2ee' || !wkCanary) {
    return {kind: 'unexpected', detail: `mode ${encryptionMode}, phase ${conversionPhase ?? 'none'}`}
  }
  if (conversionPhase === null) return {kind: 'stage', stage: {kind: 'done'}}
  if (conversionPhase === 'unknown') return {kind: 'unexpected', detail: 'a conversion phase this version of the app does not know'}
  return {kind: 'stage', stage: {kind: conversionPhase, canary: wkCanary}}
}

export type StageKind = ConversionStage['kind']

const STAGE_ORDER: Record<StageKind, number> = {plaintext: 0, sealing: 1, cleaning: 2, done: 3}

/** Whether the server shows a stage before `floor`, the latest one this run
 *  knows the server reached. */
export const stageMovedBack = (floor: StageKind, to: ConversionStage): boolean =>
  STAGE_ORDER[to.kind] < STAGE_ORDER[floor]

export const laterStage = (a: StageKind, b: StageKind): StageKind => (STAGE_ORDER[a] >= STAGE_ORDER[b] ? a : b)
