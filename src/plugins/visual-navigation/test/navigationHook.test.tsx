// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import { useLayoutEffect, useRef } from 'react'
import { BlockCache } from '@/data/blockCache'
import { ChangeScope, type User } from '@/data/api'
import { Repo } from '@/data/repo'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import {
  focusedBlockIdProp,
  focusedVisualTargetKeyProp,
  topLevelBlockIdProp,
} from '@/data/properties'
import {
  __resetVisualNavigationForTesting,
  useVisualNavigationTarget,
} from '@/plugins/visual-navigation/navigation.ts'

const WS = 'ws-1'
const USER: User = {id: 'user-1'}

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  const h = await createTestDb()
  const repo = new Repo({
    db: h.db,
    cache: new BlockCache(),
    user: USER,
    registerKernelProcessors: false,
  })
  repo.setActiveWorkspaceId(WS)
  return {h, repo}
}

const targetRect = (top: number) => ({
  top,
  left: 0,
  right: 100,
  bottom: top + 24,
  width: 100,
  height: 24,
  x: 0,
  y: top,
  toJSON: () => ({}),
})

const stableSharedKey = '__layout__:panel:document:shared'

function VisualTargetProbe({
  id,
  top,
  env,
}: {
  id: string
  top: number
  env: Harness
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const uiStateBlock = env.repo.block('panel')

  useLayoutEffect(() => {
    if (!ref.current) return
    Object.defineProperty(ref.current, 'getBoundingClientRect', {
      value: () => targetRect(top),
    })
  }, [top])

  const target = useVisualNavigationTarget({
    blockId: 'shared',
    uiStateBlock,
    panelId: 'panel',
    surface: 'document',
    elementRef: ref,
  })

  return (
    <div
      ref={ref}
      data-testid={id}
      data-active={target.active ? 'true' : 'false'}
    />
  )
}

let env: Harness

beforeEach(async () => {
  __resetVisualNavigationForTesting()
  document.body.innerHTML = ''
  env = await setup()
  await env.repo.tx(async tx => {
    await tx.create({
      id: 'panel',
      workspaceId: WS,
      parentId: null,
      orderKey: 'a0',
      properties: {
        [topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode('root'),
        [focusedBlockIdProp.name]: focusedBlockIdProp.codec.encode('shared'),
      },
    })
    await tx.create({id: 'shared', workspaceId: WS, parentId: null, orderKey: 'b0', content: 'shared'})
  }, {scope: ChangeScope.UiState})
})

afterEach(async () => {
  cleanup()
  __resetVisualNavigationForTesting()
  document.body.innerHTML = ''
  await env.h.cleanup()
})

describe('visual navigation target hook', () => {
  it('chooses one fallback occurrence when focused block has no stored visual target key', async () => {
    const view = render(
      <>
        <VisualTargetProbe id="first" top={0} env={env}/>
        <VisualTargetProbe id="second" top={40} env={env}/>
      </>,
    )

    await waitFor(() => {
      expect(env.repo.block('panel').peekProperty(focusedVisualTargetKeyProp)).toBe(stableSharedKey)
      expect(view.getByTestId('first')).toHaveAttribute('data-active', 'true')
      expect(view.getByTestId('second')).toHaveAttribute('data-active', 'false')
    })
  })

  it('keeps the visual target key stable when a focused block occurrence remounts', async () => {
    const view = render(<VisualTargetProbe key="before" id="target" top={0} env={env}/>)

    await waitFor(() => {
      expect(view.getByTestId('target')).toHaveAttribute('data-active', 'true')
      expect(env.repo.block('panel').peekProperty(focusedVisualTargetKeyProp)).toBe(stableSharedKey)
    })

    view.rerender(<VisualTargetProbe key="after" id="target" top={0} env={env}/>)

    await waitFor(() => {
      expect(view.getByTestId('target')).toHaveAttribute('data-active', 'true')
      expect(env.repo.block('panel').peekProperty(focusedVisualTargetKeyProp)).toBe(stableSharedKey)
    })
  })
})
