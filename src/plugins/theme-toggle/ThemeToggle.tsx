"use client"

import * as React from "react"
import { Moon, Sun } from "lucide-react"

import { Button } from "@/components/ui/button"
import { applyTheme, getCurrentTheme, toggleTheme, type ThemeDefinition } from './theme.ts'

export function ThemeToggle() {
  const [theme, setTheme] = React.useState<ThemeDefinition>(() =>
    typeof window === 'undefined' ? { id: 'light', label: 'Light', mode: 'light' } : getCurrentTheme()
  )

  React.useEffect(() => {
    applyTheme(theme)
  }, [theme])

  return (
    <Button
      variant="outline"
      size="icon"
      onClick={() => setTheme(toggleTheme())}
      title={`Theme: ${theme.label}`}
    >
      <Sun className="h-[1.2rem] w-[1.2rem] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
      <Moon className="absolute h-[1.2rem] w-[1.2rem] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
      <span className="sr-only">Toggle theme</span>
    </Button>
  )
}
