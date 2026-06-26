/**
 * Off-path ciphertext audit entrypoint (design §10.1 / §17).
 * Run: `yarn audit:attachments-ciphertext` (vite-node).
 *
 * Verifies every object under an E2EE-workspace prefix in the `attachments`
 * bucket is an `encb:v1:` ciphertext envelope — the tripwire for an honest-client
 * plaintext regression. The logic lives in tested modules under
 * `src/attachments/audit/`; this is the thin I/O + reporting shell.
 *
 * Privilege/posture: it uses a privileged key (reads every workspace's objects,
 * bypassing RLS) but only range-reads the 8-byte magic, never a full body; the
 * workflow has no pull_request trigger so the secret is not exposed to forks. If
 * the key is unset the audit is NOT ARMED — a yellow ::warning::, never a silent
 * green pass. Public-repo hygiene: only a redacted sha256 prefix of a path is
 * ever logged, never a raw workspace id / object name.
 */
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { runCiphertextAudit } from '@/attachments/audit/audit'
import { createSupabaseAuditIO } from '@/attachments/audit/supabaseAuditIO'
import type { FindingKind } from '@/attachments/audit/types'

const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

const redact = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12)
const note = (m: string) => console.log(`::notice::${m}`)
const warn = (m: string) => console.log(`::warning::${m}`)
const fail = (m: string) => console.log(`::error::${m}`)
const summary = (md: string) => {
  const f = process.env.GITHUB_STEP_SUMMARY
  if (!f) return
  try {
    appendFileSync(f, `${md}\n`)
  } catch {
    /* cosmetic — never fail the audit on a summary write */
  }
}

const REASONS: Record<FindingKind, string> = {
  nested: 'unexpected NESTED entry under an E2EE prefix (layout must be flat — could hide plaintext)',
  unreadable: 'UNREADABLE object under an E2EE prefix (empty/truncated/errored — not verifiable as ciphertext)',
  plaintext: 'non-ciphertext object in an E2EE workspace',
}

async function main() {
  if (!url || !serviceKey) {
    // A green ::notice:: would make a never-configured (never-running) tripwire
    // indistinguishable from a healthy pass — emit a yellow ::warning:: instead.
    // Still exit 0: the key is legitimately unset until media capture ships.
    warn('attachments ciphertext audit NOT ARMED — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY unset; the tripwire did not run')
    summary(
      '### ⚠️ Attachments ciphertext audit — NOT ARMED\nSecrets not configured; the audit did not run. Set the key before media capture (Phase 5) ships.',
    )
    return
  }

  const { workspaces, scanned, findings } = await runCiphertextAudit(createSupabaseAuditIO({ url, serviceKey }))
  const tally = `${workspaces} E2EE workspace(s), ${scanned} object(s) scanned, ${findings.length} finding(s)`
  note(`attachments ciphertext audit: ${tally}`)

  if (findings.length > 0) {
    for (const f of findings) fail(`${REASONS[f.kind]}: obj:${redact(f.path)}`)
    fail(`${findings.length} finding(s) under an E2EE prefix — a client is uploading plaintext, nesting, or writing unverifiable objects (§10.1/§17)`)
    summary(
      `### ❌ Attachments ciphertext audit — ${findings.length} finding(s)\n${tally}. Plaintext, non-flat, or unreadable object under an E2EE workspace (§10.1/§17).`,
    )
    process.exit(1)
  }
  summary(`### ✅ Attachments ciphertext audit — armed and clean\n${tally}.`)
}

main().catch((err) => {
  fail(`attachments ciphertext audit errored: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
