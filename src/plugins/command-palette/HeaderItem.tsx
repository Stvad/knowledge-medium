import { Command } from 'lucide-react'
import { Kbd } from '@/components/ui/kbd'
import { toggleCommandPaletteEvent } from './events.ts'

const getModKey = () =>
  navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl+'

export function CommandPaletteHeaderItem() {
  return (
    <button
      className="inline-flex h-8 items-center justify-center gap-1 rounded-md px-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
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
