import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useRepo } from '@/context/repo.tsx'
import {
  agentTokenStore,
  notifyAgentTokensChanged,
} from './tokens.ts'
import type { AgentToken } from './tokens.ts'

export const openAgentTokensDialogEvent = 'agent-runtime-bridge:open-tokens-dialog'

interface AgentTokensDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AgentTokensDialog({open, onOpenChange}: AgentTokensDialogProps) {
  const repo = useRepo()
  const userId = repo.user.id
  const workspaceId = repo.activeWorkspaceId
  const noWorkspace = !userId || !workspaceId

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Agent runtime tokens</DialogTitle>
          <DialogDescription>
            Tokens authorize a local agent process to drive this workspace as you.
            Stored on this device only — not synced. Each token is shown once at mint.
          </DialogDescription>
        </DialogHeader>

        {noWorkspace ? (
          <p className="text-sm text-destructive">
            Open a workspace before minting agent tokens.
          </p>
        ) : (
          // Body is a separate component so its useState initializers
          // run fresh each time the dialog opens (Radix unmounts the
          // content on close). That avoids a setState-in-effect pattern
          // for "reset transient form state when the dialog opens".
          <AgentTokensDialogBody userId={userId} workspaceId={workspaceId}/>
        )}
      </DialogContent>
    </Dialog>
  )
}

function AgentTokensDialogBody({userId, workspaceId}: {userId: string, workspaceId: string}) {
  const [tokens, setTokens] = useState<AgentToken[]>(
    () => agentTokenStore.list(userId, workspaceId),
  )
  const [label, setLabel] = useState('')
  const [justMinted, setJustMinted] = useState<AgentToken | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle')

  const refresh = () => setTokens(agentTokenStore.list(userId, workspaceId))

  const mint = () => {
    const token = agentTokenStore.create(userId, workspaceId, label)
    notifyAgentTokensChanged()
    setJustMinted(token)
    setCopyState('idle')
    setLabel('')
    refresh()
  }

  const revoke = (token: string) => {
    agentTokenStore.revoke(userId, workspaceId, token)
    notifyAgentTokensChanged()
    if (justMinted?.token === token) setJustMinted(null)
    refresh()
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopyState('copied')
      window.setTimeout(() => setCopyState('idle'), 1500)
    } catch (error) {
      console.error('Clipboard write failed', error)
    }
  }

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="agent-token-label">New token label</Label>
        <div className="flex min-w-0 gap-2">
          <Input
            id="agent-token-label"
            className="min-w-0 flex-1"
            placeholder="e.g. claude-cli"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') mint() }}
          />
          <Button type="button" className="shrink-0" onClick={mint}>
            Generate
          </Button>
        </div>
      </div>

      {justMinted && (
        <div className="min-w-0 rounded-md border bg-muted/40 p-3 space-y-2">
          <p className="text-xs font-medium text-muted-foreground">
            Copy now — this is the only time the secret is shown.
          </p>
          <div className="flex min-w-0 items-center gap-2">
            <code className="min-w-0 flex-1 truncate text-xs font-mono">{justMinted.token}</code>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="shrink-0"
              onClick={() => copy(justMinted.token)}
            >
              {copyState === 'copied' ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="min-w-0 text-xs text-muted-foreground">
            Run{' '}
            <code className="break-all whitespace-normal">
              yarn agent connect {justMinted.token}
            </code>{' '}
            to register it with the CLI.
          </p>
        </div>
      )}

      <div className="space-y-2">
        <Label>Existing tokens</Label>
        {tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tokens yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {tokens.map((t) => (
              <li
                key={t.token}
                className="flex items-center justify-between rounded border p-2 text-sm"
              >
                <div className="min-w-0">
                  <div className="font-medium truncate">{t.label}</div>
                  <div className="text-xs text-muted-foreground">
                    created {new Date(t.createdAt).toLocaleString()}
                    {t.lastSeenAt
                      ? ` · last seen ${new Date(t.lastSeenAt).toLocaleString()}`
                      : ''}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => revoke(t.token)}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}

export function AgentTokensDialogMount() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const handler = () => setOpen(true)
    window.addEventListener(openAgentTokensDialogEvent, handler)
    return () => window.removeEventListener(openAgentTokensDialogEvent, handler)
  }, [])

  return <AgentTokensDialog open={open} onOpenChange={setOpen}/>
}
