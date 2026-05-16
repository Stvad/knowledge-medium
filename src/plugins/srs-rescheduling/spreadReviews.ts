import type { Block } from '@/data/block'
import { addDaysIso, todayIso } from '@/plugins/daily-notes'
import { srsBlockDateAdapter } from './srsBlockDateAdapter.ts'

export interface SpreadSrsReviewDatesOptions {
  days: number
  now?: Date
  random?: () => number
}

export interface SpreadSrsReviewDatesResult {
  eligible: number
  updated: number
  skipped: number
}

const normalizeDays = (days: number): number => {
  const wholeDays = Math.floor(days)
  if (!Number.isFinite(wholeDays) || wholeDays < 1) {
    throw new Error('Choose at least 1 day')
  }
  return wholeDays
}

export const randomUpcomingDateOffset = (
  days: number,
  random: () => number = Math.random,
): number => {
  const dayCount = normalizeDays(days)
  const value = Math.max(0, Math.min(random(), 0.999999999999))
  return 1 + Math.floor(value * dayCount)
}

export const spreadSrsReviewDates = async (
  blocks: readonly Block[],
  options: SpreadSrsReviewDatesOptions,
): Promise<SpreadSrsReviewDatesResult> => {
  const dayCount = normalizeDays(options.days)
  const random = options.random ?? Math.random
  const baseIso = todayIso(options.now ?? new Date())
  let eligible = 0
  let updated = 0

  for (const block of blocks) {
    const data = block.peek() ?? await block.load()
    if (!data || !srsBlockDateAdapter.canHandle(block)) continue

    eligible += 1
    const targetIso = addDaysIso(baseIso, randomUpcomingDateOffset(dayCount, random))
    if (await srsBlockDateAdapter.setIso(block, targetIso)) {
      updated += 1
    }
  }

  return {
    eligible,
    updated,
    skipped: blocks.length - eligible,
  }
}
