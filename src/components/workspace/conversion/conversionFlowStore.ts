/**
 * Which workspace's conversion flow is open in this tab, if any. The flow is
 * mounted above the swap between the workspace and its gate, because the flip
 * closes the workspace into the gate mid-run, and the pin upgrade opens it
 * again: one instance has to span both.
 */

import { useSyncExternalStore } from 'react'
import { CallbackSet } from '@/utils/callbackSet'

export interface ConversionFlowTarget {
  readonly workspaceId: string
  readonly workspaceName: string | null
}

let target: ConversionFlowTarget | null = null
const subscribers = new CallbackSet('conversionFlow')

const set = (next: ConversionFlowTarget | null): void => {
  target = next
  subscribers.notify()
}

export const openConversionFlow = (next: ConversionFlowTarget): void => set(next)
export const closeConversionFlow = (): void => set(null)

export const conversionFlowTarget = (): ConversionFlowTarget | null => target

export const useConversionFlowTarget = (): ConversionFlowTarget | null =>
  useSyncExternalStore(callback => subscribers.add(callback), conversionFlowTarget)

/** Offered from workspace settings only in development builds until the flow
 *  can finish a conversion: preflight, key and flip are built, the recovery
 *  bundle and cleanup are not (#1290). The gate offers to continue a
 *  conversion that has already flipped in every build. */
export const CONVERSION_START_ENABLED = import.meta.env.DEV
