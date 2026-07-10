import { describe, expect, it } from 'vitest'
import { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { defaultActionContextConfigs } from './defaultContexts'
import { ActionContextTypes } from './types'

describe('default action contexts', () => {
  it('keeps multi-select modal behavior independent of hardcoded movement keys', () => {
    const multiSelect = defaultActionContextConfigs.find(
      context => context.type === ActionContextTypes.MULTI_SELECT_MODE,
    )

    expect(multiSelect).toBeDefined()
    expect(multiSelect).toMatchObject({
      type: ActionContextTypes.MULTI_SELECT_MODE,
      modal: true,
    })
    // No eventFilter: modal multi-select must not silently drop key
    // events. (Guarded by the toBeDefined above so this can't pass
    // vacuously via optional chaining on an undefined config.)
    expect(multiSelect?.eventFilter).toBeUndefined()
  })

  it('rejects block dependencies without an explicit render visibility policy', () => {
    const normalMode = defaultActionContextConfigs.find(
      context => context.type === ActionContextTypes.NORMAL_MODE,
    )
    const block = new Block({} as Repo, 'block')
    const uiStateBlock = new Block({} as Repo, 'ui-state')

    expect(normalMode?.validateDependencies({block, uiStateBlock})).toBe(false)
    expect(normalMode?.validateDependencies({block, uiStateBlock, renderVisibilityPolicy: null})).toBe(false)
    expect(normalMode?.validateDependencies({block, uiStateBlock, renderVisibilityPolicy: {}})).toBe(true)
  })
})
