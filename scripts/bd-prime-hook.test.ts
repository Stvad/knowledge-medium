import { describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
    MAX_CONTEXT_CHARS,
    buildAdditionalContext,
    parsePrimeContext,
    transformHookStdout,
} from './bd-prime-hook.mjs'

const bullet = (key: string, preview: string) => `- **${key}**: ${preview}`

const makeContext = (memories: Array<[string, string]>, opts: { closeProtocol?: boolean } = {}) =>
    [
        '[bd prime] If this output is truncated by your host, read the full persisted hook output before continuing; it may contain project memories and session rules not visible in the preview.',
        '',
        '# Beads Issue Tracker Active',
        '',
        '',
        '## Memories',
        ...memories.map(([k, p]) => bullet(k, p)),
        '',
        ...(opts.closeProtocol === false
            ? []
            : [
                  '# 🚨 SESSION CLOSE PROTOCOL 🚨',
                  '',
                  '## Core Rules',
                  '- **NEVER stop with open work** — file beads first',
                  bullet('decoy_not_a_memory', 'a bullet inside the close protocol section'),
              ]),
    ].join('\n')

const synthetic = (count: number, previewLen: number): Array<[string, string]> =>
    Array.from({ length: count }, (_, i) => [
        `feedback_synthetic_memory_key_${String(i).padStart(3, '0')}`,
        `preview ${i} ${'x'.repeat(previewLen)}`.slice(0, previewLen),
    ])

const wrap = (ctx: string) =>
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } })

describe('parsePrimeContext', () => {
    it('extracts keys and previews in order from the mcp format', () => {
        const { memories, parseOk } = parsePrimeContext(
            makeContext([
                ['feedback_alpha', 'first preview'],
                ['reference_beta', 'second preview'],
            ]),
        )
        expect(parseOk).toBe(true)
        expect(memories).toEqual([
            { key: 'feedback_alpha', preview: 'first preview' },
            { key: 'reference_beta', preview: 'second preview' },
        ])
    })

    it('stops at the close-protocol heading — its bullets are not memories', () => {
        const { memories } = parsePrimeContext(makeContext([['feedback_alpha', 'p']]))
        expect(memories.map(m => m.key)).toEqual(['feedback_alpha'])
    })

    it('folds continuation lines into the previous preview', () => {
        const ctx = makeContext([['feedback_alpha', 'starts here']]).replace(
            'starts here',
            'starts here\n  and wraps onto a second line',
        )
        const { memories } = parsePrimeContext(ctx)
        expect(memories[0].preview).toBe('starts here and wraps onto a second line')
    })

    it('reports parseOk=false when there is no memories section', () => {
        expect(parsePrimeContext('# Something Else\n\ntext').parseOk).toBe(false)
        expect(parsePrimeContext('').parseOk).toBe(false)
    })
})

describe('buildAdditionalContext', () => {
    it('fits a realistic index (135 × 150-char previews) under the host inline limit, keeping every key', () => {
        const memories = synthetic(135, 150)
        const out = buildAdditionalContext(makeContext(memories))
        expect(out.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
        for (const [key] of memories) expect(out).toContain(key)
        expect(out).not.toContain('SESSION CLOSE PROTOCOL')
        expect(out).not.toContain('decoy_not_a_memory')
    })

    it('keeps full previews when the index is small', () => {
        const out = buildAdditionalContext(makeContext(synthetic(5, 120)))
        expect(out).not.toContain('…')
        expect(out).toContain('preview 4')
    })

    it('names the recall commands so a clipped index stays actionable', () => {
        const out = buildAdditionalContext(makeContext(synthetic(135, 150)))
        expect(out).toContain('bd recall')
        expect(out).toContain('bd memories')
    })

    it('degrades previews before dropping keys', () => {
        const out = buildAdditionalContext(makeContext(synthetic(135, 150)))
        expect(out).toContain('…')
        expect(out).not.toContain('more — run')
    })

    it('drops tail keys only as a last resort, and says how many', () => {
        const memories = synthetic(900, 200)
        const out = buildAdditionalContext(makeContext(memories))
        expect(out.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
        const dropped = /and (\d+) more/.exec(out)
        expect(dropped).not.toBeNull()
        const retained = memories.filter(([key]) => out.includes(key)).length
        expect(retained + Number(dropped![1])).toBe(900)
        // the retained prefix is contiguous from the top of bd's ordering
        expect(out).toContain(memories[0][0])
        expect(out).not.toContain(memories[899][0])
    })

    it('never cuts a preview mid-surrogate-pair', () => {
        const memories: Array<[string, string]> = Array.from({ length: 300 }, (_, i) => [
            `feedback_emoji_${String(i).padStart(3, '0')}`,
            '🚨'.repeat(120),
        ])
        const out = buildAdditionalContext(makeContext(memories))
        // a lone surrogate does not survive a UTF-8 round-trip (it becomes U+FFFD)
        expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out)
        expect(out.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
    })

    it('falls back to a clipped raw passthrough when the format is unrecognized', () => {
        const raw = `totally different bd output\n${'y'.repeat(30_000)}`
        const out = buildAdditionalContext(raw)
        expect(out.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
        expect(out).toContain('[bd-prime-hook]')
        expect(out).toContain('totally different bd output')
    })
})

describe('transformHookStdout', () => {
    it('re-emits a valid SessionStart envelope with the transformed context', () => {
        const out = transformHookStdout(wrap(makeContext(synthetic(135, 150))))
        expect(out).not.toBeNull()
        const parsed = JSON.parse(out!)
        expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart')
        expect(parsed.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
    })

    it('returns null for empty, non-JSON, or bd-style Error output', () => {
        expect(transformHookStdout('')).toBeNull()
        expect(transformHookStdout(null)).toBeNull()
        expect(transformHookStdout('Error: dolt exploded')).toBeNull()
        expect(transformHookStdout('not json at all')).toBeNull()
        expect(transformHookStdout(wrap(''))).toBeNull()
    })
})

// Process-level pins: the DB-existence gate (a bd invocation in a fresh clone
// would CREATE an empty DB) and the never-break-session-start contract.
// Measured ~150ms per spawn solo; budgeted for the 6x load stretch.
describe('bd-prime-hook process behavior', { timeout: 20_000 }, () => {
    const script = fileURLToPath(new URL('./bd-prime-hook.mjs', import.meta.url))

    const makeRepo = (opts: { dbReady: boolean; primeStdout?: string; primeStderr?: string }) => {
        const repo = mkdtempSync(join(tmpdir(), 'bd-prime-hook-'))
        spawnSync('git', ['init', '-q'], { cwd: repo })
        mkdirSync(join(repo, '.beads'))
        if (opts.dbReady) mkdirSync(join(repo, '.beads', 'embeddeddolt'))
        const shimDir = join(repo, 'shim')
        mkdirSync(shimDir)
        const shimLog = join(repo, 'bd-shim.log')
        writeFileSync(shimLog, '')
        const fixture = join(repo, 'prime-fixture.txt')
        writeFileSync(fixture, opts.primeStdout ?? '')
        const stderrFixture = join(repo, 'prime-stderr.txt')
        writeFileSync(stderrFixture, opts.primeStderr ?? '')
        // --version must answer with real text: initializedDbRoot treats empty
        // stdout as "bd missing", which would turn dbReady repos DB-less and
        // make the assertions vacuous.
        writeFileSync(
            join(shimDir, 'bd'),
            `#!/bin/sh\necho "bd $@" >> "${shimLog}"\ncase "$1" in\n  --version) echo "bd-shim 0.0.0";;\n  prime) cat "${fixture}"; cat "${stderrFixture}" >&2;;\nesac\nexit 0\n`,
        )
        chmodSync(join(shimDir, 'bd'), 0o755)
        const env = { ...process.env, PATH: `${shimDir}:${process.env.PATH}` }
        const run = () => spawnSync('node', [script], { cwd: repo, env, encoding: 'utf8' })
        return { run, shimCalls: () => readFileSync(shimLog, 'utf8') }
    }

    it('exits 0 with no output in a DB-less clone, WITHOUT ever spawning bd', () => {
        const { run, shimCalls } = makeRepo({ dbReady: false })
        const r = run()
        expect(r.status).toBe(0)
        expect(r.stdout).toBe('')
        expect(shimCalls()).toBe('')
    })

    it('emits a fitting envelope in a DB-ready repo (shim interception works)', () => {
        const { run, shimCalls } = makeRepo({
            dbReady: true,
            primeStdout: wrap(makeContext(synthetic(135, 150))),
        })
        const r = run()
        expect(r.status).toBe(0)
        const parsed = JSON.parse(r.stdout)
        expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart')
        expect(parsed.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
        expect(parsed.hookSpecificOutput.additionalContext).toContain('feedback_synthetic_memory_key_000')
        expect(parsed.hookSpecificOutput.additionalContext).not.toContain('SESSION CLOSE PROTOCOL')
        expect(shimCalls()).toContain('bd --version')
        expect(shimCalls()).toContain('bd prime --hook-json --mcp')
    })

    it('exits 0 quietly when bd prime reports an error (bd prints Error and exits 0)', () => {
        const { run } = makeRepo({ dbReady: true, primeStdout: 'Error: workspace database locked\n' })
        const r = run()
        expect(r.status).toBe(0)
        expect(r.stdout).toBe('')
    })

    // bd can emit a plausible envelope on stdout while reporting the real
    // failure as `Error…` on stderr, still exit 0 — treat that as failure.
    it('rejects an Error on stderr even when stdout carries valid JSON', () => {
        const { run } = makeRepo({
            dbReady: true,
            primeStdout: wrap(makeContext(synthetic(3, 50))),
            primeStderr: 'Error: memory table read failed\n',
        })
        const r = run()
        expect(r.status).toBe(0)
        expect(r.stdout).toBe('')
    })
})
