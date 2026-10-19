/**
 * The flip (docs/workspace-e2ee-conversion.md §6.3 step 2):
 * `convert_workspace_to_e2ee` sets the mode and canary and begins `sealing`,
 * changing no row. It takes its table lock NOWAIT, because a waiting request
 * would queue every tenant's writes behind it, so while any block write is in
 * flight it refuses with `55P03` and is retried here, with backoff and jitter.
 */

import { ConversionErrorCode, errorCodeOf, type ConversionServer } from './conversionServer.js'

export type FlipResult =
  | {readonly kind: 'flipped'}
  /** `KMC01`: not the owner, a malformed canary, or the workspace is not plaintext. */
  | {readonly kind: 'refused'; readonly message: string}

export interface FlipWait {
  /** Lock refusals so far. */
  readonly attempt: number
  readonly retryInMs: number
}

export interface FlipOptions {
  readonly server: ConversionServer
  readonly workspaceId: string
  readonly canary: string
  /** Each time the flip waits for the database before trying again. */
  readonly onWait?: (wait: FlipWait) => void
  readonly signal?: AbortSignal
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  readonly random?: () => number
}

const FIRST_RETRY_MS = 500
const MAX_RETRY_MS = 30_000

export const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    signal?.addEventListener('abort', onAbort, {once: true})
  })

/** Any other failure throws: the flip may have committed with its response
 *  lost, so the caller re-reads the server before trying again. */
export const flipToE2ee = async ({
  server,
  workspaceId,
  canary,
  onWait,
  signal,
  sleep = abortableSleep,
  random = Math.random,
}: FlipOptions): Promise<FlipResult> => {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted()
    try {
      await server.convertWorkspaceToE2ee(workspaceId, canary)
      return {kind: 'flipped'}
    } catch (error) {
      const code = errorCodeOf(error)
      if (code === ConversionErrorCode.refused) {
        return {kind: 'refused', message: error instanceof Error ? error.message : String(error)}
      }
      if (code !== ConversionErrorCode.lockNotAvailable) throw error
    }
    // Full jitter: the writes it waits on may come from any number of tenants.
    const retryInMs = Math.round(random() * Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** (attempt - 1)))
    onWait?.({attempt, retryInMs})
    await sleep(retryInMs, signal)
  }
}
