import {assertCompiledExtensionImports, createExtensionImportTransform} from './extensionImportPolicy.js'

/** Babel presets the extension loader transpiles with; tests that mirror the
 *  loader import this rather than restate it. The AUTOMATIC JSX runtime keeps
 *  an extension's JSX on the host's React: it imports its factory from
 *  `react/jsx-runtime`, which the page import map resolves to the module the
 *  app itself uses. The classic runtime would emit `React.createElement` and
 *  depend on whichever `React` global happens to be in scope.
 *
 *  `onlyRemoveTypeImports: false` erases an import whose bindings are used
 *  only as types even when it is not written `import type`. Stored extensions
 *  rely on that, and a kept import of a type-only export fails to link. */
export const EXTENSION_BABEL_PRESETS: Array<[string, object]> = [
  ['react', {runtime: 'automatic'}],
  ['typescript', {onlyRemoveTypeImports: false}],
]

/** Load Babel on a compile miss. The inline source map preserves TSX
 *  locations and sourceURL names the generated blob script after revocation. */
export async function transpileExtension(content: string, blockId: string, allowUnpinnedLive: boolean) {
  const Babel = await import('@babel/standalone')
  // A synced block ID must never break out of the generated sourceURL comment.
  const safeId = (blockId ?? 'extension-block').replace(/[^A-Za-z0-9._-]/g, '_')
  const sourceName = `${safeId}.tsx`
  const transform = createExtensionImportTransform()
  const transpiled = Babel.transform(content, {
    filename: sourceName,
    sourceFileName: sourceName,
    sourceMaps: 'inline',
    presets: EXTENSION_BABEL_PRESETS,
    plugins: [transform.plugin],
  })?.code
  if (!transpiled) throw new Error('Transpiled extension code is empty')
  const checked = assertCompiledExtensionImports(Babel.packages.parser.parse, transpiled, {...transform, allowUnpinnedLive})
  return {
    ...checked,
    pinnedImports: transform.pinnedImports,
    compiled: `${checked.compiled}\n//# sourceURL=km-extension://${sourceName}`,
  }
}
