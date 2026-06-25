/**
 * Deterministic per-user colour. Same `userId` → same hue on every client,
 * so a peer's selection ring / cursor / caret are all the same colour
 * without any colour-assignment coordination over the wire.
 */

const hashString = (value: string): number => {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

/** A saturated, mid-lightness HSL colour keyed off the user id. The fixed
 *  saturation/lightness keep every assigned colour legible against both the
 *  light and dark block backgrounds. */
export const colorForUser = (userId: string): string => {
  const hue = hashString(userId) % 360
  return `hsl(${hue} 70% 50%)`
}
