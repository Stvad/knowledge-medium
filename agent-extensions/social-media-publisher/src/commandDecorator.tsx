import {
  type BlockContentDecorator,
  type BlockContentDecoratorContribution,
} from '@/extensions/blockInteraction.js'
import type {BlockRenderer} from '@/types.js'
import {Button} from '@/components/ui/button.js'
import {useEffect, type CSSProperties} from 'react'

import {SendIcon} from './icons'
import {publishFromBlock} from './PublishDialog'
import {commandTargetForTypes} from './properties'
import {ensureSocialCounterForCommand} from './socialCounter'
import type {TargetPlatform} from './types'
import {PLATFORM_LABELS} from './types'

const commandStyles = {
  wrapper: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
  },
  content: {
    minWidth: 0,
    flex: '1 1 auto',
  },
} satisfies Record<string, CSSProperties>

const CommandBlockButton = ({
  block,
  target,
}: {
  block: any
  target: TargetPlatform
}) => (
  <Button
    type='button'
    size='sm'
    variant='outline'
    title={`Publish to ${target === 'all' ? 'configured platforms' : PLATFORM_LABELS[target]}`}
    onMouseDown={event => event.stopPropagation()}
    onClick={event => {
      event.preventDefault()
      event.stopPropagation()
      void publishFromBlock(block.repo, block.id, target)
    }}
  >
    <SendIcon className='mr-2 h-4 w-4' />
    Publish
  </Button>
)

const SocialCounterConfigurator = ({
  block,
  target,
}: {
  block: any
  target: TargetPlatform
}) => {
  useEffect(() => {
    let cancelled = false
    void ensureSocialCounterForCommand(block.repo, block.id, target)
      .catch(error => {
        if (!cancelled) {
          console.error('[social-media-publisher] failed to configure counter', error)
        }
      })
    return () => { cancelled = true }
  }, [block, target])

  return null
}

const commandDecoratorCache = new Map<TargetPlatform, WeakMap<BlockRenderer, BlockRenderer>>()

const decorateCommandBlock = (target: TargetPlatform): BlockContentDecorator => inner => {
  let cache = commandDecoratorCache.get(target)
  if (!cache) {
    cache = new WeakMap<BlockRenderer, BlockRenderer>()
    commandDecoratorCache.set(target, cache)
  }
  const existing = cache.get(inner)
  if (existing) return existing
  const Decorated: BlockRenderer = props => {
    const Inner = inner
    return (
      <>
        <SocialCounterConfigurator block={props.block} target={target} />
        <div style={commandStyles.wrapper}>
          <div style={commandStyles.content}>
            <Inner {...props} />
          </div>
          <CommandBlockButton block={props.block} target={target} />
        </div>
      </>
    )
  }
  Decorated.displayName = 'WithSocialPublishCommand'
  cache.set(inner, Decorated)
  return Decorated
}

export const commandBlockDecorator: BlockContentDecoratorContribution = ctx => {
  const target = commandTargetForTypes(ctx.types)
  return target ? decorateCommandBlock(target) : null
}
