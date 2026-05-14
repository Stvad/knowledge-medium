export interface SrsIndicatorState {
  interval: number
  factor: number
  reviewCount: number
  archived: boolean
}

const BAR_BASE = 'srs-review-block border-l-2 pl-1'

export const srsBarClass = (state: SrsIndicatorState): string => {
  if (state.archived) return `${BAR_BASE} border-muted-foreground/30 border-dashed`
  if (state.reviewCount === 0) return `${BAR_BASE} border-sky-500/40 border-dashed`
  const i = state.interval
  if (i <= 3) return `${BAR_BASE} border-sky-500`
  if (i <= 10) return `${BAR_BASE} border-sky-500/75`
  if (i <= 30) return `${BAR_BASE} border-sky-500/50`
  if (i <= 90) return `${BAR_BASE} border-sky-500/30`
  return `${BAR_BASE} border-sky-500/15`
}

const formatInterval = (interval: number): string => {
  const rounded = Math.round(interval * 10) / 10
  return rounded.toString()
}

const formatFactor = (factor: number): string => {
  const rounded = Math.round(factor * 100) / 100
  return rounded.toString()
}

export const srsIndicatorTitle = (state: SrsIndicatorState): string => {
  if (state.archived) return 'SRS · archived'
  if (state.reviewCount === 0) return 'SRS · new (not yet reviewed)'
  const reviews = `${state.reviewCount} review${state.reviewCount === 1 ? '' : 's'}`
  return `SRS · ${formatInterval(state.interval)}d interval · ${formatFactor(state.factor)} factor · ${reviews}`
}
