import { Search } from 'lucide-react'
import { Kbd } from '@/components/ui/kbd'
import { ActionContextTypes } from '@/shortcuts/types.js'
import { useActionKeyHints, shortcutTitle } from '@/shortcuts/actionKeyHints.js'
import { QUICK_FIND_ACTION_ID, quickFindToggle } from './toggleStore.ts'

export function QuickFindHeaderItem() {
  const hint = useActionKeyHints(ActionContextTypes.GLOBAL).get(QUICK_FIND_ACTION_ID)
  return (
    <button
      className="hidden h-7 w-7 items-center justify-center gap-1 rounded-md p-0 text-sm text-muted-foreground transition-colors hover:text-foreground sm:h-8 sm:w-auto sm:px-1.5 md:inline-flex"
      onClick={() => quickFindToggle.toggle()}
      title={shortcutTitle('Find or create page or block', hint)}
      aria-label="Find or create page or block"
    >
      <Search className="h-4 w-4"/>
      {hint && <Kbd className="hidden sm:inline-flex">{hint}</Kbd>}
    </button>
  )
}
