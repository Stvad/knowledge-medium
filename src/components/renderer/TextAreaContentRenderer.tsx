import { BlockRendererProps } from '@/types.ts'
import { useIsEditing } from '@/data/properties.ts'
import { KeyboardEvent } from 'react'

export function TextAreaContentRenderer({block}: BlockRendererProps) {
  const blockData = block.use()
  const [_, setIsEditing] = useIsEditing(block)

  if (!blockData) return null

  const handleKeyDown = async (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      await block.createSiblingBelow({})
    } else if (e.key === 'Backspace' && blockData.content === '') {
      e.preventDefault()
      block.delete()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      if (e.shiftKey) {
        block.outdent()
      } else {
        block.indent()
      }
    } else if (e.key === 'ArrowUp' && e.metaKey && e.shiftKey) {
      e.preventDefault()
      block.changeOrder(-1)
    } else if (e.key === 'ArrowDown' && e.metaKey && e.shiftKey) {
      e.preventDefault()
      block.changeOrder(1)
    }
  }

  return (
    <textarea
      value={blockData.content}
      onChange={(e) => block.change(b => {
        b.content = e.target.value
      })}
      rows={Math.min(5, blockData.content.split('\n').length)}
      onKeyDown={handleKeyDown}
      className="w-full resize-none min-h-[1.7em] bg-transparent dark:bg-neutral-800 border-none p-0 font-inherit focus-visible:outline-none"
      onBlur={() => setIsEditing(false)}
    />
  )
}
