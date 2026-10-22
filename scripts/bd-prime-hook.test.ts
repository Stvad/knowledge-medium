import { describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
    MAX_CONTEXT_CHARS,
    buildAdditionalContext,
    parseMemoryKeys,
    readMemoryIndex,
    sessionStartOutput,
    transformCodexHookStdout,
} from './bd-prime-hook.mjs'
import { SYNC_RUN_LOG } from './bd-github-sync.mjs'

/** `bd memories --json` stdout: every key maps to its content, plus bd's numeric `schema_version`. */
const memoriesJson = (keys: string[]) =>
    JSON.stringify({ ...Object.fromEntries(keys.map(k => [k, `${k} body\n\nmore text`])), schema_version: 1 })

// Names average 30 chars, as the real index's do, so the fit is tested at a realistic density.
const syntheticKeys = (counts: Record<string, number>) =>
    Object.entries(counts).flatMap(([prefix, count]) =>
        Array.from({ length: count }, (_, i) => {
            const id = String(i).padStart(4, '0')
            return `${prefix}_${'word_'.repeat(2 + (i % 8))}${id}`
        }),
    )

// The real index's prefix mix, scaled past 250.
const REALISTIC = { feedback: 76, project: 50, reference: 106, testing: 28, user: 2 }

/** Reads the rendered groups back into full keys, plus each group's "+N more" count. */
const readBack = (out: string) => {
    const keys: string[] = []
    const hidden: Record<string, number> = {}
    for (const line of out.split('\n')) {
        const m = /^(unprefixed \(full keys\)|[\w.-]+): (.*)$/.exec(line)
        if (!m) continue
        const [, label, rest] = m
        for (const item of rest.split(', ')) {
            const more = /^…\(\+(\d+) more\)$/.exec(item)
            if (more) hidden[label] = Number(more[1])
            else keys.push(label.startsWith('unprefixed') ? item : `${label}_${item}`)
        }
    }
    return { keys, hidden }
}

const wrap = (ctx: string) =>
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } })

describe('parseMemoryKeys', () => {
    it('reads the keys, leaving out the schema_version bd mixes into the same object', () => {
        expect(parseMemoryKeys(memoriesJson(['reference_beta', 'feedback_alpha']))).toEqual({
            keys: ['reference_beta', 'feedback_alpha'],
        })
    })

    it('reads an empty index as no keys, not as a failure', () => {
        expect(parseMemoryKeys('{"schema_version":1}')).toEqual({ keys: [] })
    })

    // BD_JSON_ENVELOPE=1 today, bd's default from v2.
    it('reads the same map from under `data` in bd\'s envelope format', () => {
        const envelope = JSON.stringify({ schema_version: 1, data: { feedback_alpha: 'text', data_beta: 'text' } })
        expect(parseMemoryKeys(envelope)).toEqual({ keys: ['feedback_alpha', 'data_beta'] })
        // a lone memory keyed `data` is still a memory
        expect(parseMemoryKeys('{"data":"text","schema_version":1}')).toEqual({ keys: ['data'] })
    })

    // A moved format must say so: dropping what it cannot read would show an empty index.
    it('refuses a format it does not recognise rather than reading fewer keys', () => {
        expect(parseMemoryKeys('{"feedback_alpha":"x","schema_version":2}')).toEqual({
            error: 'unrecognized bd memories schema_version 2',
        })
        expect(parseMemoryKeys('{"feedback_alpha":"x"}')).toEqual({ error: 'unrecognized bd memories schema_version undefined' })
        for (const shape of [
            { schema_version: 1, feedback_alpha: { content: 'x' }, project_beta: { content: 'y' } },
            { schema_version: 1, feedback_alpha: null },
            { schema_version: 1, data: { feedback_alpha: 'x' }, pagination: { truncated: true } },
            { schema_version: 1, memories: { feedback_alpha: 'x' } },
        ])
            expect(parseMemoryKeys(JSON.stringify(shape))).toMatchObject({ error: expect.stringContaining('unrecognized bd memories format') })
    })

    it('names the failure when the output is not a JSON object', () => {
        expect(parseMemoryKeys('Error: workspace database locked\nretry later')).toEqual({
            error: 'Error: workspace database locked',
        })
        expect(parseMemoryKeys('{\n  "feedback_alpha": "trunc')).toEqual({ error: 'output is not JSON' })
        expect(parseMemoryKeys('')).toEqual({ error: 'empty output' })
        expect(parseMemoryKeys('["feedback_alpha"]')).toEqual({ error: 'output is not a JSON object' })
        expect(parseMemoryKeys('null')).toEqual({ error: 'output is not a JSON object' })
    })
})

describe('readMemoryIndex', () => {
    const ok = { status: 0, signal: null, stdout: memoriesJson(['feedback_alpha']), stderr: '' }

    it('reads a clean run', () => {
        expect(readMemoryIndex(ok)).toEqual({ keys: ['feedback_alpha'] })
    })

    // ENOBUFS truncates stdout at the buffer cap: a whole index lost to a cap.
    it('reports a spawn error rather than parsing what came back', () => {
        const error = Object.assign(new Error('spawnSync bd ENOBUFS'), { code: 'ENOBUFS' })
        expect(readMemoryIndex({ ...ok, error, status: null, signal: 'SIGPIPE' })).toEqual({ error: 'ENOBUFS' })
    })

    it('reports a non-zero exit, by signal when there is no status', () => {
        expect(readMemoryIndex({ ...ok, status: 2 })).toEqual({ error: 'bd memories exited 2' })
        expect(readMemoryIndex({ ...ok, status: null, signal: 'SIGKILL' })).toEqual({ error: 'bd memories exited SIGKILL' })
    })

    // bd can print a plausible stdout while reporting the real failure as
    // `Error…` on stderr, and still exit 0.
    it('reports an Error on stderr even when stdout parses', () => {
        expect(readMemoryIndex({ ...ok, stderr: 'warning: slow\nError: memory table read failed\n' })).toEqual({
            error: 'Error: memory table read failed',
        })
    })

    it('names the error bd reports on stdout in --json mode', () => {
        const stdout = '{\n  "error": "listing memories: table locked",\n  "schema_version": 1\n}\n'
        expect(readMemoryIndex({ ...ok, status: 1, stdout })).toEqual({ error: 'listing memories: table locked' })
    })

    it("names bd's own Error line over a bare exit code", () => {
        const stderr = "Error: no beads database found\nHint: run 'bd where' to inspect the resolved workspace\n"
        expect(readMemoryIndex({ ...ok, status: 1, stdout: '', stderr })).toEqual({ error: 'Error: no beads database found' })
    })
})

describe('buildAdditionalContext', () => {
    it('lists every one of 262 realistic keys under the host inline limit', () => {
        const keys = syntheticKeys(REALISTIC)
        expect(keys.length).toBeGreaterThan(250)
        const out = buildAdditionalContext({ keys })
        expect(out.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
        const back = readBack(out)
        expect(back.keys.sort()).toEqual([...keys].sort())
        expect(back.hidden).toEqual({})
        expect(out).not.toContain('not shown')
    })

    it('groups by the first underscore, and lists keys it cannot split whole', () => {
        const keys = ['feedback_alpha', 'feedback__lead', 'reference_beta_gamma', 'loose', '_lead', 'trail_']
        const out = buildAdditionalContext({ keys })
        expect(out).toContain('feedback: _lead, alpha')
        expect(out).toContain('reference: beta_gamma')
        expect(out).toContain('unprefixed (full keys): _lead, loose, trail_')
        expect(readBack(out).keys.sort()).toEqual([...keys].sort())
    })

    it('carries a notice at the top without breaking the fit', () => {
        const notice = '⚠ bd-github-sync is over its 20s budget'
        const keys = syntheticKeys(REALISTIC)
        const out = buildAdditionalContext({ keys }, notice)
        expect(out.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
        expect(out.indexOf(notice)).toBeGreaterThan(-1)
        expect(out.indexOf(notice)).toBeLessThan(out.indexOf('## Memories'))
        expect(readBack(out).keys).toHaveLength(keys.length)
    })

    it('names the recall and search commands', () => {
        const out = buildAdditionalContext({ keys: ['feedback_alpha'] })
        expect(out).toContain('bd recall <key>')
        expect(out).toContain('bd memories <keyword>')
    })

    // Cutting the alphabetical tail would drop a late-sorting group whole;
    // trimming the largest groups first keeps a small one complete.
    it('when keys cannot fit, trims the largest groups and counts every key it left out', () => {
        const counts = { feedback: 300, project: 200, reference: 400, testing: 20, user: 2 }
        const keys = syntheticKeys(counts)
        const out = buildAdditionalContext({ keys })
        expect(out.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
        const back = readBack(out)
        const left = Object.values(back.hidden).reduce((a, b) => a + b, 0)
        expect(left).toBeGreaterThan(0)
        expect(back.keys.length + left).toBe(keys.length)
        expect(out).toContain(`${left} of ${keys.length} keys not shown`)
        expect(out).toContain('`bd memories` lists every key')
        expect(Object.keys(back.hidden).sort()).toEqual(['feedback', 'project', 'reference'])
        for (const prefix of ['testing', 'user'])
            expect(back.keys.filter(k => k.startsWith(`${prefix}_`))).toHaveLength(counts[prefix as keyof typeof counts])
        // every listed key is real, and each trimmed group shows its head
        for (const key of back.keys) expect(keys).toContain(key)
        expect(back.keys).toContain(keys[0])
    })

    // A one-key group's "+1 more" marker can be longer than its key, so an
    // index that fits whole is tried before concluding no group line fits.
    it('shows many small groups whole when they fit, even where their markers would not', () => {
        const keys = Array.from({ length: 700 }, (_, i) => `g${i}_k`)
        const out = buildAdditionalContext({ keys })
        expect(out.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
        expect(readBack(out).keys.sort()).toEqual([...keys].sort())
    })

    it('when not even one line per group fits, still says how many keys it left out', () => {
        const keys = Array.from({ length: 2000 }, (_, i) => `prefix${i}_name`)
        const out = buildAdditionalContext({ keys })
        expect(out.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
        expect(out).toContain('2000 of 2000 keys not shown')
        expect(out).toContain('`bd memories` lists every key')
    })

    it('shows what fits beside many one-key groups whose markers alone would not', () => {
        const keys = [...Array.from({ length: 700 }, (_, i) => `q${i}_ab`), ...Array.from({ length: 1200 }, (_, i) => `zz_${i}`)]
        const out = buildAdditionalContext({ keys })
        expect(out.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
        const back = readBack(out)
        expect(back.keys.length).toBeGreaterThan(1000)
        expect(back.keys.length + back.hidden['zz']).toBe(keys.length)
        expect(out).toContain(`${back.hidden['zz']} of ${keys.length} keys not shown`)
    })

    it('counts the notice inside the fit when keys overflow', () => {
        const notice = `⚠ bd-github-sync is over its 20s budget: ${'detail '.repeat(150)}`
        const keys = syntheticKeys({ feedback: 300, project: 200, reference: 400, testing: 20, user: 2 })
        const out = buildAdditionalContext({ keys }, notice)
        expect(out.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
        expect(out).toContain(notice)
        const back = readBack(out)
        expect(back.keys.length + Object.values(back.hidden).reduce((a, b) => a + b, 0)).toBe(keys.length)
    })

    // However long the alarm or the reason, the index line still states what it is missing.
    it('keeps the index line inside the budget under an oversized notice or reason', () => {
        const notice = `⚠ ${'x'.repeat(20_000)}`
        const many = buildAdditionalContext({ keys: Array.from({ length: 2000 }, (_, i) => `p${i}_name`) }, notice)
        expect(many.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
        expect(many).toContain('2000 of 2000 keys not shown')
        const failed = buildAdditionalContext({ error: `Error: ${'y'.repeat(20_000)}` }, notice)
        expect(failed.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
        expect(failed).toContain('`bd memories` lists every key')
    })

    it('never cuts a clipped reason mid-surrogate-pair', () => {
        for (const pad of ['', 'x']) {
            const out = buildAdditionalContext({ error: pad + '🚨'.repeat(6000) })
            // a lone surrogate does not survive a UTF-8 round-trip (it becomes U+FFFD)
            expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out)
        }
    })

    it('says the index is unavailable, and why, when it could not be read', () => {
        const notice = '⚠ bd-github-sync failed its last two runs'
        const out = buildAdditionalContext({ error: 'ENOBUFS' }, notice)
        expect(out).toContain('index unavailable (ENOBUFS)')
        expect(out).toContain('`bd memories` lists every key')
        expect(out).toContain(notice)
        expect(out.indexOf(notice)).toBeLessThan(out.indexOf('index unavailable'))
        expect(buildAdditionalContext({ error: 'x'.repeat(20_000) }).length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
    })
})

describe('sessionStartOutput', () => {
    const hookOutput = (raw: string | null) => JSON.parse(sessionStartOutput(raw, 'the index')).hookSpecificOutput

    it('builds a SessionStart envelope when bd produced nothing usable', () => {
        for (const raw of [null, '', 'not json', 'null', '[]', '{"hookSpecificOutput":"text"}', '{"hookSpecificOutput":["x"]}'])
            expect(hookOutput(raw)).toEqual({ hookEventName: 'SessionStart', additionalContext: 'the index' })
    })

    it("replaces bd's context and keeps the envelope's other fields", () => {
        const native = JSON.stringify({
            continue: true,
            hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '## Memories (showing 1 of 2)', metadata: { source: 'bd' } },
        })
        expect(JSON.parse(sessionStartOutput(native, 'the index'))).toEqual({
            continue: true,
            hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'the index', metadata: { source: 'bd' } },
        })
    })

    it('names the session-start event whatever the envelope said', () => {
        const foreign = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreCompact', additionalContext: 'x' } })
        expect(hookOutput(foreign).hookEventName).toBe('SessionStart')
    })
})

describe('transformCodexHookStdout', () => {
    it('replaces additionalContext while preserving the native envelope', () => {
        const native = JSON.stringify({
            continue: true,
            systemMessage: 'lifecycle state updated',
            hookSpecificOutput: {
                hookEventName: 'PreCompact',
                additionalContext: 'native context',
                metadata: { source: 'bd' },
            },
        })
        expect(JSON.parse(transformCodexHookStdout(native, () => 'the index'))).toEqual({
            continue: true,
            systemMessage: 'lifecycle state updated',
            hookSpecificOutput: { hookEventName: 'PreCompact', additionalContext: 'the index', metadata: { source: 'bd' } },
        })
    })

    it('passes native output without context through unchanged, without reading the index', () => {
        const readContext = () => {
            throw new Error('read the index')
        }
        const native = '{"hookSpecificOutput":{"hookEventName":"PostCompact"}}\n'
        expect(transformCodexHookStdout(native, readContext)).toBe(native)
        expect(transformCodexHookStdout('not json', readContext)).toBe('not json')
        expect(transformCodexHookStdout('', readContext)).toBe('')
    })
})

// Process-level pins: the DB-existence gate (a bd invocation in a fresh clone
// would CREATE an empty DB) and the never-break-session-start contract.
// Measured ~150ms per spawn solo; budgeted for the 6x load stretch.
describe('bd-prime-hook process behavior', { timeout: 20_000 }, () => {
    const script = fileURLToPath(new URL('./bd-prime-hook.mjs', import.meta.url))

    const slowRun = { at: '2026-09-24T20:00:00.000Z', ms: 37_200, ok: true, budgetMs: 20_000, spawns: [{ cmd: 'bd show', calls: 2, ms: 20_300 }] }

    const makeRepo = (opts: {
        dbReady: boolean
        /** Lines of the sync's run log (SYNC_RUN_LOG). */
        syncRuns?: object[]
        memoriesStdout?: string
        memoriesStderr?: string
        codexStdout?: string
        /** `bd --version` fails, as when bd is missing from PATH. */
        bdBroken?: boolean
    }) => {
        const repo = mkdtempSync(join(tmpdir(), 'bd-prime-hook-'))
        spawnSync('git', ['init', '-q'], { cwd: repo })
        mkdirSync(join(repo, '.beads'))
        if (opts.dbReady) mkdirSync(join(repo, '.beads', 'embeddeddolt'))
        if (opts.syncRuns)
            writeFileSync(join(repo, SYNC_RUN_LOG), opts.syncRuns.map(r => JSON.stringify(r)).join('\n') + '\n')
        const shimDir = join(repo, 'shim')
        mkdirSync(shimDir)
        const shimLog = join(repo, 'bd-shim.log')
        writeFileSync(shimLog, '')
        const fixture = join(repo, 'memories-fixture.txt')
        writeFileSync(fixture, opts.memoriesStdout ?? '')
        const stderrFixture = join(repo, 'memories-stderr.txt')
        writeFileSync(stderrFixture, opts.memoriesStderr ?? '')
        const codexFixture = join(repo, 'codex-fixture.txt')
        writeFileSync(codexFixture, opts.codexStdout ?? '')
        const codexInput = join(repo, 'codex-input.txt')
        // --version must answer with real text: initializedDbRoot treats empty
        // stdout as "bd missing", which would turn dbReady repos DB-less and
        // make the assertions vacuous.
        writeFileSync(
            join(shimDir, 'bd'),
            `#!/bin/sh\necho "bd $@" >> "${shimLog}"\ncase "$1" in\n  --version) ${opts.bdBroken ? 'exit 127' : 'echo "bd-shim 0.0.0"'};;\n  codex-hook) cat > "${codexInput}"; cat "${codexFixture}";;\n  memories) cat "${fixture}"; cat "${stderrFixture}" >&2;;\nesac\nexit 0\n`,
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

    const contextOf = (stdout: string) => {
        const parsed = JSON.parse(stdout).hookSpecificOutput
        expect(parsed.hookEventName).toBe('SessionStart')
        return parsed.additionalContext as string
    }

    it('exits 0 with no output in a DB-less clone, WITHOUT ever spawning bd', () => {
        const { run, shimCalls } = makeRepo({ dbReady: false })
        const r = run()
        expect(r.status).toBe(0)
        expect(r.stdout).toBe('')
        expect(shimCalls()).toBe('')
    })

    it('emits every key of a 262-key index in a DB-ready repo (shim interception works)', () => {
        const keys = syntheticKeys(REALISTIC)
        const { run, shimCalls } = makeRepo({ dbReady: true, memoriesStdout: memoriesJson(keys) })
        const r = run()
        expect(r.status).toBe(0)
        const context = contextOf(r.stdout)
        expect(context.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
        expect(readBack(context).keys.sort()).toEqual([...keys].sort())
        expect(shimCalls()).toContain('bd --version')
        expect(shimCalls()).toContain('bd memories --json')
        expect(shimCalls()).not.toContain('bd prime')
    })

    it('says the index is unavailable when bd memories reports an error (bd prints Error and exits 0)', () => {
        const { run } = makeRepo({ dbReady: true, memoriesStdout: 'Error: workspace database locked\n' })
        const r = run()
        expect(r.status).toBe(0)
        expect(contextOf(r.stdout)).toContain('index unavailable (Error: workspace database locked)')
    })

    it('says the index is unavailable on an Error on stderr even when stdout carries valid JSON', () => {
        const { run } = makeRepo({
            dbReady: true,
            memoriesStdout: memoriesJson(['feedback_alpha']),
            memoriesStderr: 'Error: memory table read failed\n',
        })
        const r = run()
        expect(r.status).toBe(0)
        const context = contextOf(r.stdout)
        expect(context).toContain('index unavailable (Error: memory table read failed)')
        expect(context).not.toContain('alpha')
    })

    it('opens the context with the sync alarm when the last two syncs were over budget', () => {
        const { run } = makeRepo({
            dbReady: true,
            syncRuns: [slowRun, slowRun],
            memoriesStdout: memoriesJson(['feedback_alpha']),
        })
        const r = run()
        expect(r.status).toBe(0)
        const context = contextOf(r.stdout)
        expect(context).toContain('bd-github-sync is over its 20s budget')
        expect(context).toContain('bd show ×2 20.3s')
        expect(context).toContain('feedback: alpha')

        const codex = makeRepo({
            dbReady: true,
            syncRuns: [slowRun, slowRun],
            codexStdout: wrap('native full context'),
            memoriesStdout: memoriesJson(['feedback_alpha']),
        })
        const viaCodex = codex.run(['--codex', 'SessionStart'], '{}')
        expect(viaCodex.status).toBe(0)
        expect(contextOf(viaCodex.stdout)).toContain('bd-github-sync is over its 20s budget')

        // A mid-session refresh re-injects the index, not the alarm: it would
        // otherwise repeat on every turn the refresh fires.
        const refresh = codex.run(['--codex', 'UserPromptSubmit'], '{}')
        expect(refresh.status).toBe(0)
        const refreshed = contextOf(refresh.stdout)
        expect(refreshed).toContain('feedback: alpha')
        expect(refreshed).not.toContain('bd-github-sync is over')
    })

    // The alarm does not depend on the memory index, so a failing read must
    // not take it down with it.
    it('still raises the sync alarm when bd memories fails', () => {
        const { run } = makeRepo({
            dbReady: true,
            syncRuns: [slowRun, slowRun],
            memoriesStdout: 'Error: workspace database locked\n',
        })
        const r = run()
        expect(r.status).toBe(0)
        expect(contextOf(r.stdout)).toContain('bd-github-sync is over its 20s budget')
    })

    // bd's native session start prints nothing when its own prime fails.
    it('carries the index and the alarm when the Codex session-start hook returns nothing', () => {
        const { run, shimCalls } = makeRepo({
            dbReady: true,
            syncRuns: [slowRun, slowRun],
            codexStdout: '',
            memoriesStdout: memoriesJson(['feedback_alpha']),
        })
        const r = run(['--codex', 'SessionStart'], '{}')
        expect(r.status).toBe(0)
        const context = contextOf(r.stdout)
        expect(context).toContain('bd-github-sync is over its 20s budget')
        expect(context).toContain('feedback: alpha')
        expect(shimCalls()).toContain('bd codex-hook SessionStart')
    })

    // bd itself can be what broke; the alarm reads only the log, so it still
    // opens the session, with no index to go with it.
    it('still raises the sync alarm when bd cannot run', () => {
        const failed = { at: '2026-09-24T20:00:00.000Z', ms: 400, ok: false, failure: 'bd is not runnable', budgetMs: 15_000, spawns: [] }
        const { run, shimCalls } = makeRepo({ dbReady: true, bdBroken: true, syncRuns: [failed, failed] })
        const r = run()
        expect(r.status).toBe(0)
        const context = contextOf(r.stdout)
        expect(context).toContain('failed its last two runs')
        expect(context).toContain('index unavailable (bd is not runnable)')
        expect(shimCalls()).not.toContain('bd memories')
    })

    // bd's native context is `bd prime`: a capped listing plus the close
    // protocol, which AGENTS.md's managed Beads block already injects.
    it('adds nothing to a mid-session Codex event when bd cannot run', () => {
        const { run, shimCalls } = makeRepo({ dbReady: true, bdBroken: true, syncRuns: [slowRun, slowRun] })
        const r = run(['--codex', 'UserPromptSubmit'], '{}')
        expect(r.status).toBe(0)
        expect(r.stdout).toBe('')
        expect(shimCalls()).not.toContain('bd codex-hook')
    })

    it('forwards the Codex event and stdin, then replaces native context with the index', () => {
        const native = JSON.stringify({
            continue: true,
            systemMessage: 'state updated',
            hookSpecificOutput: {
                hookEventName: 'PreCompact',
                additionalContext: '## Memories (showing 1 of 2)\n- **feedback_alpha**: x\n# 🚨 SESSION CLOSE PROTOCOL 🚨',
                metadata: { event: 'PreCompact' },
            },
        })
        const { run, shimCalls, codexInput } = makeRepo({
            dbReady: true,
            codexStdout: native,
            memoriesStdout: memoriesJson(['feedback_alpha', 'testing_beta']),
        })
        const r = run(['--codex', 'PreCompact'], '{"prompt":"keep this payload"}')
        expect(r.status).toBe(0)
        const parsed = JSON.parse(r.stdout)
        expect(parsed).toMatchObject({
            continue: true,
            systemMessage: 'state updated',
            hookSpecificOutput: { hookEventName: 'PreCompact', metadata: { event: 'PreCompact' } },
        })
        const context = parsed.hookSpecificOutput.additionalContext
        expect(readBack(context).keys).toEqual(['feedback_alpha', 'testing_beta'])
        expect(context).not.toContain('SESSION CLOSE PROTOCOL')
        expect(codexInput()).toBe('{"prompt":"keep this payload"}')
        expect(shimCalls()).toContain('bd codex-hook PreCompact')
        expect(shimCalls()).toContain('bd memories --json')
    })

    it('passes a native lifecycle result without context unchanged and does not read the index', () => {
        const native = '{"hookSpecificOutput":{"hookEventName":"PostCompact"},"continue":true}\n'
        const { run, shimCalls } = makeRepo({ dbReady: true, codexStdout: native })
        const r = run(['--codex', 'PostCompact'], '{}')
        expect(r.status).toBe(0)
        expect(r.stdout).toBe(native)
        expect(shimCalls()).toContain('bd codex-hook PostCompact')
        expect(shimCalls()).not.toContain('bd memories')
    })

    it('bounds native context when the index read fails', () => {
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
            memoriesStderr: 'Error: memory table read failed\n',
        })
        const r = run(['--codex', 'SessionStart'], '{}')
        expect(r.status).toBe(0)
        const context = contextOf(r.stdout)
        expect(context.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
        expect(context).toContain('index unavailable (Error: memory table read failed)')
    })

    it('does not invoke any bd command for Codex in a DB-less clone', () => {
        const { run, shimCalls } = makeRepo({ dbReady: false, codexStdout: 'should not run' })
        const r = run(['--codex', 'SessionStart'], '{}')
        expect(r.status).toBe(0)
        expect(r.stdout).toBe('')
        expect(shimCalls()).toBe('')
    })
})
