import * as React from 'react'
import { cn } from '@/lib/utils'

const Kbd = ({className, children, ...props}: React.HTMLAttributes<HTMLElement>) => {
  return (
    <kbd
      className={cn(
        'pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100',
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  )
}

export { Kbd }
