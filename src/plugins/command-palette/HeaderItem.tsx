import { Kbd } from '@/components/ui/kbd'
import { toggleCommandPaletteEvent } from './events.ts'

const getModKey = () =>
  navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl+'

export function CommandPaletteHeaderItem() {
  return (
    <button
      className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      onClick={() => {
        window.dispatchEvent(new CustomEvent(toggleCommandPaletteEvent))
      }}
    >
      <span>Command</span>
      <Kbd>{getModKey()}K</Kbd>
    </button>
  )
}
