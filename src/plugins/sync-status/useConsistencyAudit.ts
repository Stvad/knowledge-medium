import { useSyncExternalStore } from 'react'
import type { ConsistencyAuditResult } from '@/data/internals/consistencyAudit.js'
import {
  getConsistencyAuditSnapshot,
  subscribeConsistencyAudit,
} from '@/data/internals/consistencyAuditStore.js'

/** Latest built-in consistency-audit result (L3), or null until the first audit
 *  completes this session. Re-renders when a new audit publishes. */
export const useConsistencyAudit = (): ConsistencyAuditResult | null =>
  useSyncExternalStore(
    subscribeConsistencyAudit,
    getConsistencyAuditSnapshot,
    getConsistencyAuditSnapshot,
  )
