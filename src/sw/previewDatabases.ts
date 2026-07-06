export const SERVICE_WORKER_META_CACHE = 'km-meta'
export const PREVIEW_DATABASE_RECORD_BASENAME = '__km_database__'
export const PREVIEW_SCOPE_LIVENESS_BASENAME = '__km_scope_liveness__'

const normalizeUrl = (url: string | URL): string => new URL(url.toString()).toString()

export const previewIdFromBasePath = (base: string): string | null => {
  const match = base.match(/\/pr-preview\/(pr-[^/]+)\//)
  return match ? match[1] : null
}

export const previewScopeLockName = (scopeUrl: string | URL): string =>
  `km-preview-scope:${normalizeUrl(scopeUrl)}`

export const previewLedgerLockName = (ledgerUrl: string | URL): string =>
  `km-preview-ledger:${normalizeUrl(ledgerUrl)}`

export const previewDatabaseRecordUrl = (
  scopeUrl: string | URL,
  databaseName: string,
): string =>
  new URL(
    `./${PREVIEW_DATABASE_RECORD_BASENAME}/${encodeURIComponent(databaseName)}`,
    scopeUrl,
  ).toString()

export const previewScopeLivenessUrl = (scopeUrl: string | URL): string =>
  new URL(`./${PREVIEW_SCOPE_LIVENESS_BASENAME}`, scopeUrl).toString()

export const previewDatabaseRecordInfo = (
  recordUrl: string,
  ledgerBasename: string,
): {scopeUrl: string; name: string; scopeBaseUrl: string} | null => {
  try {
    const url = new URL(recordUrl)
    const marker = `/${PREVIEW_DATABASE_RECORD_BASENAME}/`
    const markerIndex = url.pathname.indexOf(marker)
    if (markerIndex < 0) return null

    const encodedName = url.pathname.slice(markerIndex + marker.length)
    if (!encodedName || encodedName.includes('/')) return null

    const scopePath = url.pathname.slice(0, markerIndex + 1)
    const scopeBaseUrl = `${url.origin}${scopePath}`
    return {
      scopeUrl: `${scopeBaseUrl}${ledgerBasename}`,
      scopeBaseUrl,
      name: decodeURIComponent(encodedName),
    }
  } catch {
    return null
  }
}

export const previewScopeLivenessInfo = (
  recordUrl: string,
  ledgerBasename: string,
): {scopeUrl: string; scopeBaseUrl: string} | null => {
  try {
    const url = new URL(recordUrl)
    if (!url.pathname.endsWith(`/${PREVIEW_SCOPE_LIVENESS_BASENAME}`)) return null

    const scopePath = url.pathname.slice(0, -PREVIEW_SCOPE_LIVENESS_BASENAME.length)
    const scopeBaseUrl = `${url.origin}${scopePath}`
    return {
      scopeUrl: `${scopeBaseUrl}${ledgerBasename}`,
      scopeBaseUrl,
    }
  } catch {
    return null
  }
}

const heldPreviewScopeLeases = new Map<string, Promise<() => void>>()

export const acquirePreviewScopeLease = async (
  scopeUrl: URL,
): Promise<{releaseOnFailure: () => void}> => {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks?.request) return {releaseOnFailure: () => {}}

  const scopeKey = scopeUrl.toString()
  const existing = heldPreviewScopeLeases.get(scopeKey)
  if (existing) {
    await existing
    return {releaseOnFailure: () => {}}
  }

  const lease = new Promise<() => void>((resolve, reject) => {
    let release = () => {}
    const released = new Promise<void>((releaseLock) => {
      release = () => {
        heldPreviewScopeLeases.delete(scopeKey)
        releaseLock()
      }
    })
    const request = locks.request(
      previewScopeLockName(scopeUrl),
      {mode: 'shared'},
      async () => {
        resolve(release)
        await released
      },
    )
    request.catch((err: unknown) => {
      heldPreviewScopeLeases.delete(scopeKey)
      reject(err)
    })
  })
  heldPreviewScopeLeases.set(scopeKey, lease)
  return {releaseOnFailure: await lease}
}

export const recordPreviewScopeLiveness = async (scopeUrl: URL): Promise<void> => {
  if (typeof caches === 'undefined') return
  const cache = await caches.open(SERVICE_WORKER_META_CACHE)
  await cache.put(
    previewScopeLivenessUrl(scopeUrl),
    new Response(JSON.stringify({updatedAt: Date.now()}), {
      headers: {'content-type': 'application/json'},
    }),
  )
}

export const startCurrentPreviewScopeLease = async (
  base: string,
  href: string,
): Promise<void> => {
  if (!previewIdFromBasePath(base)) return
  const scopeUrl = new URL(base, href)
  await recordPreviewScopeLiveness(scopeUrl)
  await acquirePreviewScopeLease(scopeUrl)
}
