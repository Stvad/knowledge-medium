import {describe, expect, it} from 'vitest'
import {
  productionReactIntegrity,
  REACT_ESM_VERSION,
  rewriteReactImportMapForProduction,
} from '@/../vite-plugins/reactImportMapMode'

const readImportMap = (html: string) => {
  const match = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)
  if (!match) throw new Error('No import map found')
  return JSON.parse(match[1])
}

describe('rewriteReactImportMapForProduction', () => {
  it('switches React import-map entries from esm.sh dev URLs to production URLs', () => {
    const html = `
      <script type="importmap">
        {
          "imports": {
            "react": "https://esm.sh/react@${REACT_ESM_VERSION}?dev",
            "react/": "https://esm.sh/react@${REACT_ESM_VERSION}&dev/",
            "react-dom": "https://esm.sh/react-dom@${REACT_ESM_VERSION}?dev",
            "react-dom/": "https://esm.sh/react-dom@${REACT_ESM_VERSION}&dev/",
            "@/": "./src/"
          },
          "integrity": {
            "https://esm.sh/react@${REACT_ESM_VERSION}?dev": "dev-react",
            "https://esm.sh/react@${REACT_ESM_VERSION}&dev/jsx-runtime": "dev-jsx-runtime",
            "https://esm.sh/react@${REACT_ESM_VERSION}/es2022/react.development.mjs": "dev-react-internal",
            "https://esm.sh/react-dom@${REACT_ESM_VERSION}?dev": "dev-react-dom",
            "https://esm.sh/scheduler@%5E0.27.0?target=es2022&dev": "dev-scheduler",
            "https://cdn.example.com/other.js": "other"
          }
        }
      </script>
    `

    const rewritten = rewriteReactImportMapForProduction(html)
    const importMap = readImportMap(rewritten)

    expect(importMap.imports).toMatchObject({
      react: `https://esm.sh/react@${REACT_ESM_VERSION}`,
      'react/': `https://esm.sh/react@${REACT_ESM_VERSION}/`,
      'react-dom': `https://esm.sh/react-dom@${REACT_ESM_VERSION}`,
      'react-dom/': `https://esm.sh/react-dom@${REACT_ESM_VERSION}/`,
      '@/': './src/',
    })
    expect(JSON.stringify(importMap)).not.toContain('?dev')
    expect(JSON.stringify(importMap)).not.toContain('&dev')
    expect(JSON.stringify(importMap)).not.toContain('.development.mjs')
  })

  it('replaces managed React integrity entries with the production graph and keeps unrelated entries', () => {
    const html = `
      <script type="importmap">
        {
          "imports": {
            "react": "https://esm.sh/react@${REACT_ESM_VERSION}?dev"
          },
          "integrity": {
            "https://esm.sh/react@${REACT_ESM_VERSION}?dev": "dev-react",
            "https://cdn.example.com/other.js": "other"
          }
        }
      </script>
    `

    const importMap = readImportMap(rewriteReactImportMapForProduction(html))

    expect(importMap.integrity).toMatchObject(productionReactIntegrity)
    expect(importMap.integrity['https://cdn.example.com/other.js']).toBe('other')
    expect(importMap.integrity[`https://esm.sh/react@${REACT_ESM_VERSION}?dev`]).toBeUndefined()
  })

  it('includes the react-dom/server graph in the production integrity set', () => {
    expect(productionReactIntegrity).toMatchObject({
      [`https://esm.sh/react-dom@${REACT_ESM_VERSION}/server`]:
        'sha384-tTy7T4lm9zbn4WLf9sNOE68LSnJDnyqgfNVqZpMKQubeVEmzruL9nC2qn5DovrgM',
      [`https://esm.sh/react-dom@${REACT_ESM_VERSION}/es2022/server.mjs`]:
        'sha384-IwzC8eRS5WH1zi7moYXhPmDA8p6w0r3uVG2yrfNRHHngpelUxeDz0raWF6O89APj',
      [`https://esm.sh/react-dom@${REACT_ESM_VERSION}/es2022/cjs/react-dom-server-legacy.browser.production.mjs`]:
        'sha384-RPa0ImTl9OI1lRLPTu6UD3Pi1dGOkzNqX5jmHAbzM9lGpC/4P40HuAhcXm3fIGUg',
      [`https://esm.sh/react-dom@${REACT_ESM_VERSION}/es2022/cjs/react-dom-server.browser.production.mjs`]:
        'sha384-4xw4onVS7+N9AtveaWuTyJlbV2W0onO6MGaTqkIUppwz4o3CDgWSwJRfv900ltXA',
    })
  })

  it('leaves unrelated import maps unchanged', () => {
    const html = `
      <script type="importmap">
        {"imports": {"lodash": "https://esm.sh/lodash@4.18.1"}}
      </script>
    `

    expect(rewriteReactImportMapForProduction(html)).toBe(html)
  })
})
