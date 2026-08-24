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
      profiles: [
        {name: 'default', selected: true, savedAt: 1},
        {name: 'work-browser', selected: false, savedAt: 2},
      ],
      tokenStorePath: store,
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
        {name: 'default', selected: true, savedAt: 50},
        {name: 'ancient', selected: false, savedAt: 1},
        {name: 'newest', selected: false, savedAt: 99},
        {name: 'middling', selected: false, savedAt: 40},
      ],
      tokenStorePath: store,
    })

    expect(help).toContain('--profile newest')
    expect(help.match(/--profile /g)).toHaveLength(1)
    // The others are still listed, so a half-remembered name is findable.
    expect(help).toContain('ancient')
    expect(help).toContain('middling')
  })

  it('still suggests a retry when no profile carries a savedAt', async () => {
    const help = unknownTokenProfileHelp({
      profiles: [
        {name: 'default', selected: true, savedAt: null},
        {name: 'other', selected: false, savedAt: null},
      ],
      tokenStorePath: store,
    })

    expect(help).toContain('--profile other')
  })

  it('says the profile is NOT the problem when the one in use is the only one', async () => {
    // Naming a retry that cannot help is worse than silence: it sends the
    // reader round a loop that ends where it started.
    const help = unknownTokenProfileHelp({
      profiles: [{name: 'default', selected: true, savedAt: 1}],
      tokenStorePath: store,
    })

    expect(help).not.toContain('--profile')
    expect(help).toMatch(/only saved profile/i)
  })

  it('points at pairing when nothing is saved at all', async () => {
    const help = unknownTokenProfileHelp({profiles: [], tokenStorePath: store})

    expect(help).toContain('connect')
    expect(help).toContain(store)
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
