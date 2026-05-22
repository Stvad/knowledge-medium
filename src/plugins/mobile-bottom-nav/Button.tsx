import type { ActionIcon } from '@/shortcuts/types.js'

export type MobileBottomNavIcon = ActionIcon

export function MobileBottomNavButton({
  label,
  icon: Icon,
  onClick,
  disabled = false,
}: {
  label: string
  icon: MobileBottomNavIcon
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className="flex h-14 flex-1 items-center justify-center rounded-md text-muted-foreground transition-colors active:bg-accent active:text-foreground disabled:pointer-events-none disabled:opacity-35"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
    >
      <Icon className="h-7 w-7 stroke-[1.6]"/>
    </button>
  )
}
