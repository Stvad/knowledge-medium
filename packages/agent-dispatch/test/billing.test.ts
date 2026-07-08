import {describe, expect, it} from 'vitest'
import {parseConfig} from '../src/config'
import {reportBillingPosture, relevantBillingEnvVars} from '../src/billing'

const config = (over: Record<string, unknown> = {}) =>
  parseConfig({watchers: [{kind: 'backlinks', name: 'm', target: 'claude'}], ...over})

describe('reportBillingPosture', () => {
  it('subscription mode names present credentials it will scrub (never their values)', () => {
    const report = reportBillingPosture(config(), {ANTHROPIC_API_KEY: 'sk-secret', PATH: '/usr/bin'})
    expect(report.mode).toBe('subscription')
    expect(report.present).toEqual(['ANTHROPIC_API_KEY'])
    const text = report.lines.join('\n')
    expect(text).toContain('billing=subscription')
    expect(text).toContain('ANTHROPIC_API_KEY') // by name…
    expect(text).not.toContain('sk-secret')     // …never the value
    // The auth.json/apiKeyHelper gap is called out, not silently ignored.
    expect(text).toMatch(/auth\.json|apiKeyHelper/)
  })

  it('api mode warns loudly and does not claim to scrub', () => {
    const report = reportBillingPosture(config({billing: 'api'}), {OPENAI_API_KEY: 'sk'})
    expect(report.mode).toBe('api')
    const text = report.lines.join('\n')
    expect(text).toContain('billing=api')
    expect(text).toMatch(/NOT scrubbed|usage-based/)
  })

  it('scopes the relevant credential vars to the executors actually configured', () => {
    // A claude-only config need not mention OPENAI_*; a codex watcher pulls them in.
    const claudeOnly = relevantBillingEnvVars(config())
    expect(claudeOnly).toContain('ANTHROPIC_API_KEY')
    expect(claudeOnly).not.toContain('OPENAI_API_KEY')

    const withCodex = relevantBillingEnvVars(config({
      watchers: [
        {kind: 'backlinks', name: 'c', target: 'claude'},
        {kind: 'backlinks', name: 'x', target: 'codex', runner: {executor: 'codex'}},
      ],
    }))
    expect(withCodex).toContain('ANTHROPIC_API_KEY')
    expect(withCodex).toContain('OPENAI_API_KEY')
    expect(withCodex).toContain('CODEX_API_KEY')
  })

  it('ignores an empty-string env var (treated as absent)', () => {
    const report = reportBillingPosture(config(), {ANTHROPIC_API_KEY: ''})
    expect(report.present).toEqual([])
  })
})
