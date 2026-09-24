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
    transformCodexHookStdout,
    transformHookStdout,
    withNotice,
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

    // The sync alarm rides at the top of the same fitted context: it has to
    // survive the clipping, and must not push the index past the host limit.
    it('carries a notice at the top without breaking the fit', () => {
        const notice = '⚠ bd-github-sync is over its 20s budget'
        const out = buildAdditionalContext(makeContext(synthetic(135, 150)), notice)
        expect(out.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
        expect(out).toContain(notice)
        expect(out.indexOf(notice)).toBeLessThan(out.indexOf('## Memories'))
        expect(out).toContain('feedback_synthetic_memory_key_134')
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

// The alarm does not come from the index, so whatever the index path produced
// — nothing, a malformed envelope, one without context — still carries it.
describe('withNotice', () => {
    const notice = '⚠ bd-github-sync is over its 15s budget'
    const context = (raw: string | null) => JSON.parse(withNotice(raw, notice) ?? 'null').hookSpecificOutput

    it('builds a SessionStart envelope when the index path produced nothing usable', () => {
        for (const raw of [null, '', 'Error: not json', 'null', '[]'])
            expect(context(raw)).toEqual({ hookEventName: 'SessionStart', additionalContext: notice })
    })

    it('adds the notice to an envelope that has no context, keeping its other fields', () => {
        const out = JSON.parse(withNotice('{"continue":true,"hookSpecificOutput":{"hookEventName":"SessionStart"}}', notice) ?? '')
        expect(out).toEqual({ continue: true, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: notice } })
    })

    it('leaves output that already carries it, and output with no notice to add, untouched', () => {
        const carried = wrap(`# Beads\n\n${notice}\n\n## Memories`)
        expect(withNotice(carried, notice)).toBe(carried)
        expect(withNotice('{"continue":true}', '')).toBe('{"continue":true}')
        expect(withNotice(null, '')).toBeNull()
    })
})

describe('transformCodexHookStdout', () => {
    it('compacts additionalContext while preserving the native envelope', () => {
        const native = JSON.stringify({
            continue: true,
            systemMessage: 'lifecycle state updated',
            hookSpecificOutput: {
                hookEventName: 'PreCompact',
                additionalContext: 'native context',
                metadata: { source: 'bd' },
            },
        })
        const out = JSON.parse(transformCodexHookStdout(native, wrap(makeContext([['feedback_alpha', 'preview']]))))
        expect(out).toEqual({
            continue: true,
            systemMessage: 'lifecycle state updated',
            hookSpecificOutput: {
                hookEventName: 'PreCompact',
                additionalContext: expect.stringContaining('feedback_alpha'),
                metadata: { source: 'bd' },
            },
        })
    })

    it('passes the native output through without context and falls back when prime has none', () => {
        const native = '{"hookSpecificOutput":{"hookEventName":"PostCompact"}}\n'
        expect(transformCodexHookStdout(native, wrap(makeContext([['feedback_alpha', 'preview']])))).toBe(native)
        const withContext = wrap(makeContext([['feedback_alpha', 'preview']]))
        const fallback = JSON.parse(transformCodexHookStdout(withContext, ''))
        expect(fallback.hookSpecificOutput.hookEventName).toBe('SessionStart')
        expect(fallback.hookSpecificOutput.additionalContext).toContain('feedback_alpha')
    })
})

// Process-level pins: the DB-existence gate (a bd invocation in a fresh clone
// would CREATE an empty DB) and the never-break-session-start contract.
// Measured ~150ms per spawn solo; budgeted for the 6x load stretch.
describe('bd-prime-hook process behavior', { timeout: 20_000 }, () => {
    const script = fileURLToPath(new URL('./bd-prime-hook.mjs', import.meta.url))

    const makeRepo = (opts: {
        dbReady: boolean
        /** Lines of the sync's run log (`.beads/github-sync-runs.log`). */
        syncRuns?: object[]
        primeStdout?: string
        primeStderr?: string
        codexStdout?: string
    }) => {
        const repo = mkdtempSync(join(tmpdir(), 'bd-prime-hook-'))
        spawnSync('git', ['init', '-q'], { cwd: repo })
        mkdirSync(join(repo, '.beads'))
        if (opts.dbReady) mkdirSync(join(repo, '.beads', 'embeddeddolt'))
        if (opts.syncRuns)
            writeFileSync(join(repo, '.beads', 'github-sync-runs.log'), opts.syncRuns.map(r => JSON.stringify(r)).join('\n') + '\n')
        const shimDir = join(repo, 'shim')
        mkdirSync(shimDir)
        const shimLog = join(repo, 'bd-shim.log')
        writeFileSync(shimLog, '')
        const fixture = join(repo, 'prime-fixture.txt')
        writeFileSync(fixture, opts.primeStdout ?? '')
        const stderrFixture = join(repo, 'prime-stderr.txt')
        writeFileSync(stderrFixture, opts.primeStderr ?? '')
        const codexFixture = join(repo, 'codex-fixture.txt')
        writeFileSync(codexFixture, opts.codexStdout ?? '')
        const codexInput = join(repo, 'codex-input.txt')
        // --version must answer with real text: initializedDbRoot treats empty
        // stdout as "bd missing", which would turn dbReady repos DB-less and
        // make the assertions vacuous.
        writeFileSync(
            join(shimDir, 'bd'),
            `#!/bin/sh\necho "bd $@" >> "${shimLog}"\ncase "$1" in\n  --version) echo "bd-shim 0.0.0";;\n  codex-hook) cat > "${codexInput}"; cat "${codexFixture}";;\n  prime) cat "${fixture}"; cat "${stderrFixture}" >&2;;\nesac\nexit 0\n`,
        )
        chmodSync(join(shimDir, 'bd'), 0o755)
        const env = { ...process.env, PATH: `${shimDir}:${process.env.PATH}` }
        const run = (args: string[] = [], input = '') =>
            spawnSync('node', [script, ...args], { cwd: repo, env, input, encoding: 'utf8' })
        return {
            run,
            shimCalls: () => readFileSync(shimLog, 'utf8'),
            codexInput: () => readFileSync(codexInput, 'utf8'),
        }
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

    it('opens the context with the sync alarm when the last two syncs were over budget', () => {
        const slowRun = { at: '2026-09-24T20:00:00.000Z', ms: 37_200, ok: true, slow: true, budgetMs: 20_000, spawns: [{ cmd: 'bd show', calls: 2, ms: 20_300 }] }
        const { run } = makeRepo({
            dbReady: true,
            syncRuns: [slowRun, slowRun],
            primeStdout: wrap(makeContext([['feedback_alpha', 'preview']])),
        })
        const r = run()
        expect(r.status).toBe(0)
        const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext
        expect(context).toContain('bd-github-sync is over its 20s budget')
        expect(context).toContain('bd show ×2 20.3s')
        expect(context).toContain('feedback_alpha')

        const codex = makeRepo({
            dbReady: true,
            syncRuns: [slowRun, slowRun],
            codexStdout: wrap('native full context'),
            primeStdout: wrap(makeContext([['feedback_alpha', 'preview']])),
        })
        const viaCodex = codex.run(['--codex', 'SessionStart'], '{}')
        expect(viaCodex.status).toBe(0)
        expect(JSON.parse(viaCodex.stdout).hookSpecificOutput.additionalContext).toContain('bd-github-sync is over its 20s budget')

        // A mid-session refresh re-injects the index, not the alarm: it would
        // otherwise repeat on every turn the refresh fires.
        const refresh = codex.run(['--codex', 'UserPromptSubmit'], '{}')
        expect(refresh.status).toBe(0)
        const refreshed = JSON.parse(refresh.stdout).hookSpecificOutput.additionalContext
        expect(refreshed).toContain('feedback_alpha')
        expect(refreshed).not.toContain('bd-github-sync is over')
    })

    // The alarm does not depend on the memory index, so a failing prime must
    // not take it down with it.
    it('still raises the sync alarm when bd prime fails', () => {
        const slowRun = { at: '2026-09-24T20:00:00.000Z', ms: 37_200, ok: true, budgetMs: 20_000, spawns: [] }
        const { run } = makeRepo({
            dbReady: true,
            syncRuns: [slowRun, slowRun],
            primeStdout: 'Error: workspace database locked\n',
        })
        const r = run()
        expect(r.status).toBe(0)
        const parsed = JSON.parse(r.stdout)
        expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart')
        expect(parsed.hookSpecificOutput.additionalContext).toContain('bd-github-sync is over its 20s budget')
    })

    it('still raises the sync alarm when the Codex session-start hook returns nothing', () => {
        const slowRun = { at: '2026-09-24T20:00:00.000Z', ms: 37_200, ok: true, budgetMs: 20_000, spawns: [] }
        const { run } = makeRepo({ dbReady: true, syncRuns: [slowRun, slowRun], codexStdout: '' })
        const r = run(['--codex', 'SessionStart'], '{}')
        expect(r.status).toBe(0)
        expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('bd-github-sync is over its 20s budget')
    })

    it('forwards the Codex event and stdin, then compacts native context in place', () => {
        const native = JSON.stringify({
            continue: true,
            systemMessage: 'state updated',
            hookSpecificOutput: {
                hookEventName: 'PreCompact',
                additionalContext: 'native full context',
                metadata: { event: 'PreCompact' },
            },
        })
        const { run, shimCalls, codexInput } = makeRepo({
            dbReady: true,
            codexStdout: native,
            primeStdout: wrap(makeContext([['feedback_alpha', 'preview']])),
        })
        const r = run(['--codex', 'PreCompact'], '{"prompt":"keep this payload"}')
        expect(r.status).toBe(0)
        const parsed = JSON.parse(r.stdout)
        expect(parsed).toMatchObject({
            continue: true,
            systemMessage: 'state updated',
            hookSpecificOutput: {
                hookEventName: 'PreCompact',
                metadata: { event: 'PreCompact' },
            },
        })
        expect(parsed.hookSpecificOutput.additionalContext).toContain('feedback_alpha')
        expect(codexInput()).toBe('{"prompt":"keep this payload"}')
        expect(shimCalls()).toContain('bd codex-hook PreCompact')
        expect(shimCalls()).toContain('bd prime --hook-json --mcp')
    })

    it('passes a native lifecycle result without context unchanged and does not prime again', () => {
        const native = '{"hookSpecificOutput":{"hookEventName":"PostCompact"},"continue":true}\n'
        const { run, shimCalls } = makeRepo({ dbReady: true, codexStdout: native })
        const r = run(['--codex', 'PostCompact'], '{}')
        expect(r.status).toBe(0)
        expect(r.stdout).toBe(native)
        expect(shimCalls()).toContain('bd codex-hook PostCompact')
        expect(shimCalls()).not.toContain('bd prime --hook-json --mcp')
    })

    it('bounds native context when the compacting prime fails', () => {
        const native = JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'SessionStart',
                additionalContext: `## Persistent Memories (188)\n\n${'x'.repeat(590_000)}`,
            },
            continue: true,
        })
        const { run } = makeRepo({
            dbReady: true,
            codexStdout: native,
            primeStderr: 'Error: memory table read failed\n',
        })
        const r = run(['--codex', 'SessionStart'], '{}')
        expect(r.status).toBe(0)
        const parsed = JSON.parse(r.stdout)
        expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart')
        expect(parsed.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
    })

    it('does not invoke any bd command for Codex in a DB-less clone', () => {
        const { run, shimCalls } = makeRepo({ dbReady: false, codexStdout: 'should not run' })
        const r = run(['--codex', 'SessionStart'], '{}')
        expect(r.status).toBe(0)
        expect(r.stdout).toBe('')
        expect(shimCalls()).toBe('')
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
