import { describe, expect, it } from 'vitest'
import {
  formatReadAttemptFailureNotice,
  redactAuditPath,
} from './attachments-ciphertext-audit-format.js'

describe('attachments ciphertext audit formatting', () => {
  it('formats read-attempt diagnostics with a redacted object path', () => {
    const path = 'workspace-id/raw-object-key'
    const notice = formatReadAttemptFailureNotice({
      path,
      attempt: 2,
      maxAttempts: 3,
      reason: 'http-status',
      status: 503,
    })

    expect(notice).toContain(`obj:${redactAuditPath(path)}`)
    expect(notice).toContain('read attempt 2/3')
    expect(notice).toContain('(http-status 503)')
    expect(notice).not.toContain(path)
    expect(notice).not.toContain('workspace-id')
    expect(notice).not.toContain('raw-object-key')
  })

  it('omits status only when the read failure has no HTTP response', () => {
    const withoutStatus = formatReadAttemptFailureNotice({
      path: 'workspace-id/raw-object-key',
      attempt: 1,
      maxAttempts: 3,
      reason: 'fetch-error',
    })
    const withStatus = formatReadAttemptFailureNotice({
      path: 'workspace-id/raw-object-key',
      attempt: 1,
      maxAttempts: 3,
      reason: 'http-status',
      status: 416,
    })

    expect(withoutStatus).toContain('(fetch-error)')
    expect(withStatus).toContain('(http-status 416)')
  })
})
