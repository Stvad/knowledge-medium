import { ThemeToggle } from './ui/theme-toggle'
import { useUser } from '@/components/Login'


export function Header() {
  const user = useUser()

  return (
    <div className="flex justify-end py-2 ">
      <div className="flex items-center gap-4">
        <button
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => {
            window.dispatchEvent(new CustomEvent('toggle-command-palette'))
          }}
        >
          <span>Command</span>
          <kbd
            className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
            {navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl+'}K
          </kbd>
        </button>
        <ThemeToggle/>
        {user && <span className="text-sm text-muted-foreground">{user.name}</span>}
      </div>
    </div>
  )
}
