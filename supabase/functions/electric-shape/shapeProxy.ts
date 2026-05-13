export interface ElectricShapeProxyEnv {
  ELECTRIC_URL?: string
  ELECTRIC_SOURCE_ID?: string
  ELECTRIC_SOURCE_SECRET?: string
  ELECTRIC_SHAPE_ALLOWED_ORIGINS?: string
  SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
}

export interface ElectricShapeProxyDeps {
  fetch?: typeof fetch
}

type ShapeName = 'blocks' | 'workspaces' | 'workspace_members'

const DEFAULT_ELECTRIC_URL = 'https://api.electric-sql.cloud'

const ELECTRIC_PROTOCOL_QUERY_PARAMS = new Set([
  'live',
  'live_sse',
  'experimental_live_sse',
  'handle',
  'offset',
  'cursor',
  'expired_handle',
  'log',
  'subset__where',
  'subset__limit',
  'subset__offset',
  'subset__order_by',
  'subset__where_expr',
  'subset__order_by_expr',
  'cache-buster',
])

const ELECTRIC_PROTOCOL_QUERY_PARAM_PREFIXES = [
  'subset__params[',
]

const SHAPE_CONFIG: Record<ShapeName, {
  table: ShapeName
  workspaceColumn: 'workspace_id' | 'id'
  columns: readonly string[]
}> = {
  blocks: {
    table: 'blocks',
    workspaceColumn: 'workspace_id',
    columns: [
      'id',
      'workspace_id',
      'parent_id',
      'order_key',
      'content',
      'properties_json',
      'references_json',
      'created_at',
      'updated_at',
      'created_by',
      'updated_by',
      'write_id',
      'deleted',
    ],
  },
  workspaces: {
    table: 'workspaces',
    workspaceColumn: 'id',
    columns: [
      'id',
      'name',
      'owner_user_id',
      'create_time',
      'update_time',
    ],
  },
  workspace_members: {
    table: 'workspace_members',
    workspaceColumn: 'workspace_id',
    columns: [
      'id',
      'workspace_id',
      'user_id',
      'role',
      'create_time',
    ],
  },
}

const ELECTRIC_EXPOSED_HEADERS = [
  'electric-cursor',
  'electric-handle',
  'electric-offset',
  'electric-schema',
  'electric-up-to-date',
]

const parseAllowedOrigins = (env: ElectricShapeProxyEnv): string[] =>
  (env.ELECTRIC_SHAPE_ALLOWED_ORIGINS ?? '*')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)

const allowedOriginFor = (
  request: Request,
  env: ElectricShapeProxyEnv,
): string | null => {
  const allowed = parseAllowedOrigins(env)
  if (allowed.includes('*')) return '*'

  const origin = request.headers.get('origin')
  if (!origin) return allowed[0] ?? null
  return allowed.includes(origin) ? origin : null
}

const corsHeadersFor = (
  request: Request,
  env: ElectricShapeProxyEnv,
): Headers | null => {
  const origin = allowedOriginFor(request, env)
  if (!origin) return null

  const headers = new Headers()
  headers.set('Access-Control-Allow-Origin', origin)
  headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS')
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  headers.set('Access-Control-Expose-Headers', ELECTRIC_EXPOSED_HEADERS.join(', '))
  headers.set('Vary', 'Origin, Authorization')
  return headers
}

const jsonResponse = (
  request: Request,
  env: ElectricShapeProxyEnv,
  status: number,
  payload: Record<string, unknown>,
): Response => {
  const headers = corsHeadersFor(request, env) ?? new Headers()
  headers.set('Content-Type', 'application/json')
  return new Response(JSON.stringify(payload), {status, headers})
}

const requiredEnv = (
  env: ElectricShapeProxyEnv,
  key: keyof ElectricShapeProxyEnv,
): string => {
  const value = env[key]?.trim()
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`)
  }
  return value
}

const bearerTokenFrom = (request: Request): string | null => {
  const authorization = request.headers.get('authorization')?.trim()
  if (!authorization) return null
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() ?? null
}

const shapeNameFromPath = (request: Request): ShapeName | null => {
  const url = new URL(request.url)
  const shapeName = url.pathname.split('/').filter(Boolean).at(-1)
  return shapeName === 'blocks' ||
    shapeName === 'workspaces' ||
    shapeName === 'workspace_members'
    ? shapeName
    : null
}

const shouldForwardElectricParam = (key: string): boolean =>
  ELECTRIC_PROTOCOL_QUERY_PARAMS.has(key) ||
  ELECTRIC_PROTOCOL_QUERY_PARAM_PREFIXES.some(prefix => key.startsWith(prefix))

const uniqueWorkspaceIds = (
  rows: readonly {workspace_id?: unknown}[],
): string[] => {
  const ids = new Set<string>()
  for (const row of rows) {
    if (typeof row.workspace_id === 'string' && row.workspace_id.length > 0) {
      ids.add(row.workspace_id)
    }
  }
  return [...ids].sort()
}

const loadAllowedWorkspaceIds = async (
  request: Request,
  env: ElectricShapeProxyEnv,
  fetchImpl: typeof fetch,
): Promise<string[]> => {
  const token = bearerTokenFrom(request)
  if (!token) {
    throw new Response('Missing bearer token', {status: 401})
  }

  const supabaseUrl = requiredEnv(env, 'SUPABASE_URL')
  const anonKey = requiredEnv(env, 'SUPABASE_ANON_KEY')
  const url = new URL('/rest/v1/workspace_members', supabaseUrl)
  url.searchParams.set('select', 'workspace_id')

  const response = await fetchImpl(url, {
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${token}`,
    },
  })

  if (!response.ok) {
    throw new Response('Failed to authorize workspace access', {status: 401})
  }

  const rows = await response.json() as Array<{workspace_id?: unknown}>
  return uniqueWorkspaceIds(rows)
}

const addWorkspacePredicate = (
  url: URL,
  workspaceColumn: string,
  workspaceIds: readonly string[],
): void => {
  if (workspaceIds.length === 0) {
    url.searchParams.set('where', '1 = 0')
    return
  }

  const placeholders = workspaceIds.map((_, index) => `$${index + 1}`)
  url.searchParams.set('where', `"${workspaceColumn}" IN (${placeholders.join(', ')})`)
  workspaceIds.forEach((workspaceId, index) => {
    url.searchParams.set(`params[${index + 1}]`, workspaceId)
  })
}

const buildElectricShapeUrl = (
  request: Request,
  env: ElectricShapeProxyEnv,
  shapeName: ShapeName,
  workspaceIds: readonly string[],
): URL => {
  const requestUrl = new URL(request.url)
  const electricUrl = new URL('/v1/shape', env.ELECTRIC_URL?.trim() || DEFAULT_ELECTRIC_URL)
  const shapeConfig = SHAPE_CONFIG[shapeName]

  requestUrl.searchParams.forEach((value, key) => {
    if (shouldForwardElectricParam(key)) {
      electricUrl.searchParams.append(key, value)
    }
  })

  electricUrl.searchParams.set('source_id', requiredEnv(env, 'ELECTRIC_SOURCE_ID'))
  electricUrl.searchParams.set('secret', requiredEnv(env, 'ELECTRIC_SOURCE_SECRET'))
  electricUrl.searchParams.set('table', shapeConfig.table)
  electricUrl.searchParams.set('columns', shapeConfig.columns.join(','))
  electricUrl.searchParams.set('replica', 'full')
  addWorkspacePredicate(electricUrl, shapeConfig.workspaceColumn, workspaceIds)

  return electricUrl
}

const mergeHeaders = (base: Headers, extra: Headers): Headers => {
  const headers = new Headers(base)
  extra.forEach((value, key) => headers.set(key, value))
  return headers
}

export const handleElectricShapeProxy = async (
  request: Request,
  env: ElectricShapeProxyEnv,
  deps: ElectricShapeProxyDeps = {},
): Promise<Response> => {
  const corsHeaders = corsHeadersFor(request, env)
  if (!corsHeaders) {
    return new Response('Origin not allowed', {status: 403})
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, {status: 204, headers: corsHeaders})
  }

  if (request.method !== 'GET') {
    return jsonResponse(request, env, 405, {error: 'method_not_allowed'})
  }

  const shapeName = shapeNameFromPath(request)
  if (!shapeName) {
    return jsonResponse(request, env, 404, {error: 'unknown_shape'})
  }

  const fetchImpl = deps.fetch ?? fetch

  try {
    const workspaceIds = await loadAllowedWorkspaceIds(request, env, fetchImpl)
    const electricUrl = buildElectricShapeUrl(request, env, shapeName, workspaceIds)
    const electricResponse = await fetchImpl(electricUrl)
    const headers = mergeHeaders(electricResponse.headers, corsHeaders)

    headers.delete('content-encoding')
    headers.delete('content-length')
    headers.set('Vary', 'Origin, Authorization')

    return new Response(electricResponse.body, {
      status: electricResponse.status,
      statusText: electricResponse.statusText,
      headers,
    })
  } catch (error) {
    if (error instanceof Response) {
      const headers = mergeHeaders(error.headers, corsHeaders)
      return new Response(error.body, {
        status: error.status,
        statusText: error.statusText,
        headers,
      })
    }

    const message = error instanceof Error ? error.message : String(error)
    const status = message.startsWith('Missing required environment variable')
      ? 500
      : 502
    return jsonResponse(request, env, status, {error: message})
  }
}
