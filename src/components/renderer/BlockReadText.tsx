import type { ReactNode } from 'react'
import type { Block } from '@/data/block.js'
import { useBlockTitleTextClass } from './blockTitleText.js'
import { useGutterText } from './BlockGutter.js'

const DEFAULT_LAYOUT = 'min-h-[1.7em] whitespace-pre-wrap overflow-x-clip overflow-y-visible max-w-full'

/** The layout and typography of a block's own read-mode text. */
export function BlockReadText({block, as: Container = 'div', className, layoutClassName, children}: {
  block: Block
  as?: 'div' | 'span'
  className?: string
  layoutClassName?: string
  children: ReactNode
}) {
  const titleClass = useBlockTitleTextClass(block)
  const gutterText = useGutterText(block)
  const inline = Container === 'span'
  const classes = [
    'block-read-text',
    layoutClassName ?? DEFAULT_LAYOUT,
    className,
    titleClass,
  ].filter(Boolean).join(' ')

  return <Container ref={inline ? undefined : gutterText} className={classes}>{children}</Container>
}
