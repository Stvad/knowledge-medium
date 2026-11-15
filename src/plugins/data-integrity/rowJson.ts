/** `blocks.properties_json` → a property bag. Tolerant by design: a row whose
 *  JSON is unparseable, or parses to something other than an object, holds no
 *  key. Counting unparseable rows is `references_index_mirror`'s
 *  `malformedJson`, so a check reading bags through this skips nothing silently. */
export const parsePropertiesJson = (json: string | null): Record<string, unknown> => {
  if (json === null) return {}
  try {
    const parsed: unknown = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}
