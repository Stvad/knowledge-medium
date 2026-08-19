import { describe, expect, it } from 'vitest'
import { runCiphertextAudit } from './audit.js'
import type { AuditIO, ObjectEntry, ObjectVerdict } from './types.js'

const file = (name: string): ObjectEntry => ({ name, isFolder: false })
const folder = (name: string): ObjectEntry => ({ name, isFolder: true })

/** Build a fake AuditIO from plain data — no network. */
const fakeIO = (config: {
  workspaces: string[]
  objects: Record<string, ObjectEntry[]>
  verdicts?: Record<string, ObjectVerdict> // by full path; default 'ok'
  readThrows?: Set<string> // paths whose readObjectVerdict throws
}): AuditIO => ({
  listE2eeWorkspaceIds: async () => config.workspaces,
  listObjects: async (ws) => config.objects[ws] ?? [],
  readObjectVerdict: async (path) => {
    if (config.readThrows?.has(path)) throw new Error('torn stream')
    return config.verdicts?.[path] ?? 'ok'
  },
})

describe('runCiphertextAudit', () => {
  it('reports a clean scan when every object is ciphertext', async () => {
    const r = await runCiphertextAudit(
      fakeIO({ workspaces: ['ws1'], objects: { ws1: [file('a'), file('b')] } }),
    )
    expect(r).toEqual({ workspaces: 1, scanned: 2, findings: [] })
  })

  it('flags a plaintext object', async () => {
    const r = await runCiphertextAudit(
      fakeIO({ workspaces: ['ws1'], objects: { ws1: [file('a')] }, verdicts: { 'ws1/a': 'plaintext' } }),
    )
    expect(r.findings).toEqual([{ kind: 'plaintext', path: 'ws1/a' }])
    expect(r.scanned).toBe(1)
  })

  it('flags a nested subfolder and still scans the flat files', async () => {
    const r = await runCiphertextAudit(
      fakeIO({ workspaces: ['ws1'], objects: { ws1: [folder('sub'), file('a')] } }),
    )
    expect(r.findings).toEqual([{ kind: 'nested', path: 'ws1/sub/' }])
    expect(r.scanned).toBe(1) // the folder isn't "scanned"; the file is
  })

  it("flags an 'unreadable' object (read threw) WITHOUT aborting the rest of the scan", async () => {
    const r = await runCiphertextAudit(
      fakeIO({
        workspaces: ['ws1'],
        objects: { ws1: [file('a'), file('b'), file('c')] },
        readThrows: new Set(['ws1/b']),
      }),
    )
    expect(r.findings).toEqual([{ kind: 'unreadable', path: 'ws1/b' }])
    expect(r.scanned).toBe(3) // a, b, c all examined; a/c clean, b flagged
  })

  it("skips a 'gone' object (deleted mid-scan): not scanned, not a finding", async () => {
    const r = await runCiphertextAudit(
      fakeIO({
        workspaces: ['ws1'],
        objects: { ws1: [file('a'), file('b')] },
        verdicts: { 'ws1/a': 'gone' },
      }),
    )
    expect(r.findings).toEqual([])
    expect(r.scanned).toBe(1) // only b
  })

  it('scans multiple workspaces and aggregates findings', async () => {
    const r = await runCiphertextAudit(
      fakeIO({
        workspaces: ['ws1', 'ws2'],
        objects: { ws1: [file('a')], ws2: [file('x'), folder('nest')] },
        verdicts: { 'ws2/x': 'plaintext' },
      }),
    )
    expect(r.workspaces).toBe(2)
    expect(r.scanned).toBe(2) // ws1/a + ws2/x (the folder isn't scanned)
    expect(r.findings).toHaveLength(2)
    expect(r.findings).toContainEqual({ kind: 'plaintext', path: 'ws2/x' })
    expect(r.findings).toContainEqual({ kind: 'nested', path: 'ws2/nest/' })
  })

  it('propagates an enumeration failure (cannot list → cannot audit → abort)', async () => {
    const io: AuditIO = {
      listE2eeWorkspaceIds: async () => {
        throw new Error('workspaces query failed (42501)')
      },
      listObjects: async () => [],
      readObjectVerdict: async () => 'ok',
    }
    await expect(runCiphertextAudit(io)).rejects.toThrow(/workspaces query failed/)
  })
})
