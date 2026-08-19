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
    // Media capture has SHIPPED, so this audit is the sole server-side ciphertext
    // tripwire (the §10.1 reversal dropped the write-path guard). A missing
    // credential is therefore a MISCONFIGURATION that disarms confidentiality
    // monitoring, not a benign pre-launch state — fail LOUD (red ::error:: +
    // non-zero exit) so it can't pass unnoticed as a yellow warning. (Pre-launch
    // this was exit 0 + a warning; that caveat is now resolved.)
    return {
      exitCode: 1,
      notices: [],
      warnings: [],
      // Generic wording on purpose: this file is under src/ (bundle-scanned), so
      // it must not contain the literal privileged-key env var name. The exact
      // var names live in the entrypoint + the workflow (neither bundled).
      errors: ['attachments ciphertext audit NOT ARMED — required credentials unset; the tripwire did not run (configure the privileged key)'],
      summary:
        '### ❌ Attachments ciphertext audit — NOT ARMED\nRequired credentials unset, so the audit did not run. This is the sole server-side ciphertext check — configure the key.',
    }
  }

  const { workspaces, scanned, findings } = outcome.result
  const tally = `${workspaces} E2EE workspace(s), ${scanned} object(s) scanned, ${findings.length} finding(s)`
  const notices = [`attachments ciphertext audit: ${tally}`]

  if (findings.length === 0) {
    // Surface the coverage BOUND so a green run isn't misread as "no plaintext
    // anywhere": the scan set is the workspaces the server LABELS e2ee
    // (`listE2eeWorkspaceIds`, keyed on the design-untrusted `encryption_mode`
    // column). A workspace mislabeled non-e2ee is not enumerated, so its objects
    // aren't checked here — the read-side hash-verify (§5.1) is the load-bearing
    // confidentiality control; this audit is an honest-client tripwire over the
    // labeled set, not a proof over all storage (§10.1/§17).
    const coverageNote =
      'Coverage is scoped to server-labeled e2ee workspaces — a workspace mislabeled non-e2ee is not scanned, so this is not proof of zero plaintext across all storage.'
    return {
      exitCode: 0,
      notices,
      warnings: [],
      errors: [],
      summary: `### ✅ Attachments ciphertext audit — armed and clean\n${tally}.\n\n> ${coverageNote}`,
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
