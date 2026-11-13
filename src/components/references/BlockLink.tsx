import type { ComponentProps, MouseEvent, ReactNode } from 'react'
import { useRepo } from '@/context/repo'
import { useBlockContext } from '@/context/block'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from '@/components/ui/context-menu'
import { navigate } from '@/utils/navigation'
import { formatLinkClickGesture, linkClickActions } from '@/utils/linkClickGestures'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { ExtensionRenderBoundary } from '@/extensions/ExtensionRenderBoundary.js'
import {
  blockLinkDecoratorsFacet,
  type BlockLinkAnchorProps,
  type BlockLinkDecorator,
  type BlockLinkTarget,
} from '@/extensions/blockLinkDecorators.js'
import { classifyLinkInteraction } from './linkInteraction'

const ownsLinkMenuGesture = (event: MouseEvent): boolean =>
  !event.shiftKey
  && classifyLinkInteraction(event) === null
  && window.getSelection()?.isCollapsed !== false

/** Touch holds belong to the content gesture recognizers, so Radix must not
 * arm a competing long-press or override the surface's inherited callout style. */
function LinkMenuAnchor({onContextMenu, style, ...props}: ComponentProps<'a'>) {
  return <a
    {...props}
    style={{...style, WebkitTouchCallout: undefined}}
    onPointerDown={undefined}
    onContextMenu={event => {
      if (!ownsLinkMenuGesture(event)) return
      event.stopPropagation()
      onContextMenu?.(event)
    }}
  />
}

function BlockLinkDecoratorStack({decorators, index = 0, link, anchorProps, render}: {
  decorators: readonly BlockLinkDecorator[]
  index?: number
  link: BlockLinkTarget
  anchorProps: BlockLinkAnchorProps
  render: (anchorProps: BlockLinkAnchorProps) => ReactNode
}) {
  const Decorator = decorators[index]
  if (!Decorator) return <>{render(anchorProps)}</>

  return (
    <ExtensionRenderBoundary>
      <Decorator link={link} anchorProps={anchorProps}>
        {nextProps => (
          <BlockLinkDecoratorStack
            decorators={decorators}
            index={index + 1}
            link={link}
            anchorProps={nextProps}
            render={render}
          />
        )}
      </Decorator>
    </ExtensionRenderBoundary>
  )
}

export function BlockLink({blockId, workspaceId, ...props}: ComponentProps<'a'> & {
  blockId: string
  workspaceId: string
}) {
  const repo = useRepo()
  const {panelId} = useBlockContext()
  const decorators = useAppRuntime().read(blockLinkDecoratorsFacet)

  return (
    <BlockLinkDecoratorStack
      decorators={decorators}
      link={{blockId, workspaceId}}
      anchorProps={props}
      render={anchorProps => (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <LinkMenuAnchor {...anchorProps}/>
          </ContextMenuTrigger>
          <ContextMenuContent
            onPointerDown={event => event.stopPropagation()}
            onClick={event => event.stopPropagation()}
          >
            {linkClickActions.map(action => (
              <ContextMenuItem key={action.target} className="gap-6" onSelect={() => {
                void navigate(repo, {
                  blockId,
                  workspaceId,
                  target: action.target,
                  ...(action.target === 'main' ? {} : {sourcePanelId: panelId}),
                  origin: 'follow-link',
                })
              }}>
                {action.label}
                <ContextMenuShortcut className="tracking-normal">
                  {formatLinkClickGesture(action.modifiers)}
                </ContextMenuShortcut>
              </ContextMenuItem>
            ))}
            <ContextMenuSeparator/>
            <ContextMenuLabel className="text-xs font-normal text-muted-foreground">
              Shift-right-click for browser menu
            </ContextMenuLabel>
          </ContextMenuContent>
        </ContextMenu>
      )}
    />
  )
}
