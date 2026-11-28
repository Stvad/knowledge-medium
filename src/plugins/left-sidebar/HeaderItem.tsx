import { PanelLeftOpen } from 'lucide-react'
import { ActionContextTypes } from '@/shortcuts/types.js'
import { useActionKeyHint, shortcutTitle } from '@/shortcuts/actionKeyHints.js'
import { OPEN_LEFT_SIDEBAR_ACTION_ID } from './actions.ts'
import { leftSidebarToggle } from './toggleStore.ts'

export function LeftSidebarHeaderItem() {
  const hint = useActionKeyHint(ActionContextTypes.GLOBAL, OPEN_LEFT_SIDEBAR_ACTION_ID)
  return (
    <button
      type="button"
      className="hidden h-8 items-center justify-center rounded-md px-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground md:inline-flex"
      onClick={() => leftSidebarToggle.toggle()}
      title={shortcutTitle('Sidebar', hint)}
      aria-label="Open sidebar"
    >
      <PanelLeftOpen className="h-5 w-5"/>
    </button>
  )
}
