/**
 * Off-path ciphertext audit entrypoint (design §10.1 / §17).
 * Run: `yarn audit:attachments-ciphertext` (vite-node).
 *
 * Verifies every object under an E2EE-workspace prefix in the `attachments`
 * bucket is an `encb:v1:` ciphertext envelope — the tripwire for an honest-client
 * plaintext regression. ALL the logic — the scan and the report shape (exit code,
 * NOT-ARMED handling, per-path redaction) — lives in tested modules under
 * `src/attachments/audit/`; this is the thin I/O shell (env → run → print).
 *
 * Privilege/posture: uses a privileged key (reads every workspace's objects,
 * bypassing RLS) but range-reads only the envelope head (the ≤36-byte magic +
 * nonce + tag minimum), never a full body; the
 * workflow has no pull_request trigger so the secret is not exposed to forks.
 */
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { runCiphertextAudit } from '@/attachments/audit/audit'
import { buildReport, type AuditOutcome } from '@/attachments/audit/report'
import { createSupabaseAuditIO } from '@/attachments/audit/supabaseAuditIO'

const url = process.env.SUPABASE_URL
// The privileged key: a modern `sb_secret_…` secret key (preferred — independently
// revocable) or a legacy service_role JWT. Both bypass RLS; supabase-js takes either
// opaquely, so this entrypoint doesn't care which.
const secretKey = process.env.SUPABASE_SECRET_KEY

const redact = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12)
const note = (m: string) => console.log(`::notice::${m}`)
const warn = (m: string) => console.log(`::warning::${m}`)
const fail = (m: string) => console.log(`::error::${m}`)
const writeSummary = (md: string) => {
  const f = process.env.GITHUB_STEP_SUMMARY
  if (!f) return
  try {
    appendFileSync(f, `${md}\n`)
  } catch {
    /* cosmetic — never fail the audit on a summary write */
  }
}

async function main() {
  const outcome: AuditOutcome =
    !url || !secretKey
      ? { armed: false }
      : { armed: true, result: await runCiphertextAudit(createSupabaseAuditIO({ url, secretKey })) }

  const report = buildReport(outcome, redact)
  report.notices.forEach(note)
  report.warnings.forEach(warn)
  report.errors.forEach(fail)
  writeSummary(report.summary)
  if (report.exitCode !== 0) process.exit(report.exitCode)
}

main().catch((err) => {
  // The only reachable throws are PII-free by construction: the IO wraps
  // enumeration errors to code/name-only, readObjectVerdict never throws, and a
  // supabase-js createClient/url error doesn't echo the url. Kept raw for
  // debuggability — if a future throw site could carry a path, redact here.
  fail(`attachments ciphertext audit errored: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
