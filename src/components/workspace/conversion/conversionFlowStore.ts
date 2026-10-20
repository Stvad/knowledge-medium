/**
 * Which workspace's conversion flow is open in this tab, if any. The flow is
 * mounted above the swap between the workspace and its gate, because the flip
 * closes the workspace into the gate mid-run, and the pin upgrade opens it
 * again: one instance has to span both.
 */

import { useSyncExternalStore } from 'react'
import { CallbackSet } from '@/utils/callbackSet'

export interface ConversionFlowTarget {
  /** Who opened it: the store outlives a sign-out, and another account never
   *  sees this one's flow. */
  readonly userId: string
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

/** Starting a conversion is offered from workspace settings only in
 *  development builds until it has run against the hosted project (#1290). A
 *  conversion already under way is offered to continue in every build. */
export const CONVERSION_START_ENABLED = import.meta.env.DEV
