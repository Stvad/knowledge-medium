import { isoFromRoamDate, storedIsoDay } from '@/utils/dailyPage'
import { dailyNoteDateValue, isDateAlias, todayIso } from './dailyNotes'

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']

const relativeOffset = (text: string, now: Date): number | undefined => {
  if (text === 'today') return 0
  if (text === 'tomorrow') return 1
  if (text === 'yesterday') return -1
  const nextWeek = text.startsWith('next ')
  const weekday = WEEKDAYS.indexOf(nextWeek ? text.slice(5) : text)
  if (weekday === -1) return undefined
  const today = (now.getDay() + 6) % 7
  const delta = weekday - today
  return nextWeek ? delta + 7 : (delta + 7) % 7
}

/** Literal instants use UTC. Relative days are counted from the client's local calendar day. */
export const resolveDayInput = (input: string, now = new Date()): string => {
  const text = input.trim()
  const literal = storedIsoDay(text)
  if (literal !== undefined) return literal
  if (isDateAlias(text)) throw new Error(`Invalid calendar date: ${text}`)

  const lower = text.toLowerCase()
  const roam = isoFromRoamDate(lower)
  if (roam !== undefined) return roam
  const offset = relativeOffset(lower, now)
  if (offset !== undefined) {
    const date = dailyNoteDateValue(todayIso(now))
    date.setUTCDate(date.getUTCDate() + offset)
    const iso = date.toISOString().slice(0, 10)
    if (isDateAlias(iso)) return iso
  }
  throw new Error(`Invalid calendar day: ${text}`)
}
