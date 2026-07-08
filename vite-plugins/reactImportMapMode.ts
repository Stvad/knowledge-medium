import type {Plugin} from 'vite'

type ImportMap = {
  imports?: Record<string, string>
  integrity?: Record<string, string>
  [key: string]: unknown
}

export const REACT_ESM_VERSION = '19.2.6'

const REACT_ESM_BASE = `https://esm.sh/react@${REACT_ESM_VERSION}`
const REACT_DOM_ESM_BASE = `https://esm.sh/react-dom@${REACT_ESM_VERSION}`
const SCHEDULER_ESM_ENTRY = 'https://esm.sh/scheduler@%5E0.27.0?target=es2022'

const productionReactImports = {
  react: REACT_ESM_BASE,
  'react/': `${REACT_ESM_BASE}/`,
  'react-dom': REACT_DOM_ESM_BASE,
  'react-dom/': `${REACT_DOM_ESM_BASE}/`,
}

export const productionReactIntegrity = {
  [REACT_ESM_BASE]: 'sha384-cULQr/uUHnGWJTu+mMitrsp8U68hnawvW+WKOfrKWimkxs2Ro7FPDDOR/AifqLA+',
  [`${REACT_ESM_BASE}/compiler-runtime`]: 'sha384-Fetdv9KLlqvxstqIkJWEGp31fyVT1TqMC7Yig02LJFUADNWT65bc3wqpjsWcKxsW',
  [`${REACT_ESM_BASE}/jsx-runtime`]: 'sha384-2MkM23snzEOobDh9ZvQc4ZiNwV4DZewa8K/YrI5sguhYIKLs36CzQnCtRnm5pnid',
  [`${REACT_ESM_BASE}/es2022/compiler-runtime.mjs`]: 'sha384-740x+PeUUcmx/b3EEI3La2teqx4c2dWSKiEi9CoaWtCjKTX3aBNjpAcn5A/ctQqc',
  [`${REACT_ESM_BASE}/es2022/jsx-runtime.mjs`]: 'sha384-gBQKGl1AHiJKC6Wfs0mwGjZb51AT0m5hy5F6TpgIqj0P6QEVho66PGQzoEiVwJtI',
  [`${REACT_ESM_BASE}/es2022/react.mjs`]: 'sha384-xDJ6u7Y7gVsDGlMDZKWtnIKbcb7FZrux+VIi5cLbyuN06Ae3jhX6+F7CvakLuBZp',
  [REACT_DOM_ESM_BASE]: 'sha384-P0E4fscwP/KjngFh/I4mdUbuvPooaN8nXl9kUohx30r8a/q3HE7erwThGp6+slgE',
  [`${REACT_DOM_ESM_BASE}/client`]: 'sha384-reX2i+i9B0laoaK9sTuz3ad6lLCGvS/hP3fj2eSncdD7g+LGG3t+WZPzh/7mRagc',
  [`${REACT_DOM_ESM_BASE}/server`]: 'sha384-tTy7T4lm9zbn4WLf9sNOE68LSnJDnyqgfNVqZpMKQubeVEmzruL9nC2qn5DovrgM',
  [`${REACT_DOM_ESM_BASE}/es2022/client.mjs`]: 'sha384-vK9eHXJaYh23bHnPGQmnoNh9HfePoj1uFQPpm1MgDcLVNW5EcVPIzDKxPHkxjgmP',
  [`${REACT_DOM_ESM_BASE}/es2022/react-dom.mjs`]: 'sha384-EyquMVSONwhMrth737GgF6y3Z9+XoRaJgacXp2XxUwchleTwltUUZiVF37zDJkZ4',
  [`${REACT_DOM_ESM_BASE}/es2022/server.mjs`]: 'sha384-IwzC8eRS5WH1zi7moYXhPmDA8p6w0r3uVG2yrfNRHHngpelUxeDz0raWF6O89APj',
  [`${REACT_DOM_ESM_BASE}/es2022/cjs/react-dom-server-legacy.browser.production.mjs`]: 'sha384-RPa0ImTl9OI1lRLPTu6UD3Pi1dGOkzNqX5jmHAbzM9lGpC/4P40HuAhcXm3fIGUg',
  [`${REACT_DOM_ESM_BASE}/es2022/cjs/react-dom-server.browser.production.mjs`]: 'sha384-4xw4onVS7+N9AtveaWuTyJlbV2W0onO6MGaTqkIUppwz4o3CDgWSwJRfv900ltXA',
  [SCHEDULER_ESM_ENTRY]: 'sha384-Hn0En/+NbrkiN2qg3vteMOo2bUZo6FSvCNMXYl56LT6iDZPcvE+dM5KihcQci8Pi',
  'https://esm.sh/scheduler@0.27.0/es2022/scheduler.mjs': 'sha384-FlH+dunulq4haKZQI6cgqxRdEF65XdB6qi6BJPf2tC0mxkN+PmNGZVIvhcobyxKX',
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
