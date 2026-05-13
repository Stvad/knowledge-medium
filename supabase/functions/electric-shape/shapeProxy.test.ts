import { describe, expect, it } from 'vitest'
import {
  handleElectricShapeProxy,
  type ElectricShapeProxyEnv,
} from './shapeProxy'

const env: ElectricShapeProxyEnv = {
  ELECTRIC_URL: 'https://electric.example',
  ELECTRIC_SOURCE_ID: 'source-id',
  ELECTRIC_SOURCE_SECRET: 'source-secret',
  SUPABASE_URL: 'https://supabase.example',
  SUPABASE_ANON_KEY: 'anon-key',
}

const request = (path: string, init: RequestInit = {}) =>
  new Request(`https://proxy.example/electric-shape${path}`, {
    ...init,
    headers: {
      Authorization: 'Bearer user-token',
      ...(init.headers ?? {}),
    },
  })

const jsonResponse = (value: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })

describe('handleElectricShapeProxy', () => {
  it('handles CORS preflight without requiring auth', async () => {
    const response = await handleElectricShapeProxy(
      request('/blocks', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.example',
        },
      }),
      env,
      {fetch: (() => { throw new Error('fetch should not be called') }) as typeof fetch},
    )

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-allow-headers')).toContain('Authorization')
  })

  it('rejects requests without a bearer token', async () => {
    const response = await handleElectricShapeProxy(
      new Request('https://proxy.example/electric-shape/blocks'),
      env,
      {fetch: (() => { throw new Error('fetch should not be called') }) as typeof fetch},
    )

    expect(response.status).toBe(401)
    expect(await response.text()).toBe('Missing bearer token')
  })

  it('rejects unknown shape names', async () => {
    const response = await handleElectricShapeProxy(
      request('/workspace_invitations'),
      env,
      {fetch: (() => { throw new Error('fetch should not be called') }) as typeof fetch},
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({error: 'unknown_shape'})
  })

  it('pins the blocks shape server-side and only forwards Electric protocol params', async () => {
    const calls: URL[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = input instanceof URL ? input : new URL(String(input))
      calls.push(url)

      if (url.hostname === 'supabase.example') {
        expect(url.pathname).toBe('/rest/v1/workspace_members')
        return jsonResponse([
          {workspace_id: 'ws-b'},
          {workspace_id: 'ws-a'},
          {workspace_id: 'ws-a'},
        ])
      }

      return new Response('[]', {
        status: 200,
        headers: {
          'content-encoding': 'gzip',
          'content-length': '123',
          'electric-handle': 'shape-handle',
        },
      })
    }) as typeof fetch

    const response = await handleElectricShapeProxy(
      request('/blocks?offset=-1&handle=h&table=workspace_invitations&where=true&secret=attacker&replica=default'),
      env,
      {fetch: fetchImpl},
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('content-length')).toBeNull()
    expect(response.headers.get('electric-handle')).toBe('shape-handle')

    const electricUrl = calls[1]
    expect(electricUrl?.origin).toBe('https://electric.example')
    expect(electricUrl?.pathname).toBe('/v1/shape')
    expect(electricUrl?.searchParams.get('source_id')).toBe('source-id')
    expect(electricUrl?.searchParams.get('secret')).toBe('source-secret')
    expect(electricUrl?.searchParams.get('table')).toBe('blocks')
    expect(electricUrl?.searchParams.get('replica')).toBe('full')
    expect(electricUrl?.searchParams.get('where')).toBe('"workspace_id" IN ($1, $2)')
    expect(electricUrl?.searchParams.get('params[1]')).toBe('ws-a')
    expect(electricUrl?.searchParams.get('params[2]')).toBe('ws-b')
    expect(electricUrl?.searchParams.get('offset')).toBe('-1')
    expect(electricUrl?.searchParams.get('handle')).toBe('h')
  })

  it('uses id as the workspace predicate column for workspaces', async () => {
    const calls: URL[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = input instanceof URL ? input : new URL(String(input))
      calls.push(url)
      return url.hostname === 'supabase.example'
        ? jsonResponse([{workspace_id: 'ws-1'}])
        : new Response('[]')
    }) as typeof fetch

    await handleElectricShapeProxy(request('/workspaces'), env, {fetch: fetchImpl})

    expect(calls[1]?.searchParams.get('table')).toBe('workspaces')
    expect(calls[1]?.searchParams.get('where')).toBe('"id" IN ($1)')
  })

  it('returns an empty shape predicate when the caller has no workspaces', async () => {
    const calls: URL[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = input instanceof URL ? input : new URL(String(input))
      calls.push(url)
      return url.hostname === 'supabase.example'
        ? jsonResponse([])
        : new Response('[]')
    }) as typeof fetch

    await handleElectricShapeProxy(request('/blocks'), env, {fetch: fetchImpl})

    expect(calls[1]?.searchParams.get('where')).toBe('1 = 0')
    expect(calls[1]?.searchParams.has('params[1]')).toBe(false)
  })
})
