import { describe, expect, it } from 'vitest'
import {
  UNKNOWN_TOKEN_MARKER,
  unknownTokenProfileHelp,
  withUnknownTokenHelp,
} from '../src/client.js'

const store = '/tmp/agent-token.json'

describe('unknownTokenProfileHelp', () => {
  it('names the other saved profiles, because the message cannot', async () => {
    // The bridge's own text lists "a token/profile from another workspace or
    // browser profile" as a possible cause and gives no way to check it. The
    // profile names live on THIS machine, so only the CLI can supply them.
    const help = unknownTokenProfileHelp({
      profiles: [{name: 'default', savedAt: 1}, {name: 'work-browser', savedAt: 2}],
      tokenStorePath: store,
      inUse: 'default',
    })

    expect(help).toContain('work-browser')
    expect(help).toContain('--profile work-browser')
  })

  it('suggests ONE retry — the most recently paired — not a chain of them', async () => {
    // Measured against the real store: 19 profiles accumulate over a year of
    // test pairings, and enumerating a `--profile X or --profile Y` for each
    // buries the answer in the suggestion. Recency is the signal that the tab
    // in front of you was paired under it.
    const help = unknownTokenProfileHelp({
      profiles: [
        {name: 'default', savedAt: 50},
        {name: 'ancient', savedAt: 1},
        {name: 'newest', savedAt: 99},
        {name: 'middling', savedAt: 40},
      ],
      tokenStorePath: store,
      inUse: 'default',
    })

    expect(help).toContain('--profile newest')
    expect(help.match(/--profile /g)).toHaveLength(1)
    // The others are still listed, so a half-remembered name is findable.
    expect(help).toContain('ancient')
    expect(help).toContain('middling')
  })

  it('still suggests a retry when no profile carries a savedAt', async () => {
    const help = unknownTokenProfileHelp({
      profiles: [{name: 'default', savedAt: null}, {name: 'other', savedAt: null}],
      tokenStorePath: store,
      inUse: 'default',
    })

    expect(help).toContain('--profile other')
  })

  it('says the profile is NOT the problem when the one in use is the only one', async () => {
    // Naming a retry that cannot help is worse than silence: it sends the
    // reader round a loop that ends where it started.
    const help = unknownTokenProfileHelp({
      profiles: [{name: 'default', savedAt: 1}],
      tokenStorePath: store,
      inUse: 'default',
    })

    expect(help).not.toContain('--profile')
    expect(help).toMatch(/only saved profile/i)
  })

  it('points at pairing when nothing is saved at all', async () => {
    const help = unknownTokenProfileHelp({profiles: [], tokenStorePath: store, inUse: 'default'})

    expect(help).toContain('connect')
    expect(help).toContain(store)
  })

  it('names the profile in use even when it has no saved token', async () => {
    // Reachable with AGENT_RUNTIME_TOKEN set: the env token bypasses the store,
    // so the bridge is reached under a profile that was never paired. Deriving
    // "in use" from which stored entry matched rendered `none`, which is false
    // and sends the reader looking for a profile to switch to when the stale
    // env var is the cause.
    const help = unknownTokenProfileHelp({
      profiles: [{name: 'alpha', savedAt: 1}, {name: 'beta', savedAt: 5}],
      tokenStorePath: store,
      inUse: 'nosuch',
    })

    expect(help).toContain('`nosuch`')
    expect(help).not.toContain('none')
    expect(help).toContain('AGENT_RUNTIME_TOKEN')
  })

  it('exports the marker the server message actually contains', async () => {
    const { unknownTokenMessage } = await import('../src/protocol.js')
    expect(unknownTokenMessage).toContain(UNKNOWN_TOKEN_MARKER)
  })
})

describe('withUnknownTokenHelp', () => {
  const help = async () => 'PROFILE-HELP'

  it('leaves an unrelated error alone', async () => {
    // Every CLI failure goes through this path — a stray append would put a
    // profile listing under "block not found" and read as the cause.
    expect(await withUnknownTokenHelp('Unknown command `frobnicate`', help))
      .toBe('Unknown command `frobnicate`')
  })

  it('appends to the bridge\'s unknown-token error', async () => {
    expect(await withUnknownTokenHelp(`${UNKNOWN_TOKEN_MARKER} Common causes: …`, help))
      .toContain('PROFILE-HELP')
  })

  it('still reports the original error when reading the token store throws', async () => {
    // The store is a file: unreadable, malformed, or permission-denied are all
    // possible, and swallowing the real error to report THAT would be a strict
    // loss over not having this at all.
    const message = `${UNKNOWN_TOKEN_MARKER} Common causes: …`
    expect(await withUnknownTokenHelp(message, async () => { throw new Error('EACCES') }))
      .toBe(message)
  })
})
