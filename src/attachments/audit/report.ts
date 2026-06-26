import type { AuditResult, FindingKind } from './types.js'

export const REASONS: Record<FindingKind, string> = {
  nested: 'unexpected NESTED entry under an E2EE prefix (layout must be flat — could hide plaintext)',
  unreadable: 'UNREADABLE object under an E2EE prefix (empty/truncated/errored — not verifiable as ciphertext)',
  plaintext: 'non-ciphertext object in an E2EE workspace',
}

/** The GitHub-Actions output an audit run should emit, as pure data the
 *  entrypoint just prints. Extracted from the entrypoint so the decision logic —
 *  exit code, NOT-ARMED handling, and the redaction of every path — is unit
 *  tested rather than living in untested glue. */
export interface AuditReport {
  exitCode: 0 | 1
  notices: string[]
  warnings: string[]
  /** ::error:: lines — paths are already redacted; safe for a public CI log. */
  errors: string[]
  /** GITHUB_STEP_SUMMARY markdown. */
  summary: string
}

export type AuditOutcome = { armed: false } | { armed: true; result: AuditResult }

/**
 * Turn an audit outcome into the lines + exit code the entrypoint emits. Pure;
 * `redact` (a sha256 prefix in production) keeps raw workspace ids / object names
 * out of the public-repo CI log — applied here, to EVERY path, so the no-PII
 * guarantee is tested, not assumed.
 */
export function buildReport(outcome: AuditOutcome, redact: (s: string) => string): AuditReport {
  if (!outcome.armed) {
    // A green ::notice:: would make a never-configured (never-running) tripwire
    // look like a healthy pass — a yellow ::warning:: keeps it distinct. Exit 0:
    // the key is legitimately unset until media capture ships.
    return {
      exitCode: 0,
      notices: [],
      warnings: [
        'attachments ciphertext audit NOT ARMED — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY unset; the tripwire did not run',
      ],
      errors: [],
      summary:
        '### ⚠️ Attachments ciphertext audit — NOT ARMED\nSecrets not configured; the audit did not run. Set the key before media capture (Phase 5) ships.',
    }
  }

  const { workspaces, scanned, findings } = outcome.result
  const tally = `${workspaces} E2EE workspace(s), ${scanned} object(s) scanned, ${findings.length} finding(s)`
  const notices = [`attachments ciphertext audit: ${tally}`]

  if (findings.length === 0) {
    return {
      exitCode: 0,
      notices,
      warnings: [],
      errors: [],
      summary: `### ✅ Attachments ciphertext audit — armed and clean\n${tally}.`,
    }
  }

  return {
    exitCode: 1,
    notices,
    warnings: [],
    errors: [
      ...findings.map((f) => `${REASONS[f.kind]}: obj:${redact(f.path)}`),
      `${findings.length} finding(s) under an E2EE prefix — a client is uploading plaintext, nesting, or writing unverifiable objects (§10.1/§17)`,
    ],
    summary: `### ❌ Attachments ciphertext audit — ${findings.length} finding(s)\n${tally}. Plaintext, non-flat, or unreadable object under an E2EE workspace (§10.1/§17).`,
  }
}
