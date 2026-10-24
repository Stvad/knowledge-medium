import type {Plugin} from 'vite'

type ImportMap = {
  imports?: Record<string, string>
  integrity?: Record<string, string>
  [key: string]: unknown
}

export const REACT_ESM_VERSION = '19.3.1'

const REACT_ESM_BASE = `https://esm.sh/react@${REACT_ESM_VERSION}`
const REACT_DOM_ESM_BASE = `https://esm.sh/react-dom@${REACT_ESM_VERSION}`
const SCHEDULER_ESM_ENTRY = 'https://esm.sh/scheduler@%5E0.28.0?target=es2022'

const productionReactImports = {
  react: REACT_ESM_BASE,
  'react/': `${REACT_ESM_BASE}/`,
  'react-dom': REACT_DOM_ESM_BASE,
  'react-dom/': `${REACT_DOM_ESM_BASE}/`,
}

export const productionReactIntegrity = {
  [REACT_ESM_BASE]: 'sha384-ut1U+oIs0ClaOE7uF1+DZAaHVvYvEJZME3mUuqn95yVqQ70a+8u2LN2LD37JgJkO',
  [`${REACT_ESM_BASE}/compiler-runtime`]: 'sha384-OwMucnCwvSvEvLGQZRYvzXLqTO62Tpxtr44jwVXcNCIDc1dxedT3i+c3K6gbTH0T',
  [`${REACT_ESM_BASE}/jsx-runtime`]: 'sha384-WuUlFXf93SyYfvc/sync3BdSKZvd7a21DD7d8nz9SZcsw9d8SgBxha4mBOzb/ITP',
  [`${REACT_ESM_BASE}/es2022/compiler-runtime.mjs`]: 'sha384-7EAuIpifon0qC3yWooyL7sHUAW0NPw2qPgdNk3N9aYJspAtpRGsM0fmc6epWRm5I',
  [`${REACT_ESM_BASE}/es2022/jsx-runtime.mjs`]: 'sha384-gh8xw1wmcir9SHUqXziDr2z4Oz0Kyy0SrQ8ZhX/0UyjVAHiQnKjEs0ePh4PDo5o2',
  [`${REACT_ESM_BASE}/es2022/react.mjs`]: 'sha384-Psq5WJvVF357tIF0zhz8ailHVmWVJLwyWH6vLzhozGkNMdVwvi/q4PAofRwgDYt6',
  [REACT_DOM_ESM_BASE]: 'sha384-FKbbSw/nINZRM0ej/iwjfXbJeAZMJdBKqKmn/I+aIM4Io5qupmM8sZJxaJZDO0sv',
  [`${REACT_DOM_ESM_BASE}/client`]: 'sha384-1lS4GktdgllRF1OQSgYP4ehItzJL2hrWYUJUMcxRA+kL/LOwA1mZvQBYOtlnrXBq',
  [`${REACT_DOM_ESM_BASE}/server`]: 'sha384-7LadG21GTWfntE+DeXejoxQ+k1gypabL0MJIbIkBf7PsSEvzt1NWLn9uGwJkuK/c',
  [`${REACT_DOM_ESM_BASE}/es2022/client.mjs`]: 'sha384-JUXRbhM1IMfjD0bcuXxiI1PtHumQtqdAU20XJc2cfPh4Lg6RYVoCfuDeTd6QFY6R',
  [`${REACT_DOM_ESM_BASE}/es2022/react-dom.mjs`]: 'sha384-uHZRqepbVmDxV8LisyTnW3yCxfF9qg9n2ZP6UU+2B+T5Eu2fYDHfxN+/yXTtURWg',
  [`${REACT_DOM_ESM_BASE}/es2022/server.mjs`]: 'sha384-DIoAILCPCWbSLEk4QFR+/fzTaD65IRF2bnJKA24VR3nZKEB24EDtpX0iuv0AVDAw',
  [`${REACT_DOM_ESM_BASE}/es2022/cjs/react-dom-server-legacy.browser.production.mjs`]: 'sha384-s+uNA0UqWtCt8l6Y9EO05tVt83j6XMxoXFd0QlCRKJuIM6F+Jn/DbUe7CMDn9X7N',
  [`${REACT_DOM_ESM_BASE}/es2022/cjs/react-dom-server.browser.production.mjs`]: 'sha384-QxXIBn1Mhq+M6bPsT8z1a8w8o4FbFB2lGow88kCqrijG8hvHKtRZB8ISjbxu+GA7',
  [SCHEDULER_ESM_ENTRY]: 'sha384-jsXPGE3JN4R3aK6oENd9F0e2R6Uwd+VdljSDtnYZ6Fzl9FHR8ivWA95iPLW+KJd2',
  'https://esm.sh/scheduler@0.28.0/es2022/scheduler.mjs': 'sha384-VTqzDxK+Nfu62ZqrHojPSgKqkcLx9wWONGvOJwFQqD00uvRqQKGsX4stOJmJsauz',
}

const importMapScriptPattern =
  /(<script\b(?=[^>]*\btype=(["'])importmap\2)[^>]*>)([\s\S]*?)(<\/script>)/gi

const isReactImportMap = (importMap: ImportMap): boolean => {
  const imports = importMap.imports ?? {}
  return Object.keys(productionReactImports).some(key =>
    imports[key]?.startsWith('https://esm.sh/react'),
  )
}

const isManagedReactIntegrityUrl = (url: string): boolean =>
  /^https:\/\/esm\.sh\/(?:react@|react-dom@|scheduler@)/.test(url)

const rewriteImportMap = (importMap: ImportMap): ImportMap => {
  if (!isReactImportMap(importMap)) return importMap

  const retainedIntegrity = Object.fromEntries(
    Object.entries(importMap.integrity ?? {}).filter(([url]) => !isManagedReactIntegrityUrl(url)),
  )

  return {
    ...importMap,
    imports: {
      ...importMap.imports,
      ...productionReactImports,
    },
    integrity: {
      ...retainedIntegrity,
      ...productionReactIntegrity,
    },
  }
}

const formatImportMap = (importMap: ImportMap): string =>
  `\n${JSON.stringify(importMap, null, 8).replace(/^/gm, '      ')}\n    `

export function rewriteReactImportMapForProduction(html: string): string {
  return html.replace(importMapScriptPattern, (match, openTag, _quote, body, closeTag) => {
    try {
      const importMap = JSON.parse(body.trim()) as ImportMap
      const rewritten = rewriteImportMap(importMap)
      if (rewritten === importMap) return match
      return `${openTag}${formatImportMap(rewritten)}${closeTag}`
    } catch {
      return match
    }
  })
}

export const reactImportMapProductionPlugin = (): Plugin => ({
  name: 'react-import-map-production',
  apply: 'build',
  transformIndexHtml(html) {
    return rewriteReactImportMapForProduction(html)
  },
})
