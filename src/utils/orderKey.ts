import { LexoRank } from 'lexorank'

/**
 * Generate an order key for a new first child
 */
export function generateFirstOrderKey(): string {
  return LexoRank.min().toString()
}

/**
 * Generate an order key for a new last child, given the current last child's order key
 */
export function generateNextOrderKey(lastOrderKey: string | null): string {
  if (!lastOrderKey) {
    return LexoRank.middle().toString()
  }
  
  const prevRank = LexoRank.parse(lastOrderKey)
  return prevRank.genNext().toString()
}

/**
 * Generate an order key for inserting between two siblings
 */
export function generateBetweenOrderKey(
  prevOrderKey: string | null,
  nextOrderKey: string | null
): string {
  if (!prevOrderKey && !nextOrderKey) {
    return LexoRank.middle().toString()
  }
  
  if (!prevOrderKey) {
    const nextRank = LexoRank.parse(nextOrderKey!)
    return nextRank.genPrev().toString()
  }
  
  if (!nextOrderKey) {
    const prevRank = LexoRank.parse(prevOrderKey)
    return prevRank.genNext().toString()
  }
  
  const prevRank = LexoRank.parse(prevOrderKey)
  const nextRank = LexoRank.parse(nextOrderKey)
  return prevRank.between(nextRank).toString()
}
