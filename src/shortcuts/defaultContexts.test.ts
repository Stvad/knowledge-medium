import { describe, expect, it } from 'vitest'
import { defaultActionContextConfigs } from './defaultContexts'
import { ActionContextTypes } from './types'

describe('default action contexts', () => {
  it('keeps multi-select modal behavior independent of hardcoded movement keys', () => {
    const multiSelect = defaultActionContextConfigs.find(
      context => context.type === ActionContextTypes.MULTI_SELECT_MODE,
    )

    expect(multiSelect).toMatchObject({
      type: ActionContextTypes.MULTI_SELECT_MODE,
      modal: true,
    })
    expect(multiSelect?.eventFilter).toBeUndefined()
  })
})
