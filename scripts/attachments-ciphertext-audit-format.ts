import { createHash } from 'node:crypto'
import type { ReadAttemptFailure } from '@/plugins/attachments/audit/supabaseAuditIO'

export const redactAuditPath = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12)

const readFailureLabel = (event: Pick<ReadAttemptFailure, 'reason' | 'status'>) =>
  event.status === undefined ? event.reason : `${event.reason} ${event.status}`

export const formatReadAttemptFailureNotice = (event: ReadAttemptFailure) =>
  `attachments ciphertext audit read attempt ${event.attempt}/${event.maxAttempts} failed for obj:${redactAuditPath(event.path)} (${readFailureLabel(event)})`
