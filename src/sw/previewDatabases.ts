export const SERVICE_WORKER_META_CACHE = 'km-meta'
export const PREVIEW_DATABASE_RECORD_BASENAME = '__km_database__'

export const previewIdFromBasePath = (base: string): string | null => {
  const match = base.match(/\/pr-preview\/(pr-[^/]+)\//)
  return match ? match[1] : null
}

export const previewDatabaseRecordUrl = (
  scopeUrl: string | URL,
  databaseName: string,
): string =>
  new URL(
    `./${PREVIEW_DATABASE_RECORD_BASENAME}/${encodeURIComponent(databaseName)}`,
    scopeUrl,
  ).toString()

export const previewDatabaseRecordInfo = (
  recordUrl: string,
  ledgerBasename: string,
): {scopeUrl: string; name: string} | null => {
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
      name: decodeURIComponent(encodedName),
    }
  } catch {
    return null
  }
}
