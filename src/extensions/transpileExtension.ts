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

/** Transpile TS/JSX source to JS. Babel is loaded with a dynamic
 *  `import()` so the large `@babel/standalone` leaves the eager
 *  startup preload set (#167) — it's fetched/evaluated only here, on a
 *  genuine compile-cache miss.
 *
 *  Two debuggability additions (COMPILER_VERSION 2):
 *   - `sourceMaps: 'inline'` + `sourceFileName` embeds a base64 source map
 *     (with the original TSX in `sourcesContent`) so DevTools maps stack
 *     frames / breakpoints back to the author's source, not the transpiled
 *     JS.
 *   - a trailing `//# sourceURL` names the in-memory script. The blob URL is
 *     revoked the instant the import resolves, so without this a throw shows
 *     `blob:<uuid>` with no name; the sourceURL survives revocation and, when
 *     `blockId` is known, identifies *which* extension a frame came from.
 *  Note: live modules are cached per block as well as source hash so the
 *  sourceURL consistently identifies the owning extension block. */
export async function transpileExtension(content: string, blockId: string, allowUnpinnedLive: boolean) {
  const Babel = await import('@babel/standalone')
  // SECURITY: block ids are NOT trusted input — `tx.create` accepts a
  // caller-supplied id and ids also arrive via sync/import, all stored as
  // plain text. A raw id with a line terminator (\n, \r, U+2028, U+2029) would
  // break out of the `//# sourceURL` line comment appended below and inject
  // module-level JS that runs at instantiate — code that was never in the
  // approved `content`/`sourceHash`, defeating the #67 trust gate. Restrict the
  // id to a safe charset before it touches emitted JS. The sourceURL is a
  // cosmetic DevTools label, so aggressive sanitization costs nothing
  // (legitimate nanoid/uuid ids are already within this set).
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
  return {pinnedImports: transform.pinnedImports, importsUnpinned: checked.importsUnpinned, compiled: `${checked.compiled}\n//# sourceURL=km-extension://${sourceName}`}
}
