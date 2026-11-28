import * as Babel from '@babel/standalone'
import {describe, expect, it} from 'vitest'
import {unpinnedExtensionImportUrls} from '@knowledge-medium/agent-cli/extensionImportSyntax'
import {
  assertCompiledExtensionImports, createExtensionImportTransform, linkVendoredImports,
  resolveExtensionImport, vendoredImportSpecifier,
} from '@/extensions/extensionImportPolicy'

const integrity = 'sha256-' + 'A'.repeat(43) + '='
const url = 'https://cdn.example/fixture.mjs'
const parse = Babel.packages.parser.parse

function compile(source: string, allowUnpinnedLive = true) {
  const transform = createExtensionImportTransform()
  const compiled = Babel.transform(source, {
    filename: 'fixture.tsx',
    presets: [
      ['react', {runtime: 'automatic'}],
      ['typescript', {onlyRemoveTypeImports: false}],
    ],
    plugins: [transform.plugin],
  })?.code
  if (compiled == null) throw new Error('Babel emitted no code')
  return assertCompiledExtensionImports(parse, compiled, {...transform, allowUnpinnedLive})
}

describe('extension import policy', () => {
  it('resolves exact importmap aliases, including the server facade', () => {
    expect(resolveExtensionImport('react-dom/server.browser')).toEqual({
      kind: 'page', target: './src/vendor/react-dom-server.js',
    })
    expect(compile('export const fixture = <div />').compiled).toContain('react/jsx-runtime')
  })

  it('resolves only emitted source entries', () => {
    expect(resolveExtensionImport('@/extensions/core.js')).toEqual({
      kind: 'source', specifier: '@/extensions/core.js',
    })
    expect(resolveExtensionImport('@/sw/previewDatabases.js').kind).toBe('source')
  })

  it.each([
    '@/extensions/missing.js', '@/extensions/core', '@/test/setup.js',
    '@/extensions/test/extensionImportPolicy.test.js', '@/sw/worker.js', '@/extension-import-manifest.d.js',
    '@/extensions/../extensions/core.js', '@/extensions/core.js?raw', './core.js', 'react/unknown', '@/',
  ])('refuses the non-entry specifier %s', specifier => {
    expect(() => resolveExtensionImport(specifier)).toThrow('Extension import is not allowed')
  })

  it('restores an authored HTTPS import and reports it during the transition', () => {
    const result = compile(`import {fixture} from "${url}"; export default fixture`)
    expect(result.compiled).toContain(`"${url}"`)
    expect(result.importsUnpinned).toBe(true)
  })

  it('marks surviving static live references as pinnable', () => {
    expect(compile(`export * from "${url}"`)).toMatchObject({
      importsUnpinned: true, hasStaticUnpinnedImports: true,
    })
    expect(compile(`export default () => import("${url}")`)).toMatchObject({
      importsUnpinned: true, hasStaticUnpinnedImports: false,
    })
    expect(compile(`import {Unused} from "${url}"; export type Fixture = Unused`)).toMatchObject({
      importsUnpinned: false, hasStaticUnpinnedImports: false,
    })
  })

  it('keeps separately authored live and pinned references to the same URL', () => {
    const result = compile(`
      import "${url}";
      export * from "${url}" with {integrity: "${integrity}"}
    `)
    expect(result.compiled).toContain(`import "${url}"`)
    expect(result.compiled).toContain(`export * from "${vendoredImportSpecifier(integrity)}"`)
    expect(result.hasStaticUnpinnedImports).toBe(true)
  })

  it('refuses an authored HTTPS import when transition grants are off', () => {
    expect(() => compile(`import "${url}"`, false)).toThrow('requires an integrity pin')
  })

  it('does not grant a generated HTTPS import when author code imports the same URL', () => {
    expect(() => compile(`
      /** @jsxImportSource https://cdn.example */
      import "https://cdn.example/jsx-runtime";
      export default <div />
    `)).toThrow(/Extension import is not allowed: https:\/\/cdn.example\/jsx-runtime.*Check @jsxImportSource/)
  })

  it('refuses generated JSX runtime specifiers that use the reserved live scheme', () => {
    expect(() => compile(`
      /** @jsxImportSource km-live:https://cdn.example */
      import "https://cdn.example/jsx-runtime";
      export default <div />
    `)).toThrow('Extension import is not allowed: km-live:https://cdn.example/jsx-runtime')
  })

  it('refuses an authored reserved placeholder even when another import grants the same pin', () => {
    const forbidden = vendoredImportSpecifier(integrity)
    expect(() => compile(`
      import "${url}" with {integrity: "${integrity}"};
      export * from "${forbidden}";
    `)).toThrow('reserved import specifier')
  })

  it('refuses authored live placeholders even when another import grants the same URL', () => {
    expect(() => compile(`
      import "${url}";
      import "km-live:${encodeURIComponent(url)}";
    `)).toThrow('reserved import specifier')
  })

  it('refuses authored placeholders in dynamic import expressions', () => {
    expect(() => compile(`
      import "${url}";
      export const fixture = () => import("km-live:${encodeURIComponent(url)}");
    `)).toThrow('reserved import specifier')
  })

  it('applies integrity only to import references, including re-exports and side effect imports', () => {
    const placeholder = vendoredImportSpecifier(integrity)
    const result = compile(`
      import "${url}" with {integrity: "${integrity}"};
      export * from "${url}" with {integrity: "${integrity}"};
      export const fixture = "${placeholder}"
    `, false)
    expect(result.importsUnpinned).toBe(false)
    expect(result.compiled).not.toContain('with {')
    const linked = linkVendoredImports(parse, result.compiled, digest => {
      expect(digest).toBe(integrity)
      return 'blob:fixture'
    })
    expect(linked).toContain('import "blob:fixture"')
    expect(linked).toContain('export * from "blob:fixture"')
    expect(linked).toContain(`fixture = "${placeholder}"`)
  })

  it.each([
    [`import "${url}" with {type: "javascript"}`, 'requires a SHA-256 integrity attribute'],
    [`export default () => import("${url}", {with: {type: "javascript"}})`, 'moving them to a static import'],
  ])('reports an unpinned URL before the compiler rejects its malformed attributes or options: %s', (source, error) => {
    expect(unpinnedExtensionImportUrls(parse(source, {sourceType: 'module'}))).toEqual([url])
    expect(() => compile(source)).toThrow(error)
  })

  it('refuses malformed integrity attributes', () => {
    expect(() => compile(`import "${url}" with {integrity: "sha256-no"}`)).toThrow('SHA-256 integrity')
    expect(() => compile(`import "${url}" with {type: "javascript"}`)).toThrow('SHA-256 integrity')
  })

  it('refuses an integrity attribute accompanied by another attribute', () => {
    expect(() => compile(
      `import "${url}" with {integrity: "${integrity}", type: "javascript"}`,
    )).toThrow('SHA-256 integrity')
  })

  it('refuses a different attribute name even when the value is a digest', () => {
    expect(() => compile(`import "${url}" with {hash: "${integrity}"}`)).toThrow('SHA-256 integrity')
  })

  it('recognizes identifier and quoted integrity names without reporting them as unpinned', () => {
    const source = `import "${url}" with {"integrity": "${integrity}"}`
    expect(unpinnedExtensionImportUrls(parse(source, {sourceType: 'module'}))).toEqual([])
    expect(compile(source).compiled).toContain(vendoredImportSpecifier(integrity))
  })

  it('refuses two integrity pins for the same URL', () => {
    const differentIntegrity = 'sha256-' + 'B'.repeat(42) + 'A='
    expect(() => compile(`
      import "${url}" with {integrity: "${integrity}"};
      export * from "${url}" with {integrity: "${differentIntegrity}"};
    `)).toThrow('Conflicting integrity values')
  })

  it('refuses import() options on a live HTTPS import', () => {
    expect(() => compile(
      `export const fixture = () => import("${url}", {with: {integrity: "${integrity}"}})`,
    )).toThrow('moving them to a static import')
  })

  it('checks literal dynamic import references and refuses computed references', () => {
    expect(compile('export const fixture = () => import(`@/extensions/core.js`)').compiled).toContain('@/extensions/core.js')
    expect(compile(`export const fixture = () => import("${url}")`).importsUnpinned).toBe(true)
    expect(() => compile('export const fixture = x => import(x)')).toThrow('requires a literal')
    expect(() => compile('export const fixture = () => import("node:fs")')).toThrow('not allowed')
  })

  it('explains how to replace computed paths, data URLs, and missing kernel modules', () => {
    expect(() => compile('export default key => import(`@/${key}.js`)')).toThrow('template literal without interpolations')
    expect(() => compile('import "data:text/javascript,export default 1"')).toThrow('self-contained HTTPS module with an integrity pin')
    expect(() => compile('export default import("@/missing.js")')).toThrow('existing application module included in the build')
    expect(() => compile('export default import.meta.env')).toThrow('Replace other import.meta properties')
  })

  it('allows only the URL property of import.meta', () => {
    expect(compile('export default import.meta.url').compiled).toContain('import.meta.url')
    expect(() => compile('export default import.meta.resolve')).toThrow('only access import.meta.url')
    expect(() => compile('export default import.meta')).toThrow('only access import.meta.url')
  })

  it('does not treat type-only imports or strings as runtime edges', () => {
    const source = `
      import type { Fixture } from "${url}";
      export const fixture: Fixture = "${url}"
    `
    expect(unpinnedExtensionImportUrls(parse(source, {sourceType: 'module', plugins: ['typescript']}))).toEqual([])
    const result = compile(source, false)
    expect(result.importsUnpinned).toBe(false)
    expect(result.compiled).toContain(`"${url}"`)
  })
})
