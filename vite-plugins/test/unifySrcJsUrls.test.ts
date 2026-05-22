import {describe, expect, it} from 'vitest'
import {rewriteSrcImports} from '@/../vite-plugins/unifySrcJsUrls'

// `rewriteSrcImports` is the pure heart of the `unify-src-js-urls`
// Vite plugin. The plugin's whole job is to make every `/src/**`
// module fetch through `.js` URLs so kernel imports (which Vite
// normalizes to literal disk extensions) match the URLs dynamic
// extensions request via the document importmap — otherwise the
// browser sees two distinct module-map entries for the same file and
// every module-scoped singleton (React `createContext`, stores, etc.)
// gets duplicated, with consumers of the "wrong" copy throwing things
// like "useRepo must be used within a RepoContext".
//
// Test the regex behavior end-to-end via the function, not by
// reaching into the regex literal: the function's stability across
// future regex tweaks is what we actually care about.

describe('rewriteSrcImports — kernel-emitted `.tsx`/`.ts`/`.jsx` URLs become `.js`', () => {
  it('rewrites `from "/src/foo.tsx"` to `.js`', () => {
    expect(rewriteSrcImports(`import x from "/src/context/repo.tsx"`))
      .toBe(`import x from "/src/context/repo.js"`)
  })

  it('rewrites `.ts` and `.jsx` suffixes the same way', () => {
    expect(rewriteSrcImports(`from "/src/data/repo.ts"`)).toBe(`from "/src/data/repo.js"`)
    expect(rewriteSrcImports(`from "/src/legacy/foo.jsx"`)).toBe(`from "/src/legacy/foo.js"`)
  })

  it('handles single-quoted specifiers', () => {
    expect(rewriteSrcImports(`from '/src/context/repo.tsx'`))
      .toBe(`from '/src/context/repo.js'`)
  })

  it('rewrites dynamic imports', () => {
    expect(rewriteSrcImports(`await import("/src/data/repo.ts")`))
      .toBe(`await import("/src/data/repo.js")`)
  })

  it("rewrites Vite's HMR-context calls — the reason the regex is broad", () => {
    // Vite emits `__vite__createHotContext("/src/foo.tsx")` in every
    // served module. If we constrained the rewrite to `from`/`import(`
    // syntax, this would slip through with the literal disk
    // extension, the module would HMR under `.tsx` while everyone
    // else uses `.js`, and the duplicate-module bug returns. This
    // test is the regression guard for that "tightening the regex
    // is unsafe" claim.
    const input = `import.meta.hot = __vite__createHotContext("/src/context/repo.tsx");`
    const expected = `import.meta.hot = __vite__createHotContext("/src/context/repo.js");`
    expect(rewriteSrcImports(input)).toBe(expected)
  })

  it('preserves query strings (Vite HMR/import markers)', () => {
    expect(rewriteSrcImports(`from "/src/foo.tsx?import"`))
      .toBe(`from "/src/foo.js?import"`)
    expect(rewriteSrcImports(`from "/src/foo.tsx?t=1234567890"`))
      .toBe(`from "/src/foo.js?t=1234567890"`)
    expect(rewriteSrcImports(`from "/src/foo.tsx?v=abc&import"`))
      .toBe(`from "/src/foo.js?v=abc&import"`)
  })

  it('preserves hash fragments', () => {
    expect(rewriteSrcImports(`from "/src/foo.tsx#region"`))
      .toBe(`from "/src/foo.js#region"`)
  })

  it('leaves multiple imports in one body alone except for the rewrites', () => {
    const input = [
      `import { useRepo } from "/src/context/repo.tsx";`,
      `import { Block } from "/src/data/block.ts";`,
      `import "/src/utils/init.tsx";`,
    ].join('\n')
    const expected = [
      `import { useRepo } from "/src/context/repo.js";`,
      `import { Block } from "/src/data/block.js";`,
      `import "/src/utils/init.js";`,
    ].join('\n')
    expect(rewriteSrcImports(input)).toBe(expected)
  })

  it('handles nested paths under /src/', () => {
    expect(rewriteSrcImports(`from "/src/plugins/grouped-backlinks/config.tsx"`))
      .toBe(`from "/src/plugins/grouped-backlinks/config.js"`)
  })
})

describe('rewriteSrcImports — paths that must NOT be rewritten', () => {
  it('leaves `.js` URLs unchanged (already canonical)', () => {
    const input = `import x from "/src/context/repo.js"`
    expect(rewriteSrcImports(input)).toBe(input)
  })

  it('leaves Vite-internal `/@id/...` URLs alone', () => {
    const input = `import x from "/@id/__x00__virtual:some-module.tsx"`
    expect(rewriteSrcImports(input)).toBe(input)
  })

  it('leaves `/@vite/...` URLs alone', () => {
    const input = `import { createHotContext } from "/@vite/client";`
    expect(rewriteSrcImports(input)).toBe(input)
  })

  it('leaves `/node_modules/...` URLs alone', () => {
    const input = `import * as react from "/node_modules/react/index.js?v=abc";`
    expect(rewriteSrcImports(input)).toBe(input)
  })

  it('leaves URLs without leading `/src/` alone (e.g. relative project paths)', () => {
    const input = `// project file: ./src/foo.tsx`
    expect(rewriteSrcImports(input)).toBe(input)
  })

  it('leaves URLs that resolve outside /src/ alone (e.g. /static/)', () => {
    const input = `import x from "/static/something.tsx"`
    expect(rewriteSrcImports(input)).toBe(input)
  })

  it('does not corrupt base64-encoded inline sourcemaps', () => {
    // Inline sourcemaps reference sources by bare basename (e.g.
    // "sources":["App.tsx"]) and the base64 itself doesn't contain
    // `/src/...tsx` literally. This test guards against accidentally
    // tightening the regex in a way that touches the base64 string.
    const base64 = `eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIkFwcC50c3giXX0=`
    const input = `// some code\n//# sourceMappingURL=data:application/json;base64,${base64}`
    expect(rewriteSrcImports(input)).toBe(input)
  })

  it('returns input unchanged when there are no /src/...tsx matches at all', () => {
    const input = `const a = 1; export const b = a + 1;`
    expect(rewriteSrcImports(input)).toBe(input)
  })
})

describe('rewriteSrcImports — known limitation (documented in plugin)', () => {
  it('WOULD rewrite a string literal that happens to look like a /src/ URL — accepted false-positive', () => {
    // This is the false-positive risk the plugin docs call out:
    // user code with a string like `"/src/foo.tsx"` (e.g. in a
    // comment or a config value) gets rewritten too. The cost of
    // constraining the regex to syntactic imports is bigger (the
    // HMR-context case above), so this is left as a documented
    // limitation.
    const input = `const docsPath = "/src/components/Foo.tsx"`
    expect(rewriteSrcImports(input)).toBe(`const docsPath = "/src/components/Foo.js"`)
  })
})
