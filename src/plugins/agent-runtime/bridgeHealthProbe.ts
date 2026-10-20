export type BridgeHealthProbeMode = 'standard' | 'loopback'

export type BridgeHealthPermissionState = 'granted' | 'denied' | 'prompt' | 'unsupported'

export type BridgeHealthProbeErrorName =
  | 'AbortError'
  | 'HttpError'
  | 'InvalidBridgeUrl'
  | 'NetworkError'
  | 'SyntaxError'
  | 'TimeoutError'
  | 'TypeError'
  | 'UnknownError'

export type BridgeHealthProbeErrorCategory =
  | 'http-status'
  | 'invalid-bridge-url'
  | 'invalid-json'
  | 'network-error'
  | 'timeout'
  | 'unexpected-error'

export interface BridgeHealthProbeResult {
  mode: BridgeHealthProbeMode
  startedAt: string
  finishedAt: string
  status: number | null
  bodyOk: boolean
  loopbackPermission: BridgeHealthPermissionState
  error?: {
    name: BridgeHealthProbeErrorName
    category: BridgeHealthProbeErrorCategory
  }
}

export interface BridgeHealthProbeOptions {
  getBridgeUrl: () => string
  mode: BridgeHealthProbeMode
  fetchFn?: typeof fetch
  permissionQuery?: (name: 'loopback-network') => Promise<{state: string}>
  timeoutMs?: number
  permissionTimeoutMs?: number
  now?: () => Date
}

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const safeErrorNames = new Set<BridgeHealthProbeErrorName>([
  'AbortError',
  'HttpError',
  'InvalidBridgeUrl',
  'NetworkError',
  'SyntaxError',
  'TimeoutError',
  'TypeError',
  'UnknownError',
])
const permissionStates = new Set<BridgeHealthPermissionState>([
  'granted', 'denied', 'prompt', 'unsupported',
])

class ProbeFailure extends Error {
  constructor(
    readonly safeName: BridgeHealthProbeErrorName,
    readonly category: BridgeHealthProbeErrorCategory,
  ) {
    super(safeName)
  }
}

const makeResult = (
  mode: BridgeHealthProbeMode,
  startedAt: string,
  now: () => Date,
  values: Pick<BridgeHealthProbeResult, 'status' | 'bodyOk' | 'loopbackPermission'>,
  error?: BridgeHealthProbeResult['error'],
): BridgeHealthProbeResult => ({
  mode,
  startedAt,
  finishedAt: now().toISOString(),
  ...values,
  ...(error ? {error} : {}),
})

const sanitizeFailure = (error: unknown): NonNullable<BridgeHealthProbeResult['error']> => {
  if (error instanceof ProbeFailure) {
    return {name: error.safeName, category: error.category}
  }

  // Read `name` exactly once and never inspect arbitrary error text. A thrown
  // accessor must not escape this diagnostics-only path.
  let rawName: unknown
  try {
    rawName = error !== null && (typeof error === 'object' || typeof error === 'function')
      ? (error as {name?: unknown}).name
      : undefined
  } catch {
    rawName = undefined
  }

  const name = typeof rawName === 'string' && safeErrorNames.has(rawName as BridgeHealthProbeErrorName)
    ? rawName as BridgeHealthProbeErrorName
    : 'UnknownError'
  const category: BridgeHealthProbeErrorCategory = name === 'SyntaxError'
    ? 'invalid-json'
    : name === 'TypeError' || name === 'NetworkError' || name === 'AbortError'
      ? 'network-error'
      : 'unexpected-error'
  return {name, category}
}

const parseLoopbackHealthUrl = (value: string): string => {
  try {
    const parsed = new URL(value)
    const schemeSeparator = value.indexOf('://')
    const authority = schemeSeparator >= 0
      ? value.slice(schemeSeparator + 3).split(/[/?#]/, 1)[0]
      : ''
    const hostname = parsed.hostname.toLowerCase()
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || authority.includes('@')
      || !loopbackHosts.has(hostname)
    ) {
      throw new ProbeFailure('InvalidBridgeUrl', 'invalid-bridge-url')
    }
    return `${parsed.origin}/health`
  } catch (error) {
    if (error instanceof ProbeFailure) throw error
    throw new ProbeFailure('InvalidBridgeUrl', 'invalid-bridge-url')
  }
}

const defaultPermissionQuery = async (name: 'loopback-network') => {
  const permissions = globalThis.navigator?.permissions as (Permissions & {
    query?: (descriptor: PermissionDescriptor | {name: string}) => Promise<PermissionStatus>
  }) | undefined
  if (!permissions || typeof permissions.query !== 'function') {
    throw new Error('unsupported')
  }
  return permissions.query({name} as unknown as PermissionDescriptor)
}

const readPermissionState = async (
  query: NonNullable<BridgeHealthProbeOptions['permissionQuery']>,
  timeoutMs: number,
): Promise<BridgeHealthPermissionState> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<BridgeHealthPermissionState>(resolve => {
    timer = setTimeout(() => resolve('unsupported'), timeoutMs)
  })
  try {
    const requested = Promise.resolve().then(() => query('loopback-network'))
    const result = await Promise.race([requested, timeout])
    let rawState: unknown
    try {
      rawState = typeof result === 'string'
        ? result
        : result && typeof result === 'object'
          ? result.state
          : undefined
    } catch {
      return 'unsupported'
    }
    return typeof rawState === 'string'
      && permissionStates.has(rawState as BridgeHealthPermissionState)
      ? rawState as BridgeHealthPermissionState
      : 'unsupported'
  } catch {
    return 'unsupported'
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Run one explicit, token-free /health diagnostic against the configured
 * loopback bridge. The annotated variant changes only this diagnostic request.
 */
export const runBridgeHealthProbe = async ({
  getBridgeUrl,
  mode,
  fetchFn = globalThis.fetch.bind(globalThis),
  permissionQuery = defaultPermissionQuery,
  timeoutMs = 5_000,
  permissionTimeoutMs = 1_000,
  now = () => new Date(),
}: BridgeHealthProbeOptions): Promise<BridgeHealthProbeResult> => {
  const startedAt = now().toISOString()
  let status: number | null = null
  let bodyOk = false
  let url: string

  try {
    url = parseLoopbackHealthUrl(getBridgeUrl())
  } catch (error) {
    const sanitized = sanitizeFailure(error)
    const loopbackPermission = await readPermissionState(permissionQuery, permissionTimeoutMs)
    return makeResult(mode, startedAt, now, {status, bodyOk, loopbackPermission}, sanitized)
  }

  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let request: Promise<Response>

  // Invoke fetch before creating/awaiting the permission query: this makes the
  // probe start directly in the button click path, not after permission work.
  try {
    const init: RequestInit & {targetAddressSpace?: 'loopback'} = {
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    }
    if (mode === 'loopback') init.targetAddressSpace = 'loopback'
    request = Promise.resolve(fetchFn(url, init))
  } catch (error) {
    request = Promise.reject(error)
  }

  const fetchResult = (async () => {
    const response = await request
    status = response.status
    let body: unknown
    try {
      body = await response.json()
    } catch (error) {
      throw new ProbeFailure(
        error instanceof SyntaxError ? 'SyntaxError' : sanitizeFailure(error).name,
        'invalid-json',
      )
    }
    bodyOk = typeof body === 'object' && body !== null
      && (body as {ok?: unknown}).ok === true
    if (!response.ok) throw new ProbeFailure('HttpError', 'http-status')
  })()

  const timedFetch = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(new ProbeFailure('TimeoutError', 'timeout'))
    }, timeoutMs)
    fetchResult.then(resolve, reject)
  })
  const permissionPromise = readPermissionState(permissionQuery, permissionTimeoutMs)

  let error: BridgeHealthProbeResult['error']
  try {
    const fetchOutcome = timedFetch.then(
      () => ({ok: true as const}),
      caught => ({ok: false as const, error: caught}),
    )
    const [outcome, permissionState] = await Promise.all([fetchOutcome, permissionPromise])
    if (!outcome.ok) {
      error = timedOut
        ? {name: 'TimeoutError', category: 'timeout'}
        : sanitizeFailure(outcome.error)
    }
    return makeResult(mode, startedAt, now, {
      status,
      bodyOk,
      loopbackPermission: permissionState,
    }, error)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
