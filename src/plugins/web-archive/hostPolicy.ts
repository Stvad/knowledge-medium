/**
 * Which URLs may be published to a third-party archive.
 *
 * Default-deny: a URL is submitted only if it clears every rule below. The
 * cost of a false negative is a link that doesn't get archived; the cost of a
 * false positive is telling a public service that this user reached a machine
 * on their LAN, or handing it a bearer token out of a query string. Those are
 * not symmetric, so the rules err hard toward not sending.
 *
 * Every rejection carries a machine-readable `reason` so the settings UI can
 * explain the rules instead of the user guessing why a link was ignored.
 */

export type SkipReason =
  | 'unparseable'
  | 'non-http'
  | 'credentials-in-url'
  | 'non-public-host'
  | 'archive-service-host'
  | 'denylisted'
  | 'sensitive-query'

export type UrlDecision =
  | {readonly ok: true; readonly url: string}
  | {readonly ok: false; readonly reason: SkipReason}

export const SKIP_REASON_LABELS: Readonly<Record<SkipReason, string>> = {
  'unparseable': 'not a valid absolute URL',
  'non-http': 'not http(s)',
  'credentials-in-url': 'embeds a username or password',
  'non-public-host': 'host is local, private, or not publicly resolvable',
  'archive-service-host': 'already an archive link',
  'denylisted': 'matches your denylist',
  'sensitive-query': 'query string looks like it carries a token or key',
}

/** Reserved / non-public suffixes. `.local` and `.home.arpa` are mDNS and
 *  home-network names; `.test`/`.invalid`/`.example`/`.localhost` are RFC 2606
 *  reserved; `.internal` is the de-facto private-cloud suffix. */
const PRIVATE_SUFFIXES = [
  '.local',
  '.localhost',
  '.internal',
  '.home.arpa',
  '.test',
  '.invalid',
  '.example',
] as const

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** Query/fragment keys that routinely carry a secret. Sending one to an
 *  archive both leaks it and makes it permanently public. */
const SENSITIVE_PARAM_KEYS = [
  'access_token',
  'api_key',
  'apikey',
  'auth',
  'auth_token',
  'code',
  'id_token',
  'key',
  'password',
  'pwd',
  'refresh_token',
  'secret',
  'session',
  'sig',
  'signature',
  'token',
] as const

const isPrivateIpv4 = (host: string): boolean => {
  const match = IPV4.exec(host)
  if (!match) return false
  const parts = match.slice(1, 5).map(Number)
  if (parts.some(part => Number.isNaN(part) || part > 255)) return true // malformed → don't send
  const [a, b] = parts as [number, number, number, number]
  if (a === 0 || a === 127) return true                 // this-network, loopback
  if (a === 10) return true                             // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true      // RFC1918
  if (a === 192 && b === 168) return true               // RFC1918
  if (a === 169 && b === 254) return true               // link-local
  if (a === 100 && b >= 64 && b <= 127) return true     // CGNAT
  if (a >= 224) return true                             // multicast + reserved
  return false
}

/** `URL` keeps IPv6 literals in brackets; strip them before classifying. */
const isPrivateIpv6 = (host: string): boolean => {
  if (!host.startsWith('[') || !host.endsWith(']')) return false
  const inner = host.slice(1, -1).toLowerCase()
  if (inner === '::1' || inner === '::') return true
  // Unique-local fc00::/7 and link-local fe80::/10.
  if (/^f[cd][0-9a-f]{0,2}:/.test(inner)) return true
  if (/^fe[89ab][0-9a-f]?:/.test(inner)) return true
  // ::ffff:10.0.0.1 and friends — an IPv4 address wearing an IPv6 hat.
  const mapped = /^::ffff:([\d.]+)$/.exec(inner)
  if (mapped?.[1]) return isPrivateIpv4(mapped[1])
  return false
}

/** A publicly-resolvable name: has a dot (a bare `intranet` is a search-domain
 *  name, never public), isn't a reserved suffix, isn't a private IP literal. */
export const isPublicHost = (host: string): boolean => {
  const lower = host.toLowerCase()
  if (!lower) return false
  if (lower === 'localhost') return false
  if (isPrivateIpv6(lower)) return false
  if (isPrivateIpv4(lower)) return false
  if (PRIVATE_SUFFIXES.some(suffix => lower.endsWith(suffix))) return false
  // No dot → single-label host resolved through a local search domain.
  // (IPv4 literals were already classified above, so this can't reject one.)
  if (!lower.includes('.')) return false
  return true
}

/** `pattern` matches `host` itself and any subdomain of it. A leading `*.`
 *  narrows it to subdomains only, so `*.example.com` leaves `example.com`
 *  archivable. */
export const matchesHostPattern = (host: string, pattern: string): boolean => {
  const h = host.toLowerCase().replace(/\.$/, '')
  const raw = pattern.trim().toLowerCase().replace(/\.$/, '')
  if (!raw) return false
  if (raw.startsWith('*.')) {
    const base = raw.slice(2)
    return Boolean(base) && h.endsWith(`.${base}`)
  }
  return h === raw || h.endsWith(`.${raw}`)
}

const hasSensitiveParams = (url: URL): boolean => {
  const keys = [...url.searchParams.keys()]
  // Fragments carry OAuth implicit-flow tokens; parse them the same way.
  const fragment = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash
  if (fragment.includes('=')) {
    keys.push(...new URLSearchParams(fragment).keys())
  }
  return keys.some(key =>
    (SENSITIVE_PARAM_KEYS as readonly string[]).includes(key.toLowerCase()),
  )
}

export interface UrlPolicyOptions {
  readonly denylist: readonly string[]
  /** Hosts belonging to the archive service itself. Submitting an archive
   *  link back to the archive is both pointless and a feedback loop: the
   *  record we write contains the archive URL, and that record's content is
   *  scanned like any other block. */
  readonly serviceHosts: readonly string[]
}

/**
 * Decide whether one link target may be submitted, returning the normalized
 * URL to submit (host lowercased, default port dropped) so two spellings of
 * the same page dedupe against each other.
 */
export const decideUrl = (raw: string, options: UrlPolicyOptions): UrlDecision => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return {ok: false, reason: 'unparseable'}
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {ok: false, reason: 'non-http'}
  }
  if (url.username || url.password) {
    return {ok: false, reason: 'credentials-in-url'}
  }
  if (!isPublicHost(url.hostname)) {
    return {ok: false, reason: 'non-public-host'}
  }
  if (options.serviceHosts.some(host => matchesHostPattern(url.hostname, host))) {
    return {ok: false, reason: 'archive-service-host'}
  }
  if (options.denylist.some(pattern => matchesHostPattern(url.hostname, pattern))) {
    return {ok: false, reason: 'denylisted'}
  }
  if (hasSensitiveParams(url)) {
    return {ok: false, reason: 'sensitive-query'}
  }

  return {ok: true, url: url.toString()}
}

/** Archivable URLs from a list of raw link targets, deduped by their
 *  normalized form and in document order. */
export const archivableUrls = (
  targets: readonly string[],
  options: UrlPolicyOptions,
): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const target of targets) {
    const decision = decideUrl(target, options)
    if (!decision.ok || seen.has(decision.url)) continue
    seen.add(decision.url)
    out.push(decision.url)
  }
  return out
}
