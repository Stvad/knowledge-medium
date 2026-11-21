// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { Tag } from 'lucide-react'
import { actionsFacet } from '@/extensions/core.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { definitionSeedsFacet, propertyEditorOverridesFacet } from '@/data/facets.js'
import { groupedBacklinksGroupHeaderActionsFacet } from '@/plugins/grouped-backlinks/facet.js'
import { ActionContextTypes } from '@/shortcuts/types.js'
import {
  ADD_TAG_ACTION_ID,
  ADD_TAG_BLOCKS_ACTION_ID,
  blockTaggingPlugin,
  blockTagsConfigProp,
} from '../index.ts'

describe('blockTaggingPlugin', () => {
  it('registers the tags-config property seed', () => {
    const runtime = resolveFacetRuntimeSync(blockTaggingPlugin)
    expect(runtime.read(definitionSeedsFacet)).toContain(blockTagsConfigProp)
  })

  it('contributes a property editor override for the tag-list config', () => {
    const runtime = resolveFacetRuntimeSync(blockTaggingPlugin)
    const overrides = runtime.read(propertyEditorOverridesFacet)
    const override = overrides.get(blockTagsConfigProp.seedKey)
    expect(override?.label).toBe('Block tags')
    expect(typeof override?.Editor).toBe('function')
  })

  it('registers the add-tag action in both NORMAL_MODE and MULTI_SELECT_MODE under distinct ids', () => {
    const runtime = resolveFacetRuntimeSync(blockTaggingPlugin)
    const actions = runtime.read(actionsFacet)
    const blockAction = actions.find(a => a.id === ADD_TAG_ACTION_ID)
    const blocksAction = actions.find(a => a.id === ADD_TAG_BLOCKS_ACTION_ID)
    expect(blockAction?.context).toBe(ActionContextTypes.NORMAL_MODE)
    expect(blocksAction?.context).toBe(ActionContextTypes.MULTI_SELECT_MODE)
    expect(blockAction?.icon).toBe(Tag)
    expect(blocksAction?.icon).toBe(Tag)
    expect(typeof blocksAction?.isVisible).toBe('function')
  })

  it('contributes a grouped-backlinks header entry pointing at the multi-select action id', () => {
    const runtime = resolveFacetRuntimeSync(blockTaggingPlugin)
    const entries = runtime.read(groupedBacklinksGroupHeaderActionsFacet)
    expect(entries.map(entry => entry.actionId)).toContain(ADD_TAG_BLOCKS_ACTION_ID)
  })
})
