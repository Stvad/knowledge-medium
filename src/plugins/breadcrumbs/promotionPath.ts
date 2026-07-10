interface BlockIdentity {
  id: string
}

/** Blocks whose children must stay visible after promoting an ancestor.
 *  `parents` is ordered outermost to innermost, ending at the original
 *  root's direct parent. */
export const promotedRevealPathIds = (
  parents: readonly BlockIdentity[],
  shownId: string,
  originalRootId: string,
): string[] => {
  if (shownId === originalRootId) return []
  const shownIndex = parents.findIndex(parent => parent.id === shownId)
  return shownIndex >= 0
    ? parents.slice(shownIndex).map(parent => parent.id)
    : []
}
