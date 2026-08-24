import { describe, expect, it } from 'vitest'
import {
  BridgeHttpError,
  formatTokenContext,
  MissingTokenError,
  UNKNOWN_TOKEN_MARKER,
  withProfileHelp,
} from '../src/client.js'

const store = '/tmp/agent-token.json'
const dated = [
  {name: 'zeta', savedAt: Date.UTC(2026, 7, 22, 14, 3)},
  {name: 'alpha', savedAt: Date.UTC(2026, 6, 14, 9, 30)},
]

describe('formatTokenContext', () => {
  it('lists each profile with its pairing instant, and marks the selected one', () => {
    const out = formatTokenContext({
      profiles: dated, tokenStorePath: store, selected: 'alpha', envTokenOverride: false,
    })

    expect(out).toContain(store)
    expect(out).toMatch(/alpha\s+2026-07-14 09:30Z\s+← selected/)
    expect(out).toMatch(/zeta\s+2026-08-22 14:03Z/)
    expect(out).toContain('selected profile: alpha')
    // Alphabetical, not ranked: the instants are printed, so ordering the rows
    // by recency would be the tool taking a position it does not need to take.
    expect(out.indexOf('alpha')).toBeLessThan(out.indexOf('zeta'))
  })

  it('states the selected profile even when the store has no entry for it', () => {
    const out = formatTokenContext({
      profiles: dated, tokenStorePath: store, selected: 'nosuch', envTokenOverride: false,
    })

    expect(out).toContain('selected profile: nosuch')
    expect(out).not.toContain('← selected')
  })

  it('says so when a profile carries no pairing timestamp', () => {
    const out = formatTokenContext({
      profiles: [{name: 'legacy'}], tokenStorePath: store, selected: 'legacy', envTokenOverride: false,
    })

    expect(out).toContain('(no pairing timestamp)')
  })

  it('notes the env override only when it is set', () => {
    const args = {profiles: dated, tokenStorePath: store, selected: 'alpha'}

    expect(formatTokenContext({...args, envTokenOverride: true}))
      .toContain('AGENT_RUNTIME_TOKEN is set')
    expect(formatTokenContext({...args, envTokenOverride: false}))
      .not.toContain('AGENT_RUNTIME_TOKEN')
  })

  it('still reports the override and the selection when the store cannot be read', () => {
    // The override needs no store at all. Reading the store eagerly, so that a
    // malformed or unreadable file suppressed every other fact with it, is the
    // bug this signature exists to prevent — hence `null` rather than a throw.
    const out = formatTokenContext({
      profiles: null, tokenStorePath: store, selected: 'alpha', envTokenOverride: true,
    })

    expect(out).toContain('could not be read')
    expect(out).toContain('selected profile: alpha')
    expect(out).toContain('AGENT_RUNTIME_TOKEN is set')
  })

  it('says the store is empty rather than listing nothing', () => {
    const out = formatTokenContext({
      profiles: [], tokenStorePath: store, selected: 'default', envTokenOverride: false,
    })

    expect(out).toContain('no profiles saved')
  })

  it('asserts no cause and recommends no remedy', () => {
    // The regression guard for this module's reason to exist. Advice about a
    // cause or a remedy has to be true in every combination of the state it is
    // drawn from, and it repeatedly was not; facts have no such failure mode.
    // Re-adding advice reintroduces the class, not one bug — which is why this
    // asserts over every input shape rather than one.
    const outputs = [true, false].flatMap(envTokenOverride =>
      [dated, [], null, [{name: 'legacy'}]].map(profiles => formatTokenContext({
        profiles, tokenStorePath: store, selected: 'alpha', envTokenOverride,
      })))

    for (const out of outputs) {
      expect(out).not.toMatch(/recently paired|not the cause|not the problem|retry with/i)
    }
  })
})

describe('withProfileHelp', () => {
  const help = async () => 'TOKEN-CONTEXT'

  it('leaves an unrelated error alone', async () => {
    // Every CLI failure reaches this path — a stray append would put the token
    // store under "block not found" and read as the cause.
    expect(await withProfileHelp(new Error('Unknown command `frobnicate`'), help))
      .toBe('Unknown command `frobnicate`')
  })

  it('appends to the bridge\'s 401', async () => {
    const error = new BridgeHttpError(`${UNKNOWN_TOKEN_MARKER} Common causes: …`, 401)
    expect(await withProfileHelp(error, help)).toContain('TOKEN-CONTEXT')
  })

  it('appends to the LOCAL missing-token refusal', async () => {
    // The commonest shape of this failure never reaches the bridge: an unpaired
    // selected profile is refused locally, with no 401 and no marker.
    expect(await withProfileHelp(new MissingTokenError('default'), help))
      .toContain('TOKEN-CONTEXT')
  })

  it('ignores the marker when it did not come from a 401', async () => {
    // `kmagent eval` runs arbitrary code in the app: it can throw a message
    // containing this sentence while submission and auth both succeeded.
    const error = new Error(`${UNKNOWN_TOKEN_MARKER} thrown by evaluated code`)
    expect(await withProfileHelp(error, help)).not.toContain('TOKEN-CONTEXT')
  })

  it('reports the original error if building the context throws', async () => {
    const error = new BridgeHttpError(`${UNKNOWN_TOKEN_MARKER} Common causes: …`, 401)
    expect(await withProfileHelp(error, async () => { throw new Error('boom') }))
      .toBe(error.message)
  })

  it('exports the marker the server message actually contains', async () => {
    const { unknownTokenMessage } = await import('../src/protocol.js')
    expect(unknownTokenMessage).toContain(UNKNOWN_TOKEN_MARKER)
  })
})
