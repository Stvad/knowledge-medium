import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'
import {facadeImportTargets, facadeResidue} from '@/../vite-plugins/facadeShape'
import {readImportMap, rewriteImportMapScript} from '@/../vite-plugins/importMapHtml'
import {
  appImportedSubpaths,
  cjsShimSource,
  facadeSource,
  moduleKind,
  packageNameOf,
  vendorImportMapPlugin,
  vendorImports,
} from '@/../vite-plugins/vendorImportMap'

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
    ]
    expect(appImportedSubpaths(sources, packages)).toEqual(['react-dom/client', 'react-dom/server', 'zod/locales'])
  })

  it('ignores what is not a runtime import: bare packages, unexposed packages, aliases, relatives, query suffixes, comments, type-only imports', () => {
    const sources = [
      `import React from 'react'`,
      `import {x} from 'lodash-es/debounce'`,
      `import {y} from '@/utils/y.js'`,
      `import z from './z?raw'`,
      `import w from 'zod/v4?url'`,
      `// see the docs from 'zod/mini'\n/* import 'zod/v3' */`,
      `import type {Root} from 'react-dom/client'`,
    ]
    expect(appImportedSubpaths(sources, packages)).toEqual(['zod/v4'])
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
    expect(moduleKind('/x/a.js', () => 'import React from "react"', noType)).toBe('esm')
  })
  it('does not read an identifier that merely starts with import as ESM syntax', () => {
    expect(moduleKind('/x/a.js', () => '!function(){}();\nimport_x = 1;\nimportScripts("w.js")', noType)).toBe('cjs')
    expect(moduleKind('/x/a.js', () => '// comment mentioning export\nexports.a = 1', noType)).toBe('cjs')
  })
})

describe('cjsShimSource', () => {
  it('reads names off the namespace, never off default, and lets a reserved word be an export name', () => {
    const src = cjsShimSource('x', ['createContext', 'catch'])
    expect(src).toMatch(/^import \* as m from "x";/)
    expect(src).toContain('export default m.default;')
    expect(src).toMatch(/const \{[^}]*\} = m;/)
    expect(src).not.toMatch(/= m\.default;/)
    expect(src).toMatch(/export \{[^}]*\b_\d+ as catch\b[^}]*\};/)
  })
})

describe('facadeSource', () => {
  // Against the real dependency files, resolved with import conditions the way
  // the bundler does (Node's require conditions would pick zod's CommonJS
  // entry). The CommonJS branch is what makes `import {useState} from 'react'`
  // link at all.
  const resolve = (specifier: string) => fileURLToPath(import.meta.resolve(specifier))
  const facade = (specifier: string) => {
    const file = resolve(specifier)
    return facadeSource(specifier, file, moduleKind(file))
  }
  it('shims a CommonJS package with the names Node sees on it', () => {
    const src = facade('react')
    expect(src).toContain('export default m.default;')
    expect(src).toMatch(/const \{[^}]*\buseState: _\d+\b[^}]*\} = m;/)
    expect(src).not.toContain('export *')
  })
  it('shims a CommonJS package flagged __esModule the same way (its default is undefined)', () => {
    const src = facade('@babel/standalone')
    expect(src).toMatch(/const \{[^}]*\btransform: _\d+\b[^}]*\} = m;/)
  })
  it('re-exports an ESM package as a whole', () => {
    const src = facade('zod')
    expect(src).toContain('export * from "zod";')
    expect(src).toContain('export default m.default;')
  })
})

describe('importmap helpers', () => {
  it('maps each specifier to its document-relative facade, sorted', () => {
    expect(vendorImports(['zod', '@codemirror/view', 'react/jsx-runtime'])).toEqual({
      '@codemirror/view': './vendor/@codemirror/view.js',
      'react/jsx-runtime': './vendor/react/jsx-runtime.js',
      zod: './vendor/zod.js',
    })
  })

  it('merges into an existing importmap block and reads back what it wrote', () => {
    const html = `<script type="importmap">\n{"imports": {"@/": "./src/"}}\n</script>`
    const out = rewriteImportMapScript(html, m => ({...m, imports: {...m.imports, ...vendorImports(['zod'])}}))
    expect(readImportMap(out)).toEqual({imports: {'@/': './src/', zod: './vendor/zod.js'}})
    expect(readImportMap('<p>no map</p>')).toBeUndefined()
  })
})

describe('vendorImportMapPlugin.resolveId', () => {
  // The dev URL is attacker-shaped; only an exposed specifier may become a
  // facade id, since a CommonJS verdict on the resolved file `require`s it.
  const plugin = vendorImportMapPlugin({rootDir: fileURLToPath(new URL('../..', import.meta.url))})
  const resolveId = (plugin.resolveId as {handler: (source: string) => string | null}).handler
  it('maps an exposed specifier, from the dev URL or the build input', () => {
    // Dev ids carry `.cjs` (see facadeId).
    expect(resolveId('/vendor/react.js')).toBe('\0km-vendor:react.cjs')
    expect(resolveId('/vendor/react/jsx-runtime.js')).toBe('\0km-vendor:react/jsx-runtime.cjs')
    expect(resolveId('virtual:km-vendor-cjs/react')).toBe('\0km-vendor:react.cjs')
  })
  it('refuses anything not exposed, including an absolute path smuggled into the URL', () => {
    expect(resolveId('/vendor//etc/hosts.js')).toBeNull()
    expect(resolveId('/vendor/../src/main.js')).toBeNull()
    expect(resolveId('/vendor/lucide-react.js')).toBeNull()
    expect(resolveId('virtual:km-vendor-cjs//tmp/x')).toBeNull()
  })
})

describe('facade shape (the post-build gate)', () => {
  const shim = 'import{a as e}from"../chunks/rolldown-runtime-X.js";import{Wvt as t}from"../chunks/app-X.js";var n=e(t()),r=n.default,{Activity:i,useState:a}=n;export{i as Activity,r as default,a as useState};'
  it('accepts an ESM facade and the CommonJS shim as emitted', () => {
    expect(facadeResidue('import{a as b}from"../chunks/app-x.js";export{b as a};')).toBe('')
    expect(facadeResidue(shim)).toBe('')
    expect(facadeResidue('"use client";import{a as b}from"../chunks/app-x.js";export{b as a};\n//# sourceMappingURL=x.js.map')).toBe('')
  })
  it('flags code of its own, however small', () => {
    expect(facadeResidue('import{a as b}from"../chunks/app-x.js";function evil(){}export{b as a};')).toBe('function evil(){}')
    expect(facadeResidue('var a=1,b=2;export{a,b};')).toBe('var a=1,b=2;')
  })
  it('lists side-effect imports as targets too, so none can name a non-chunk', () => {
    expect(facadeImportTargets('import"../src/main.js";import{a as b}from"../chunks/app-x.js";export{b as a};')).toEqual(['../src/main.js', '../chunks/app-x.js'])
  })
})
