import { describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
import { ProcessorRejection } from '@/data/api'
import type { Repo } from '@/data/repo'
import { aliasCollisionRejectionToast } from '../rejectionToast.tsx'
import { AliasCollisionToast } from '../AliasCollisionToast.tsx'

const repo = {} as Repo

const meta = {
  alias: 'Inbox',
  conflictingBlockId: 'blk-1',
  conflictingBlockTitle: 'Inbox',
  workspaceId: 'ws-1',
  attemptedOn: 'blk-2',
}

const render = (metaOverride: Record<string, unknown>): ReactElement<Record<string, unknown>> =>
  aliasCollisionRejectionToast.render(
    new ProcessorRejection('raw message', 'alias.collision', metaOverride),
    repo,
    'toast-id',
  ) as ReactElement<Record<string, unknown>>

describe('aliasCollisionRejectionToast.render', () => {
  it('renders the actionable AliasCollisionToast for a normal collision', () => {
    const el = render(meta)
    expect(el.type).toBe(AliasCollisionToast)
    expect(el.props.offerMerge).toBe(true)
    expect(el.props.toastId).toBe('toast-id')
    expect(el.props.conflictingBlockId).toBe('blk-1')
    expect(el.props.message).toContain('or merge with the existing page')
  })

  it('hides the merge affordance when the source was created in the rolled-back tx', () => {
    const el = render({...meta, collisionOrigin: 'create'})
    expect(el.props.offerMerge).toBe(false)
    expect(el.props.message).toContain('Nothing was created')
  })

  it('falls back to a plain message node when the meta is malformed', () => {
    const el = render({alias: 'Inbox'}) // missing required fields
    expect(el.type).toBe('span')
    expect(el.props.children).toBe('raw message')
  })
})
