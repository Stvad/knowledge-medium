import type { ReactNode } from 'react'

export const BacklinksEmptyState = ({controls}: { controls?: ReactNode }) => (
  <>
    {controls}
    <div className="mt-4 pt-3 border-t border-border text-xs text-muted-foreground">
      No backlinks.
    </div>
  </>
)
