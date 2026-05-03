import { Search } from 'lucide-react'
import { Kbd } from '@/components/ui/kbd'
import { toggleQuickFindEvent } from './events.ts'

const getModKey = () =>
  navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl+'

export function QuickFindHeaderItem() {
  return (
    <button
      className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      onClick={() => {
        window.dispatchEvent(new CustomEvent(toggleQuickFindEvent))
      }}
      title="Find or create page or block"
    >
      <Search className="h-4 w-4"/>
      <Kbd>{getModKey()}P</Kbd>
    </button>
  )
}
