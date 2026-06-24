import { PanelLeftOpen } from 'lucide-react'
import { leftSidebarToggle } from './toggleStore.ts'

export function LeftSidebarHeaderItem() {
  return (
    <button
      type="button"
      className="hidden h-8 items-center justify-center rounded-md px-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground md:inline-flex"
      onClick={() => leftSidebarToggle.toggle()}
      title="Sidebar"
      aria-label="Open sidebar"
    >
      <PanelLeftOpen className="h-5 w-5"/>
    </button>
  )
}
