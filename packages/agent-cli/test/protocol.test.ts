/**
 * Smoke tests for the wire-protocol schemas. The schemas back both the
 * CLI's response typing and the server's body validation, so it's
 * worth pinning their tolerance behaviour explicitly — particularly
 * the loose vs. strict choices, because flipping one affects what
 * clients can send in metadata.
 */
import {describe, expect, it} from 'vitest'
import {
  commandPayloadSchema,
  commandStatusResponseSchema,
  registerClientMetadataSchema,
  registerTokenSpecSchema,
  whoamiInfoSchema,
} from '../src/protocol'

describe('commandPayloadSchema', () => {
  it('requires a string `type` discriminator', () => {
    expect(commandPayloadSchema.safeParse({}).success).toBe(false)
    expect(commandPayloadSchema.safeParse({type: 42}).success).toBe(false)
    expect(commandPayloadSchema.safeParse({type: 'ping'}).success).toBe(true)
  })

  it('passes extra fields through verbatim — kernel handlers read them', () => {
    const result = commandPayloadSchema.safeParse({
      type: 'sql',
      mode: 'all',
      sql: 'SELECT 1',
      params: [],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      // Extra keys must survive parsing or sql/install-extension/etc.
      // would lose their bodies on the way to the kernel.
      expect((result.data as Record<string, unknown>).sql).toBe('SELECT 1')
      expect((result.data as Record<string, unknown>).mode).toBe('all')
    }
  })

  it('rejects non-object inputs', () => {
    expect(commandPayloadSchema.safeParse(null).success).toBe(false)
    expect(commandPayloadSchema.safeParse('hello').success).toBe(false)
    expect(commandPayloadSchema.safeParse([]).success).toBe(false)
  })
})

describe('registerTokenSpecSchema', () => {
  it('requires a non-empty `token`', () => {
    expect(registerTokenSpecSchema.safeParse({}).success).toBe(false)
    expect(registerTokenSpecSchema.safeParse({token: ''}).success).toBe(false)
    expect(registerTokenSpecSchema.safeParse({token: 'abc'}).success).toBe(true)
  })

  it('allows the optional audience fields and unknown extras', () => {
    const result = registerTokenSpecSchema.safeParse({
      token: 'abc',
      userId: 'u1',
      workspaceId: 'w1',
      label: 'chrome-dev',
      scope: 'read-only',
      extraNote: 'pass-through',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.token).toBe('abc')
      expect(result.data.userId).toBe('u1')
      expect(result.data.scope).toBe('read-only')
    }
  })

  it('rejects malformed entries (the server filters these out individually)', () => {
    expect(registerTokenSpecSchema.safeParse({token: 123}).success).toBe(false)
    expect(registerTokenSpecSchema.safeParse({token: 'abc', userId: 42}).success).toBe(false)
  })
})

describe('registerClientMetadataSchema', () => {
  it('accepts the empty object (a client may register before any tokens)', () => {
    expect(registerClientMetadataSchema.safeParse({}).success).toBe(true)
  })

  it('keeps unknown metadata fields — /health echoes them back', () => {
    const result = registerClientMetadataSchema.safeParse({
      audience: {userId: 'u1', workspaceId: 'w1'},
      activeWorkspaceId: 'w1',
      currentUser: {id: 'u1', name: 'V'},
    })
    expect(result.success).toBe(true)
    if (result.success) {
      // Loose-object: extras (activeWorkspaceId, currentUser) survive.
      expect((result.data as Record<string, unknown>).activeWorkspaceId).toBe('w1')
      expect((result.data as Record<string, unknown>).currentUser).toEqual({id: 'u1', name: 'V'})
    }
  })

  it('does NOT validate per-token-entry shapes — server does that per entry', () => {
    // The outer parse only checks `tokens` is an array of unknown.
    // The server safe-parses each entry with registerTokenSpecSchema
    // separately so one bad entry doesn't reject the whole client.
    const result = registerClientMetadataSchema.safeParse({
      tokens: [{token: 'good'}, {token: 42}, 'not-even-an-object'],
    })
    expect(result.success).toBe(true)
  })
})

describe('whoamiInfoSchema', () => {
  it('requires the audience + scope + connection state', () => {
    const valid = {
      clientId: 'c1',
      audience: {userId: 'u1', workspaceId: 'w1', label: 'chrome-dev'},
      scope: 'read-write',
      connected: true,
      clientLastSeen: 12345,
    }
    expect(whoamiInfoSchema.safeParse(valid).success).toBe(true)

    expect(whoamiInfoSchema.safeParse({...valid, scope: 'admin'}).success).toBe(false)
    expect(whoamiInfoSchema.safeParse({...valid, audience: {userId: 'u1'}}).success).toBe(false)
  })

  it('accepts a null clientLastSeen (client never connected yet)', () => {
    const result = whoamiInfoSchema.safeParse({
      clientId: 'c1',
      audience: {userId: null, workspaceId: null, label: null},
      scope: 'read-only',
      connected: false,
      clientLastSeen: null,
    })
    expect(result.success).toBe(true)
  })
})

describe('commandStatusResponseSchema', () => {
  it('parses a completed command with a successful result envelope', () => {
    const result = commandStatusResponseSchema.safeParse({
      id: 'cmd-1',
      status: 'completed',
      result: {ok: true, value: {answer: 42}},
      clientId: 'client-1',
      targetClientId: 'client-1',
      createdAt: 1,
      deliveredAt: 2,
      completedAt: 3,
    })
    expect(result.success).toBe(true)
  })

  it('parses a failed command with an error envelope', () => {
    const result = commandStatusResponseSchema.safeParse({
      id: 'cmd-2',
      status: 'failed',
      result: {ok: false, error: {name: 'ClientGone', message: 'disconnected'}},
      clientId: 'client-1',
      targetClientId: 'client-1',
      createdAt: 1,
      deliveredAt: null,
      completedAt: 3,
    })
    expect(result.success).toBe(true)
  })

  it('rejects an unknown status value', () => {
    expect(commandStatusResponseSchema.safeParse({
      id: 'cmd-3',
      status: 'unknown',
      result: null,
      clientId: null,
      targetClientId: 'client-1',
      createdAt: 1,
      deliveredAt: null,
      completedAt: null,
    }).success).toBe(false)
  })
})
