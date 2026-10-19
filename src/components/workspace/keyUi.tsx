/**
 * The pieces every workspace-key screen shares — the gate, the conversion
 * flow, creating an encrypted workspace — so they read as one surface.
 */

import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { PastedKeyProblem } from '@/sync/keys/flows/pastedKey'

export function GateCard({title, wide = false, children}: {title: string; wide?: boolean; children: ReactNode}) {
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className={cn('w-full space-y-5 rounded-lg border bg-background p-6 shadow-sm', wide ? 'max-w-lg' : 'max-w-md')}>
        <h1 className="text-lg font-semibold">{title}</h1>
        {children}
      </div>
    </div>
  )
}

export const Explanation = ({children}: {children: ReactNode}) => (
  <p className="text-sm text-muted-foreground">{children}</p>
)

export const PASTED_KEY_PROBLEM: Record<PastedKeyProblem, string> = {
  format: "That doesn't look like a workspace key (expected kmp-wk-1:…).",
  'invalid-key': "That key doesn't decrypt this workspace's data.",
}

/** A field for pasting a `kmp-wk-1:` key. Enter submits a non-blank value. */
export function WorkspaceKeyField({
  id,
  value,
  onChange,
  onSubmit,
  disabled = false,
  error,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  disabled?: boolean
  error?: string | null
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Workspace key</Label>
      <Input
        id={id}
        autoFocus
        autoComplete="off"
        placeholder="kmp-wk-1:…"
        value={value}
        disabled={disabled}
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && value.trim()) onSubmit() }}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}

/** A newly minted key, with a copy button. */
export function WorkspaceKeyDisplay({workspaceKey}: {workspaceKey: string}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(workspaceKey)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      console.error('Clipboard write failed', err)
    }
  }
  return (
    <div className="min-w-0 space-y-2 rounded-md border bg-muted/40 p-3">
      <div className="flex min-w-0 items-center gap-2">
        <code className="min-w-0 flex-1 break-all font-mono text-xs" data-testid="workspace-key">{workspaceKey}</code>
        <Button type="button" variant="secondary" size="sm" className="shrink-0" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  )
}
