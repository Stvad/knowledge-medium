import {describe, expect, it} from 'vitest'
import {rewriteImportMapScript} from '@/../vite-plugins/importMapHtml'
import {appImportedSubpaths, cjsShimSource, moduleKind, packageNameOf, vendorImports} from '@/../vite-plugins/vendorImportMap'

describe('packageNameOf', () => {
  it('takes the top-level package from a bare specifier, scoped or not', () => {
    expect(packageNameOf('zod')).toBe('zod')
    expect(packageNameOf('zod/v4')).toBe('zod')
    expect(packageNameOf('@codemirror/view')).toBe('@codemirror/view')
    expect(packageNameOf('@codemirror/view/dist/index.js')).toBe('@codemirror/view')
  })

  it('is undefined for anything that is not a package', () => {
    for (const specifier of ['./x', '../x', '/src/x.js', '\0virtual', 'node:fs', 'virtual:foo', '@/facets/facet.js', '@scope', '']) {
      expect(packageNameOf(specifier), specifier).toBeUndefined()
    }
  })
})

describe('appImportedSubpaths', () => {
  const packages = new Set(['react', 'react-dom', 'zod'])

  it('collects subpaths of exposed packages from static, dynamic and side-effect imports', () => {
    const sources = [
      `import {createRoot} from 'react-dom/client'\nimport 'zod/locales'`,
      `const mod = await import('react-dom/server')`,
      `import type {Root} from "react-dom/client"`,
    ]
    expect(appImportedSubpaths(sources, packages)).toEqual(['react-dom/client', 'react-dom/server', 'zod/locales'])
  })

  it('ignores bare package imports, unexposed packages, aliases, relatives and query suffixes', () => {
    const sources = [
      `import React from 'react'`,
      `import {x} from 'lodash-es/debounce'`,
      `import {y} from '@/utils/y.js'`,
      `import z from './z?raw'`,
      `import w from 'zod/v4?url'`,
    ]
    expect(appImportedSubpaths(sources, packages)).toEqual(['zod/v4'])
  })
})

describe('vendorImports', () => {
  it('maps each specifier to its document-relative facade, sorted', () => {
    expect(vendorImports(['zod', '@codemirror/view', 'react/jsx-runtime'])).toEqual({
      '@codemirror/view': './vendor/@codemirror/view.js',
      'react/jsx-runtime': './vendor/react/jsx-runtime.js',
      zod: './vendor/zod.js',
    })
  })

  it('merges into an existing importmap block without touching other entries', () => {
    const html = `<script type="importmap">\n{"imports": {"@/": "./src/"}}\n</script>`
    const out = rewriteImportMapScript(html, m => ({...m, imports: {...m.imports, ...vendorImports(['zod'])}}))
    const parsed = JSON.parse(out.match(/<script type="importmap">([\s\S]*?)<\/script>/)![1])
    expect(parsed).toEqual({imports: {'@/': './src/', zod: './vendor/zod.js'}})
  })
})

describe('moduleKind', () => {
  const noType = () => undefined
  it('decides by extension first, then package type, then a syntax sniff', () => {
    expect(moduleKind('/x/a.mjs', () => 'module.exports = 1', noType)).toBe('esm')
    expect(moduleKind('/x/a.cjs', () => 'export const a = 1', noType)).toBe('cjs')
    expect(moduleKind('/x/a.js', () => 'module.exports = 1', () => 'module')).toBe('esm')
    expect(moduleKind('/x/a.js', () => "'use strict';\nmodule.exports = require('./cjs/react.production.js');", noType)).toBe('cjs')
    expect(moduleKind('/x/a.js', () => "import {x} from './y.js'\nexport {x}", noType)).toBe('esm')
    expect(moduleKind('/x/a.js', () => "// comment mentioning export\nexports.a = 1", noType)).toBe('cjs')
  })
})

describe('cjsShimSource', () => {
  it('re-exports the module.exports object as default and each name off it', () => {
    expect(cjsShimSource('react', ['createContext', 'useState'])).toBe(
      'import m from "react";\nexport default m;\nexport const {createContext, useState} = m;\n',
    )
  })
  it('emits default alone when there are no names', () => {
    expect(cjsShimSource('x', [])).toBe('import m from "x";\nexport default m;\n')
  })
})
