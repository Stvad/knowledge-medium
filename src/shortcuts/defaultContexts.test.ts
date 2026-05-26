import { describe, expect, it } from 'vitest'
import { defaultActionContextConfigs } from '@/shortcuts/defaultContexts'
import { ActionContextTypes } from '@/shortcuts/types'

const multiSelectContext = () => {
  const context = defaultActionContextConfigs.find(
    candidate => candidate.type === ActionContextTypes.MULTI_SELECT_MODE,
  )
  if (!context) throw new Error('Multi-select context not registered')
  return context
}

describe('default action context configs', () => {
  it('accepts shift-arrow range expansion while multi-select owns the keyboard', () => {
    const context = multiSelectContext()
    const filter = context.eventFilter
    if (!filter) throw new Error('Expected multi-select to define an event filter')

    expect(filter(new KeyboardEvent('keydown', {key: 'ArrowDown', shiftKey: true}))).toBe(true)
    expect(filter(new KeyboardEvent('keydown', {key: 'ArrowUp', shiftKey: true}))).toBe(true)
    expect(filter(new KeyboardEvent('keydown', {key: 'ArrowDown'}))).toBe(false)
    expect(filter(new KeyboardEvent('keydown', {key: 'A', shiftKey: true}))).toBe(false)
  })
})
