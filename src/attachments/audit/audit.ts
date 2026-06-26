import { mapSettled } from './scan.js'
import type { AuditIO, Finding } from './types.js'

export interface AuditResult {
  workspaces: number
  scanned: number
  findings: Finding[]
}

/**
 * Pure orchestrator (design §10.1 / §17): scan every E2EE workspace's objects,
 * collecting findings. Drives an injected {@link AuditIO} so it is fully
 * unit-testable with no network.
 *
 * Failure model:
 *  - Enumeration failures (`listE2eeWorkspaceIds` / `listObjects`) PROPAGATE — if
 *    we can't list, we can't audit, so aborting is the correct signal.
 *  - Per-OBJECT failures NEVER abort: `mapSettled` + the `readObjectVerdict`
 *    no-throw contract turn one bad object into an 'unreadable' finding.
 */
export async function runCiphertextAudit(io: AuditIO): Promise<AuditResult> {
  const workspaceIds = await io.listE2eeWorkspaceIds()
  const findings: Finding[] = []
  let scanned = 0

  for (const ws of workspaceIds) {
    const entries = await io.listObjects(ws)
    // A nested subfolder must never exist (RLS enforces the flat layout); flag
    // one rather than skip it, so the audit can't go blind on nesting.
    for (const e of entries) {
      if (e.isFolder) findings.push({ kind: 'nested', path: `${ws}/${e.name}/` })
    }

    const files = entries.filter((e) => !e.isFolder).map((e) => `${ws}/${e.name}`)
    const verdicts = await mapSettled(
      files,
      (path) => io.readObjectVerdict(path),
      () => 'unreadable' as const,
    )
    files.forEach((path, i) => {
      const verdict = verdicts[i]
      if (verdict === 'gone') return // vanished mid-scan — nothing to verify
      scanned += 1
      if (verdict === 'plaintext') findings.push({ kind: 'plaintext', path })
      else if (verdict === 'unreadable') findings.push({ kind: 'unreadable', path })
    })
  }

  return { workspaces: workspaceIds.length, scanned, findings }
}
