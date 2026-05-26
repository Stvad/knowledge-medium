import { Command } from 'lucide-react'
import { Kbd } from '@/components/ui/kbd'
import { toggleCommandPaletteEvent } from './events.ts'

const getModKey = () =>
  navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl+'

export function CommandPaletteHeaderItem() {
  return (
    <button
      className="hidden h-7 w-7 items-center justify-center gap-1 rounded-md p-0 text-sm text-muted-foreground transition-colors hover:text-foreground sm:h-8 sm:w-auto sm:px-1.5 md:inline-flex"
      onClick={() => {
        window.dispatchEvent(new CustomEvent(toggleCommandPaletteEvent))
      }}
      title="Command palette"
      aria-label="Command palette"
    >
      <Command className="h-4 w-4"/>
      <Kbd className="hidden sm:inline-flex">{getModKey()}K</Kbd>
    </button>
  )
}
