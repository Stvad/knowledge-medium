/** Runtime stand-in for the app's `@/data/properties.js`.
 *
 *  `useProgram` calls `hasBlockType` to split one tree query into workouts,
 *  entries and sets. The real one decodes the `types` property through its
 *  codec; reproducing that here would be a second spelling of an encoding
 *  this extension does not own, and the two agreeing would prove nothing.
 *
 *  So this reads the decoded form directly, and the tests that use it publish
 *  rows in that form. What the REAL encoding does — including that a set
 *  block carrying both `strength-set` and `todo` lands in the sets bucket and
 *  not somewhere else — is proven against the real thing in the integration
 *  tier, which runs the actual `@/data/properties`.
 *
 *  Aliased in `vitest.config.ts`; `src/` still imports the real path. */

export const hasBlockType = (
  data: {properties: Record<string, unknown>},
  typeId: string,
): boolean => {
  const raw = data.properties.types
  return Array.isArray(raw) && raw.includes(typeId)
}
