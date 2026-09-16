import {describe, expect, it} from 'vitest'
import {rewriteImportMapScript} from '@/../vite-plugins/importMapHtml'
import {vendorImports} from '@/../vite-plugins/vendorImportMap'

describe('vendorImports', () => {
  it('maps each bare name to its document-relative facade, sorted', () => {
    expect(vendorImports(['zod', '@codemirror/view'])).toEqual({
      '@codemirror/view': './vendor/@codemirror/view.js',
      zod: './vendor/zod.js',
    })
  })

  it('merges into an existing importmap block without touching other entries', () => {
    const html = `<script type="importmap">\n{"imports": {"@/": "./src/"}, "integrity": {"u": "sha384-x"}}\n</script>`
    const out = rewriteImportMapScript(html, m => ({...m, imports: {...m.imports, ...vendorImports(['zod'])}}))
    const parsed = JSON.parse(out.match(/<script type="importmap">([\s\S]*?)<\/script>/)![1])
    expect(parsed).toEqual({
      imports: {'@/': './src/', zod: './vendor/zod.js'},
      integrity: {u: 'sha384-x'},
    })
  })
})
