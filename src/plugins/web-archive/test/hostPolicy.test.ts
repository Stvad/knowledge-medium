// @vitest-environment node
/**
 * The filter that decides what may leave the device. Every rejection here is
 * a disclosure that doesn't happen, so these cases are the security boundary
 * of the feature, not incidental coverage.
 */
import { describe, expect, it } from 'vitest'
import {
  archivableUrls,
  decideUrl,
  isPublicHost,
  matchesHostPattern,
  type UrlPolicyOptions,
} from '../hostPolicy.ts'

const OPEN: UrlPolicyOptions = {denylist: [], serviceHosts: []}
const withDenylist = (...denylist: string[]): UrlPolicyOptions =>
  ({denylist, serviceHosts: []})

const reasonFor = (url: string, options: UrlPolicyOptions = OPEN): string | undefined => {
  const decision = decideUrl(url, options)
  return decision.ok ? undefined : decision.reason
}

describe('isPublicHost', () => {
  it.each([
    'example.com',
    'sub.example.com',
    '8.8.8.8',
    'xn--80ak6aa92e.com',
  ])('accepts %s', host => {
    expect(isPublicHost(host)).toBe(true)
  })

  it.each([
    ['localhost', 'the loopback name'],
    ['nas', 'a single-label search-domain name'],
    ['printer.local', 'mDNS'],
    ['app.localhost', 'RFC 2606 reserved'],
    ['db.internal', 'the private-cloud suffix'],
    ['router.home.arpa', 'home networks'],
    ['thing.test', 'RFC 2606 reserved'],
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'RFC1918'],
    ['172.16.0.1', 'RFC1918 lower bound'],
    ['172.31.255.254', 'RFC1918 upper bound'],
    ['192.168.1.1', 'RFC1918'],
    ['169.254.10.1', 'link-local'],
    ['100.64.0.1', 'CGNAT'],
    ['0.0.0.0', 'this-network'],
    ['239.1.1.1', 'multicast'],
    ['[::1]', 'IPv6 loopback'],
    ['[fd00::1]', 'IPv6 unique-local'],
    ['[fe80::1]', 'IPv6 link-local'],
    ['[::ffff:192.168.0.5]', 'an IPv4 private address wearing an IPv6 hat'],
  ])('rejects %s (%s)', host => {
    expect(isPublicHost(host)).toBe(false)
  })

  it('does not mistake a routable 172.x for RFC1918', () => {
    expect(isPublicHost('172.15.0.1')).toBe(true)
    expect(isPublicHost('172.32.0.1')).toBe(true)
  })
})

describe('matchesHostPattern', () => {
  it('matches the host itself and its subdomains', () => {
    expect(matchesHostPattern('example.com', 'example.com')).toBe(true)
    expect(matchesHostPattern('www.example.com', 'example.com')).toBe(true)
  })

  it('does not match a host that merely ends with the pattern text', () => {
    expect(matchesHostPattern('notexample.com', 'example.com')).toBe(false)
    expect(matchesHostPattern('example.com.evil.test', 'example.com')).toBe(false)
  })

  it('honours a leading *. as subdomains-only', () => {
    expect(matchesHostPattern('www.example.com', '*.example.com')).toBe(true)
    expect(matchesHostPattern('example.com', '*.example.com')).toBe(false)
  })

  it('is case- and trailing-dot-insensitive', () => {
    expect(matchesHostPattern('WWW.Example.COM.', 'example.com')).toBe(true)
  })

  it('never matches on an empty pattern', () => {
    expect(matchesHostPattern('example.com', '')).toBe(false)
    expect(matchesHostPattern('example.com', '   ')).toBe(false)
  })
})

describe('decideUrl', () => {
  it('accepts a plain public https URL and returns it normalized', () => {
    const decision = decideUrl('https://EXAMPLE.com:443/a/b?q=1#frag', OPEN)
    expect(decision).toEqual({ok: true, url: 'https://example.com/a/b?q=1#frag'})
  })

  it.each([
    ['not-a-url', 'unparseable'],
    ['[[alias]]', 'unparseable'],
    ['/relative/path', 'unparseable'],
    ['ftp://example.com/f', 'non-http'],
    ['javascript:alert(1)', 'non-http'],
    ['file:///etc/passwd', 'non-http'],
    ['http://localhost:5173/app', 'non-public-host'],
    ['http://192.168.1.9/admin', 'non-public-host'],
    ['https://user:pw@example.com/x', 'credentials-in-url'],
  ])('rejects %s as %s', (url, reason) => {
    expect(reasonFor(url)).toBe(reason)
  })

  it('rejects URLs whose query carries something token-shaped', () => {
    expect(reasonFor('https://example.com/x?access_token=abc')).toBe('sensitive-query')
    expect(reasonFor('https://example.com/x?API_KEY=abc')).toBe('sensitive-query')
    expect(reasonFor('https://example.com/x?a=1&signature=zz')).toBe('sensitive-query')
  })

  it('rejects an implicit-flow token hiding in the fragment', () => {
    expect(reasonFor('https://example.com/cb#access_token=abc&state=1'))
      .toBe('sensitive-query')
  })

  it('leaves an innocuous query alone', () => {
    expect(reasonFor('https://example.com/search?q=wombat&page=2')).toBeUndefined()
  })

  it('applies the user denylist, subdomains included', () => {
    expect(reasonFor('https://mail.example.com/x', withDenylist('example.com')))
      .toBe('denylisted')
    expect(reasonFor('https://elsewhere.org/x', withDenylist('example.com')))
      .toBeUndefined()
  })

  // Loop guard: a record we write contains the archive URL, and that record's
  // content is scanned like any other block.
  it('refuses the archive service its own links back', () => {
    const options = {denylist: [], serviceHosts: ['web.archive.org', 'archive.org']}
    expect(reasonFor('https://web.archive.org/web/2026/https://example.com', options))
      .toBe('archive-service-host')
  })
})

describe('archivableUrls', () => {
  it('keeps the survivors in order, deduped on their normalized form', () => {
    const targets = [
      'https://example.com/a',
      'http://localhost/skip',
      'https://EXAMPLE.com/a',
      'https://example.com/b',
      'nonsense',
    ]
    expect(archivableUrls(targets, OPEN)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ])
  })

  it('returns nothing when everything is filtered', () => {
    expect(archivableUrls(['http://10.0.0.1/x', 'mailto:a@b.test'], OPEN)).toEqual([])
  })
})
