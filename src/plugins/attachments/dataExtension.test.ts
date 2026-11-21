import { describe, expect, it } from 'vitest'
import { attachmentCleanerIOVerb } from '@/data/attachmentCleanerIOVerb'
import type { Repo } from '@/data/repo'
import { staticDataExtensions } from '@/extensions/staticDataExtensions'
import { resolveFacetRuntimeSync } from '@/facets/facet'

describe('attachmentsDataExtension', () => {
  it('gives the data runtime, which the workspace gate runs under, the plugin\'s cleaner IO', async () => {
    const runtime = resolveFacetRuntimeSync(staticDataExtensions)
    const repo = {user: {id: 'user-1'}} as unknown as Repo

    // This build has no remote sync: the plugin's answer, not the verb's default.
    expect(await attachmentCleanerIOVerb.run(runtime, {repo, workspaceId: 'ws-1'}))
      .toEqual({kind: 'unavailable', reason: 'remote sync is off'})
  })
})
