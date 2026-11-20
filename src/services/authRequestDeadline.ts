/** How long one Supabase Auth request may wait for a response before it is
 *  aborted. auth-js sends its requests with no deadline, and every
 *  `getSession()` awaits the one in-flight token refresh. So a refresh that
 *  never gets a response blocks every caller that needs a token, the upload
 *  pass and PowerSync's `fetchCredentials` included, until the page reloads.
 *  Aborted, the refresh fails as retryable: auth-js keeps the session and
 *  refreshes again once its failure cooldown ends. */
export const AUTH_REQUEST_TIMEOUT_MS = 15_000

const AUTH_PATH = '/auth/v1/'

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

/** Wraps the Supabase client's fetch so Auth requests carry a deadline. Only
 *  Auth: Storage shares this fetch, and an attachment upload may rightly run
 *  far longer. */
export const withAuthRequestDeadline = (
  fetchImpl: typeof fetch,
  timeoutMs: number = AUTH_REQUEST_TIMEOUT_MS,
): typeof fetch => (input, init) => {
  if (!urlOf(input).includes(AUTH_PATH)) return fetchImpl(input, init)
  const deadline = AbortSignal.timeout(timeoutMs)
  const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline
  return fetchImpl(input, {...init, signal})
}
