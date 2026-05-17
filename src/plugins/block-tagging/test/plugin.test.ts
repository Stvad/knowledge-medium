// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { Tag } from 'lucide-react'
import { actionsFacet } from '@/extensions/core.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { propertySchemasFacet, propertyEditorOverridesFacet } from '@/data/facets.ts'
import { groupedBacklinksGroupHeaderActionsFacet } from '@/plugins/grouped-backlinks/facet.ts'
import { ActionContextTypes } from '@/shortcuts/types.ts'
import {
  ADD_TAG_ACTION_ID,
  blockTaggingPlugin,
  blockTagsConfigProp,
} from '../index.ts'

describe('blockTaggingPlugin', () => {
  it('registers the tags-config property schema', () => {
    const runtime = resolveFacetRuntimeSync(blockTaggingPlugin)
    const schemas = runtime.read(propertySchemasFacet)
    expect(schemas.get(blockTagsConfigProp.name)).toBe(blockTagsConfigProp)
  })

  it('contributes a property editor override for the tag-list config', () => {
    const runtime = resolveFacetRuntimeSync(blockTaggingPlugin)
    const overrides = runtime.read(propertyEditorOverridesFacet)
    const override = overrides.get(blockTagsConfigProp.name)
    expect(override?.label).toBe('Block tags')
    expect(typeof override?.Editor).toBe('function')
  })

  it('registers the add-tag MULTI_SELECT action with a Tag icon', () => {
    const runtime = resolveFacetRuntimeSync(blockTaggingPlugin)
    const actions = runtime.read(actionsFacet)
    const action = actions.find(a => a.id === ADD_TAG_ACTION_ID)
    expect(action?.context).toBe(ActionContextTypes.MULTI_SELECT_MODE)
    expect(action?.icon).toBe(Tag)
    expect(typeof action?.canRun).toBe('function')
  })

  it('contributes a grouped-backlinks header entry pointing at the action', () => {
    const runtime = resolveFacetRuntimeSync(blockTaggingPlugin)
    const entries = runtime.read(groupedBacklinksGroupHeaderActionsFacet)
    expect(entries.map(entry => entry.actionId)).toContain(ADD_TAG_ACTION_ID)
  })
})
