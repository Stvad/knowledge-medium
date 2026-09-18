/** The one place the `<script type="importmap">` block in index.html is parsed
 *  and re-serialized, so the JSON shape and indentation stay one thing. */
export type ImportMap = {
  imports?: Record<string, string>
  [key: string]: unknown
}

const importMapScriptPattern =
  /(<script\b(?=[^>]*\btype=(["'])importmap\2)[^>]*>)([\s\S]*?)(<\/script>)/gi

const formatImportMap = (importMap: ImportMap): string =>
  `\n${JSON.stringify(importMap, null, 8).replace(/^/gm, '      ')}\n    `

/** The first importmap block in `html`, parsed; `undefined` when there is
 *  none or it is not JSON. */
export const readImportMap = (html: string): ImportMap | undefined => {
  const match = html.matchAll(importMapScriptPattern).next().value
  if (!match) return undefined
  try {
    return JSON.parse(match[3].trim()) as ImportMap
  } catch {
    return undefined
  }
}

/** Apply `rewrite` to every importmap script in `html`. A block that is not
 *  valid JSON, or that `rewrite` returns unchanged (same reference), is left
 *  byte-for-byte as it was. */
export const rewriteImportMapScript = (
  html: string,
  rewrite: (importMap: ImportMap) => ImportMap,
): string =>
  html.replace(importMapScriptPattern, (match, openTag, _quote, body, closeTag) => {
    try {
      const importMap = JSON.parse(body.trim()) as ImportMap
      const rewritten = rewrite(importMap)
      if (rewritten === importMap) return match
      return `${openTag}${formatImportMap(rewritten)}${closeTag}`
    } catch {
      return match
    }
  })
