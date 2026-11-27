import {once} from 'node:events'
import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'
import {expect, it, vi} from 'vitest'
import {freezeExtensionImport, pinExtensionImports} from '../src/freezeExtensionImports.js'

it('pins streamed module bytes from a local CDN fixture and leaves redirects unfollowed', async () => {
  const origin = 'https://esm.sh'
  const stub = '/example@1.0.0?bundle'
  const canonical = '/example@1.0.0/es2024/example.bundle.mjs'
  const redirect = '/redirect.mjs'
  const integrity = 'sha256-jd1WpEeAUqrJNqnTHW7xZe45aMOUFW1usoVkOMI8uPE='
  const requests: {path: string, cookie: string | undefined, referer: string | undefined}[] = []
  const server = createServer((request, response) => {
    const path = request.url ?? '/'
    requests.push({path, cookie: request.headers.cookie, referer: request.headers.referer})
    switch (path) {
      case `${stub}&target=es2024`:
        response.writeHead(200, {'content-type': 'text/javascript'})
        response.end(`export * from '${canonical}';`)
        break
      case canonical:
        response.writeHead(200, {'content-type': 'text/javascript'})
        response.write('export const ')
        response.end('answer = 42;')
        break
      case redirect:
        response.writeHead(302, {location: canonical})
        response.end()
        break
      default:
        response.writeHead(404)
        response.end()
    }
  })
  try {
    await once(server.listen(0, '127.0.0.1'), 'listening')
    const {port} = server.address() as AddressInfo
    const nativeFetch = globalThis.fetch
    // The freezer sees its normal HTTPS URL. Only the test transport routes it to loopback.
    const fixtureFetch = vi.fn((url: URL, init: RequestInit) => {
      if (url.origin !== origin) throw new Error(`Unexpected fixture origin ${url.origin}`)
      return nativeFetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init)
    })
    vi.stubGlobal('fetch', fixtureFetch)
    const source = `import {answer} from '${origin}${stub}';`
    const result = await pinExtensionImports(source)
    expect(result.source).toBe(`import {answer} from '${origin}${canonical}' with {integrity: '${integrity}'};`)
    expect(result.vendored[integrity]).toEqual(new TextEncoder().encode('export const answer = 42;'))
    await expect(freezeExtensionImport(`${origin}${redirect}`)).rejects.toThrow(`${origin}${canonical}`)
    expect(requests).toEqual([`${stub}&target=es2024`, canonical, redirect].map(path => ({
      path, cookie: undefined, referer: undefined,
    })))
    for (const [, options] of fixtureFetch.mock.calls) {
      expect(options).toMatchObject({credentials: 'omit', redirect: 'manual', referrerPolicy: 'no-referrer'})
    }
  } finally {
    vi.unstubAllGlobals()
    if (server.listening) {
      const closed = once(server, 'close')
      server.close()
      server.closeAllConnections()
      await closed
    }
  }
})
