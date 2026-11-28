import {afterEach, describe, expect, it, vi} from 'vitest'
import {freezeExtensionImport, pinExtensionImports, verifyFrozenExtensionImport} from '../src/freezeExtensionImports.js'

const url = 'https://cdn.example/module.mjs'
const code = 'export const answer = 42;'
const integrity = 'sha256-jd1WpEeAUqrJNqnTHW7xZe45aMOUFW1usoVkOMI8uPE='

afterEach(() => vi.unstubAllGlobals())

function stubFetch(handler: (requestUrl: URL, options: RequestInit) => Response | Promise<Response>) {
  const fetch = vi.fn(async (requestUrl: URL, options: RequestInit) => handler(requestUrl, options))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('HTTPS extension freezer', () => {
  it('hashes raw module bytes and fetches with no credentials or referrer', async () => {
    const fetch = stubFetch(() => new Response(code))
    const frozen = await freezeExtensionImport(url, integrity)
    expect(frozen.integrity).toBe(integrity)
    expect(frozen.bytes).toEqual(new TextEncoder().encode(code))
    expect(fetch).toHaveBeenCalledWith(new URL(url), expect.objectContaining({
      credentials: 'omit', redirect: 'manual', referrerPolicy: 'no-referrer',
    }))
  })

  it.each(['http://cdn.example/module.mjs', 'https://user@cdn.example/module.mjs',
    'https://:password@cdn.example/module.mjs'])('refuses %s before fetching', async specifier => {
    const fetch = stubFetch(() => new Response(code))
    await expect(freezeExtensionImport(specifier)).rejects.toThrow('must use HTTPS without credentials')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses invalid pins before fetching', async () => {
    const fetch = stubFetch(() => new Response(code))
    await expect(freezeExtensionImport(url, 'sha384-abc')).rejects.toThrow('Invalid SHA-256 integrity')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses a response whose bytes differ from the pin', async () => {
    stubFetch(() => new Response('invalid JS {}'))
    await expect(freezeExtensionImport(url, integrity)).rejects.toThrow('SHA-256 integrity mismatch')
  })

  it('refuses redirects and names the canonical URL without fetching it', async () => {
    const fetch = stubFetch(() => new Response(null, {status: 302, headers: {location: '/canonical.mjs'}}))
    await expect(freezeExtensionImport(url)).rejects.toThrow('https://cdn.example/canonical.mjs')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('refuses an opaque browser redirect without asserting its destination', async () => {
    const response = new Response(null)
    Object.defineProperty(response, 'type', {value: 'opaqueredirect'})
    stubFetch(() => response)
    await expect(freezeExtensionImport(url)).rejects.toThrow('Pin the canonical HTTPS module URL directly')
  })

  it('refuses a response already redirected by the fetch implementation', async () => {
    const response = new Response(code)
    Object.defineProperty(response, 'redirected', {value: true})
    stubFetch(() => response)
    await expect(freezeExtensionImport(url)).rejects.toThrow('redirected')
  })

  it('reports an HTTP error without parsing its body', async () => {
    stubFetch(() => new Response('<html>', {status: 404}))
    await expect(freezeExtensionImport(url)).rejects.toThrow('HTTP 404')
  })

  it('refuses a successful response with no module body', async () => {
    stubFetch(() => new Response(null, {status: 204}))
    await expect(freezeExtensionImport(url)).rejects.toThrow('HTTP 204')
  })

  it('verifies a private copy of previously fetched bytes', async () => {
    const callerBytes = Buffer.from(code)
    const result = verifyFrozenExtensionImport(url, callerBytes, integrity)
    callerBytes.fill(0)
    expect((await result).bytes).toEqual(new TextEncoder().encode(code))
  })

  it('refuses oversized pre-fetched bytes', async () => {
    await expect(verifyFrozenExtensionImport(url, new Uint8Array(5 * 1024 * 1024 + 1), integrity))
      .rejects.toThrow('byte module limit')
  })

  it('refuses oversized streamed bodies without a content-length header', async () => {
    stubFetch(() => new Response(new Uint8Array(5 * 1024 * 1024 + 1)))
    await expect(freezeExtensionImport(url)).rejects.toThrow('byte module limit')
  })

  it('sets a deadline for the body as well as the headers', async () => {
    const fetch = stubFetch((_url, {signal}) => new Response(new ReadableStream({
      start(controller) {
        signal?.addEventListener('abort', () => controller.error(signal.reason))
      },
    })))
    const deadline = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    try {
      const result = freezeExtensionImport(url)
      expect(fetch.mock.calls[0][1].signal).toBe(deadline.signal)
      deadline.abort(new Error('timed out'))
      await expect(result).rejects.toThrow('timed out')
      expect(timeout).toHaveBeenCalledWith(15_000)
    } finally {
      timeout.mockRestore()
    }
  })

  it.each([
    ['static imports', 'import "./dependency.mjs";'],
    ['named re-exports', 'export {default} from "./dependency.mjs";'],
    ['star re-exports', 'export * from "./dependency.mjs";'],
    ['dynamic imports', 'export const load = () => import("./dependency.mjs");'],
  ])('refuses %s in downloaded code', async (_label, moduleCode) => {
    stubFetch(() => new Response(moduleCode))
    await expect(freezeExtensionImport(url)).rejects.toThrow('is not self-contained')
  })

  it('allows import.meta.url in a vendored module', async () => {
    stubFetch(() => new Response('export const url = import.meta.url;'))
    await expect(freezeExtensionImport(url)).resolves.toMatchObject({url})
  })

  it('refuses other import.meta properties in a vendored module', async () => {
    stubFetch(() => new Response('export const resolve = import.meta.resolve;'))
    await expect(freezeExtensionImport(url)).rejects.toThrow('import.meta.url')
  })
})

describe('pinning extension source', () => {
  const packageUrl = 'https://esm.sh/fake-package@1.2.3?bundle'
  const canonicalPath = '/fake-package@1.2.3/es2024/fake-package.bundle.mjs'
  const canonical = `https://esm.sh${canonicalPath}`

  it('pins the canonical module and preserves source outside the import literals', async () => {
    const fetch = stubFetch(requestUrl => new Response(requestUrl.href === canonical ? code :
      `/* esm.sh */\nexport * from "${canonicalPath}";`))
    const source = `// Keep ${packageUrl}\r\nimport /* bound */ * as sdk from '${packageUrl}'; // keep\r\nexport * from "${packageUrl}"\r\nexport const view = <span>{sdk.answer}</span>`
    const pinned = await pinExtensionImports(source)
    expect(pinned.source).toBe(`// Keep ${packageUrl}\r\nimport /* bound */ * as sdk from '${canonical}' with {integrity: '${integrity}'}; // keep\r\nexport * from "${canonical}" with {integrity: '${integrity}'}\r\nexport const view = <span>{sdk.answer}</span>`)
    expect(Object.keys(pinned.vendored)).toEqual([integrity])
    expect(fetch.mock.calls.map(([requestUrl]) => requestUrl.href)).toEqual([
      `${packageUrl}&target=es2024`, canonical,
    ])
  })

  it('refuses two different digests for the same canonical URL before returning edited source', async () => {
    let canonicalReads = 0
    stubFetch(request => {
      if (request.href !== canonical) return new Response(`export * from '${canonicalPath}'`)
      return new Response(++canonicalReads === 1 ? code + '\n' : code)
    })
    const source = `import '${packageUrl}'; import '${canonical}' with {integrity: '${integrity}'}`
    await expect(pinExtensionImports(source)).rejects.toThrow('Conflicting integrity values')
  })

  it('leaves existing pins and type-only imports intact', async () => {
    const fetch = stubFetch(() => new Response(code))
    const source = `import 'react'\nimport type {T} from '${packageUrl}'\nimport '${url}' with /* keep */ {'integrity': '${integrity}'}`
    const result = await pinExtensionImports(source)
    expect(result.source).toBe(source)
    expect(Object.keys(result.vendored)).toEqual([integrity])
    expect(fetch.mock.calls.map(([requestUrl]) => requestUrl.href)).toEqual([url])
  })

  it('refuses a forwarding stub when the exact URL is already pinned', async () => {
    stubFetch(() => new Response(`export * from '${canonicalPath}'`))
    await expect(freezeExtensionImport(packageUrl)).rejects.toThrow(canonical)
  })

  it('refuses a multi-module closure without fetching its dependencies', async () => {
    const fetch = stubFetch(() => new Response(`import '/peer.mjs'; export * from '${canonicalPath}'`))
    await expect(pinExtensionImports(`import '${packageUrl}'`)).rejects.toThrow('is not self-contained')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('suggests ?bundle for an esm.sh entry with a preload import', async () => {
    stubFetch(() => new Response(`import '/react@19/es2024/react.mjs'; export * from '${canonicalPath}';`))
    await expect(freezeExtensionImport('https://esm.sh/react-dom/client')).rejects.toThrow('with ?bundle')
  })

  it.each([
    ['an already bundled esm.sh entry', packageUrl],
    ['a direct esm.sh module', canonical],
    ['an entry on another CDN', 'https://cdn.example/entry'],
  ])('does not suggest ?bundle for %s', async (_label, entry) => {
    stubFetch(() => new Response(`import '/peer.mjs'; export * from '${canonicalPath}';`))
    await expect(freezeExtensionImport(entry)).rejects.toThrow(/^.* is not self-contained\.$/)
  })

  it('follows a canonical esm.sh stub that also forwards the default export', async () => {
    const fetch = stubFetch(requestUrl => new Response(requestUrl.href === canonical ? 'export default 42;' :
      `export * from '${canonicalPath}'; export {default} from '${canonicalPath}';`))
    await expect(pinExtensionImports(`import value from '${packageUrl}'`)).resolves.toMatchObject({
      source: expect.stringContaining(`'${canonical}' with`),
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('recognizes a default exported through a named export list', async () => {
    stubFetch(requestUrl => new Response(requestUrl.href === canonical ? `const value = 42; export {value as 'default'};` :
      `export * from '${canonicalPath}'; export {default} from '${canonicalPath}';`))
    await expect(pinExtensionImports(`import value from '${packageUrl}'`)).resolves.toMatchObject({
      source: expect.stringContaining(`'${canonical}' with`),
    })
  })

  it.each([
    ['would expose a new default export', false, 'export default 42;'],
    ['would drop a required default export', true, code],
  ])('refuses an esm.sh rewrite that %s', async (_label, forwardsDefault, targetCode) => {
    stubFetch(requestUrl => {
      if (requestUrl.href === canonical) return new Response(targetCode)
      const star = `export * from '${canonicalPath}';`
      const defaultExport = forwardsDefault ? ` export {default} from '${canonicalPath}';` : ''
      return new Response(star + defaultExport)
    })
    await expect(pinExtensionImports(`import * as sdk from '${packageUrl}'`))
      .rejects.toThrow('would change whether it exports default')
  })

  it('refuses a stub that aliases an export', async () => {
    const fetch = stubFetch(() => new Response(`export * from '${canonicalPath}'; export {default as value} from '${canonicalPath}';`))
    await expect(pinExtensionImports(`import '${packageUrl}'`)).rejects.toThrow('is not self-contained')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('refuses an esm.sh stub pointing at another origin', async () => {
    const fetch = stubFetch(() => new Response(`export * from '//another.example/entry.mjs';`))
    await expect(pinExtensionImports(`import '${packageUrl}'`)).rejects.toThrow('is not self-contained')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['an entry directive', `'use client'; export * from '${canonicalPath}';`],
    ['extra entry code', `export * from '${canonicalPath}'; export {default} from '${canonicalPath}'; console.log('entry');`],
    ['a named-only entry', `export {answer} from '${canonicalPath}';`],
    ['attributes on the star export', `export * from '${canonicalPath}' with {mode: 'raw'};`],
    ['attributes on the default export', `export * from '${canonicalPath}'; export {default} from '${canonicalPath}' with {type: 'json'};`],
    ['distinct export targets', `export * from '${canonicalPath}'; export {default} from '/another.mjs';`],
    ['additional named export specifiers', `export * from '${canonicalPath}'; export {default, extra} from '${canonicalPath}';`],
    ['a namespace instead of the default', `export * from '${canonicalPath}'; export * as default from '${canonicalPath}';`],
    ['a different binding as the default', `export * from '${canonicalPath}'; export {answer as default} from '${canonicalPath}';`],
    ['a target username', `export * from '//user@esm.sh${canonicalPath}';`],
    ['a target password', `export * from '//:password@esm.sh${canonicalPath}';`],
    ['a bare module specifier', "export * from 'some-package';"],
  ])('refuses to rewrite an esm.sh stub with %s', async (_label, entry) => {
    const fetch = stubFetch(() => new Response(entry))
    await expect(pinExtensionImports(`import '${packageUrl}'`)).rejects.toThrow('is not self-contained')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not suggest the same URL as the canonical replacement for a self-forwarding stub', async () => {
    stubFetch(() => new Response(`export * from '${canonicalPath}';`))
    await expect(freezeExtensionImport(canonical)).rejects.toThrow(/^.* is not self-contained\.$/)
  })

  it('names and pins a relative self-contained target on another CDN', async () => {
    const entry = 'https://cdn.example/entry'
    const target = new URL('./implementation.js', entry).href
    stubFetch(request => new Response(request.href === entry ? "export * from './implementation.js'" : code))
    await expect(freezeExtensionImport(entry)).rejects.toThrow(target)
    expect((await pinExtensionImports(`import '${entry}'`)).source).toBe(`import '${target}' with {integrity: '${integrity}'}`)
  })

  it('refuses a second-hop stub before comparing its default export', async () => {
    stubFetch(requestUrl => new Response(requestUrl.href === canonical ?
      `export * from '/other.mjs'; export default 42;` : `export * from '${canonicalPath}';`))
    await expect(pinExtensionImports(`import '${packageUrl}'`)).rejects.toThrow('is not self-contained')
  })

  it.each([`${packageUrl}&target=es2022`, canonical])('keeps a direct esm.sh bundle or an explicit target unchanged (%s)', async entry => {
    const source = `import {answer} from '${entry}';`
    const fetch = stubFetch(() => new Response(code))
    await expect(pinExtensionImports(source)).resolves.toMatchObject({
      source: source.replace(';', ` with {integrity: '${integrity}'};`),
    })
    expect(fetch.mock.calls.map(([requestUrl]) => requestUrl.href)).toEqual([entry])
  })

  it('refuses literal dynamic HTTPS imports before fetching', async () => {
    const fetch = stubFetch(() => new Response(code))
    await expect(pinExtensionImports(`export const load = () => import('${url}');`))
      .rejects.toThrow('Use a static import')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('ignores dynamic imports already resolved through the app import map', async () => {
    const fetch = stubFetch(() => new Response(code))
    const source = `export const load = () => import('react');`
    await expect(pinExtensionImports(source)).resolves.toMatchObject({source, rewrittenImports: []})
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rewrites static imports and preserves dynamic HTTPS imports in mixed source', async () => {
    const fetch = stubFetch(() => new Response(code))
    const staticImport = `import '${url}';`
    const dynamicImport = `export const load = () => import('https://cdn.example/lazy.mjs');`
    const rewritten = `import '${url}' with {integrity: '${integrity}'};`
    await expect(pinExtensionImports(`${staticImport}\n${dynamicImport}`)).resolves.toMatchObject({
      source: `${rewritten}\n${dynamicImport}`,
      rewrittenImports: [rewritten],
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('fills an empty attribute list without rewriting adjacent comments', async () => {
    stubFetch(() => new Response(code))
    const source = `import '${url}' /* keep */ with /* brace { */ { /* keep */ };`
    await expect(pinExtensionImports(source)).resolves.toMatchObject({
      source: source.replace('{ /* keep */ }', `{integrity: '${integrity}' /* keep */ }`),
    })
  })

  it('preserves an escaped URL literal when it already names the canonical module', async () => {
    stubFetch(() => new Response(code))
    const source = String.raw`import 'https://cdn.example/\u006dodule.mjs'`
    await expect(pinExtensionImports(source)).resolves.toMatchObject({
      source: `${source} with {integrity: '${integrity}'}`,
    })
  })
})
