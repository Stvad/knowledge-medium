import { Search } from 'lucide-react'
import { Kbd } from '@/components/ui/kbd'
import { toggleQuickFindEvent } from './events.ts'

const getModKey = () =>
  navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl+'

export function QuickFindHeaderItem() {
  return (
    <button
      className="inline-flex h-7 w-7 items-center justify-center gap-1 rounded-md p-0 text-sm text-muted-foreground transition-colors hover:text-foreground sm:h-8 sm:w-auto sm:px-1.5"
      onClick={() => {
        window.dispatchEvent(new CustomEvent(toggleQuickFindEvent))
      }}
      title="Find or create page or block"
      aria-label="Find or create page or block"
    >
      <Search className="h-4 w-4"/>
      <Kbd className="hidden sm:inline-flex">{getModKey()}P</Kbd>
    </button>
  )
}
